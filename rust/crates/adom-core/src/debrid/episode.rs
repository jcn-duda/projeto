//! Escolha de episódio. O nome do arquivo é medido antes do caminho: a pasta
//! costuma carregar o SxxEyy e, se valesse primeiro, todo arquivo do pack
//! casaria — inclusive a propaganda e o capítulo errado da faixa.

use fancy_regex::Regex;

use super::text::{
    base_name, clean_audio, compile, declared_episodes_in, is_extra, is_extras_disc, is_site_ad,
    is_uploader_or_promo, js_size, js_slice, matched_i, parsed_base, WB_AFTER, WB_BEFORE,
};
use super::{
    outcome_episode, outcome_file, DebridFile, EpisodeContext, EpisodeEvidence, PickOutcome,
};

const VIGNETTE_MAX: f64 = 15.0 * 1024.0 * 1024.0;

struct Pats {
    has_season: Regex,
    strong: Vec<Regex>,
    weak: Vec<Regex>,
    bare: Regex,
}

fn pad2(n: i64) -> String {
    let text = n.to_string();
    if text.chars().count() >= 2 {
        text
    } else {
        format!("0{text}")
    }
}

fn season_forms(season: i64) -> String {
    format!("(?:{}|{})", pad2(season), season)
}

fn any_season_re() -> &'static Regex {
    use std::sync::OnceLock;
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        let pat = format!(
            r"(?:{wb}[ST][0-9]{{1,2}}(?![0-9])|{wb}SEASON[__SP__._-]*[0-9]|{wb}[0-9]{{1,2}}X[0-9]{{1,2}}{wa}|{wb}(?:TEMP|TEMPORADA)[__SP__._-]*[0-9]|{wb}[0-9]{{1,2}}ª?[__SP__._-]*(?:TEMP|TEMPORADA){wa})",
            wb = WB_BEFORE,
            wa = WB_AFTER,
        );
        compile(&pat)
    })
}

fn pats_for(season: i64, episode: i64) -> Pats {
    let sf = season_forms(season);
    let ef = format!("(?:0{{0,2}}{episode})");
    let joined = format!("{}{}", pad2(season), pad2(episode));
    let has_season = compile(&format!(
        r"(?:{wb}S{sf}(?![0-9])|{wb}T{sf}(?![0-9])|{wb}SEASON[__SP__._-]*{sf}(?![0-9])|{wb}{sf}X|{wb}(?:TEMP|TEMPORADA)[__SP__._-]*{sf}(?![0-9])|{wb}{sf}ª?[__SP__._-]*(?:TEMP|TEMPORADA){wa})",
        wb = WB_BEFORE,
        wa = WB_AFTER,
    ));
    let strong = vec![
        compile(&format!(
            r"{wb}S{sf}[__SP__._-]*E{ef}{wa}",
            wb = WB_BEFORE,
            wa = WB_AFTER
        )),
        compile(&format!(
            r"{wb}T{sf}[__SP__._-]*E{ef}{wa}",
            wb = WB_BEFORE,
            wa = WB_AFTER
        )),
        compile(&format!(
            r"{wb}{sf}X{ef}{wa}",
            wb = WB_BEFORE,
            wa = WB_AFTER
        )),
        compile(&format!(r"{wb}{joined}{wa}", wb = WB_BEFORE, wa = WB_AFTER)),
    ];
    let weak = vec![
        compile(&format!(
            r"{wb}(?:EPIS[OÓ]DIO|CAP[IÍ]TULO|EP|CAP)[__SP__._-]*0{{0,2}}{episode}{wa}",
            wb = WB_BEFORE,
            wa = WB_AFTER,
        )),
        compile(&format!(
            r"{wb}E[__SP__._-]*0{{0,2}}{episode}{wa}",
            wb = WB_BEFORE,
            wa = WB_AFTER,
        )),
    ];
    let bare = compile(&format!(
        r"(?:^|[__SP__._-])0{{0,2}}{episode}(?:[__SP__._-]|$|\.[A-Z0-9]+$)"
    ));
    Pats {
        has_season,
        strong,
        weak,
        bare,
    }
}

fn matches_episode_in(path: &str, pats: &Pats) -> bool {
    if pats.strong.iter().any(|re| matched_i(re, path)) {
        return true;
    }
    if !matched_i(&pats.has_season, path) {
        return false;
    }
    let clean = clean_audio(path);
    pats.weak.iter().any(|re| matched_i(re, &clean)) || matched_i(&pats.bare, &clean)
}

fn contradicts_episode(file: &DebridFile, episode: i64) -> bool {
    let declared = declared_episodes_in(&base_name(&file.path));
    !declared.is_empty() && !declared.contains(&episode)
}

fn episode_context(videos: &[&DebridFile]) -> EpisodeContext {
    let video_count = i64::try_from(videos.len()).unwrap_or(i64::MAX);
    let samples = videos
        .iter()
        .take(3)
        .map(|file| js_slice(&base_name(&file.path), 70))
        .collect();
    EpisodeContext {
        video_count,
        samples,
    }
}

fn is_vignette(file: &DebridFile) -> bool {
    let size = js_size(file.size);
    (size > 0.0 && size < VIGNETTE_MAX)
        || is_uploader_or_promo(&file.path)
        || is_site_ad(&file.path)
}

/// Temporada única e diferente da pedida, depois de tirar extra e vinheta.
fn unanimous_wrong_season(videos: &[&DebridFile], wanted_season: i64) -> Option<(i64, String)> {
    let sem_extra: Vec<&DebridFile> = videos
        .iter()
        .copied()
        .filter(|file| !is_extra(&file.path))
        .collect();
    let pool: &[&DebridFile] = if sem_extra.is_empty() {
        videos
    } else {
        &sem_extra
    };
    let sem_vignette: Vec<&DebridFile> = pool
        .iter()
        .copied()
        .filter(|file| !is_vignette(file))
        .collect();
    let candidates: &[&DebridFile] = if sem_vignette.is_empty() {
        pool
    } else {
        &sem_vignette
    };
    let mut seasons = Vec::new();
    let mut first_sample = String::new();
    for file in candidates {
        let bname = base_name(&file.path);
        let declared = parsed_base(&bname);
        if declared.seasons.is_empty() {
            return None;
        }
        for season in declared.seasons {
            super::text::push_unique(&mut seasons, season);
        }
        if first_sample.is_empty() {
            first_sample = bname;
        }
    }
    if seasons.len() != 1 {
        return None;
    }
    let season = seasons[0];
    if season == wanted_season {
        return None;
    }
    Some((season, first_sample))
}

/// `Some` encerra a escolha. `None` cai no desempate por obra ou no maior vídeo
/// (vídeo único cujo nome não contradiz o pedido).
pub(super) fn pick_episode(
    videos: &[&DebridFile],
    season: i64,
    episode: i64,
) -> Option<PickOutcome> {
    let pats = pats_for(season, episode);
    let by_name: Vec<&DebridFile> = videos
        .iter()
        .copied()
        .filter(|file| {
            matches_episode_in(&base_name(&file.path), &pats) && !contradicts_episode(file, episode)
        })
        .collect();
    let strong: Vec<&DebridFile> = if !by_name.is_empty() {
        by_name
    } else {
        videos
            .iter()
            .copied()
            .filter(|file| {
                matches_episode_in(&file.path, &pats) && !contradicts_episode(file, episode)
            })
            .collect()
    };
    if strong.len() == 1 {
        return Some(outcome_file(strong[0]));
    }
    if strong.len() > 1 {
        let sem_extra: Vec<&DebridFile> = strong
            .iter()
            .copied()
            .filter(|file| !is_extra(&file.path))
            .collect();
        let pool: &[&DebridFile] = if sem_extra.is_empty() {
            &strong
        } else {
            &sem_extra
        };
        return Some(outcome_file(super::largest(pool)));
    }
    let ambiguous = videos.iter().any(|file| {
        matched_i(any_season_re(), &file.path) && !matched_i(&pats.has_season, &file.path)
    });
    if !ambiguous {
        if let Some(weak) = videos.iter().copied().find(|file| {
            !contradicts_episode(file, episode)
                && pats
                    .weak
                    .iter()
                    .any(|re| matched_i(re, &clean_audio(&file.path)))
        }) {
            return Some(outcome_file(weak));
        }
    }
    if videos.len() > 1 {
        let context = episode_context(videos);
        if let Some((wrong, sample)) = unanimous_wrong_season(videos, season) {
            return Some(outcome_episode(
                Some(EpisodeEvidence {
                    wanted_season: season,
                    wanted_episode: episode,
                    declared_seasons: vec![wrong],
                    declared_episodes: Vec::new(),
                    sample: Some(js_slice(&sample, 60)),
                }),
                Some(context),
            ));
        }
        // Disco de bônus: ninguém declara temporada e a maioria tem cara de extra.
        let no_season = videos
            .iter()
            .all(|file| !matched_i(any_season_re(), &file.path));
        let extras_like = videos
            .iter()
            .filter(|file| is_extra(&file.path) || is_extras_disc(&base_name(&file.path)))
            .count();
        if no_season && extras_like.saturating_mul(2) >= videos.len() {
            return Some(outcome_episode(
                Some(EpisodeEvidence {
                    wanted_season: season,
                    wanted_episode: episode,
                    declared_seasons: Vec::new(),
                    declared_episodes: Vec::new(),
                    sample: Some(js_slice(&base_name(&videos[0].path), 60)),
                }),
                Some(context),
            ));
        }
        return Some(outcome_episode(None, Some(context)));
    }
    let declared = parsed_base(&videos[0].path);
    if !declared.complete || !declared.seasons.is_empty() {
        let wrong_episode = !declared.episodes.is_empty() && !declared.episodes.contains(&episode);
        let wrong_season = !declared.seasons.is_empty() && !declared.seasons.contains(&season);
        if wrong_episode || wrong_season {
            return Some(outcome_episode(
                Some(EpisodeEvidence {
                    wanted_season: season,
                    wanted_episode: episode,
                    declared_seasons: declared.seasons,
                    declared_episodes: declared.episodes,
                    sample: Some(js_slice(&base_name(&videos[0].path), 60)),
                }),
                None,
            ));
        }
    }
    None
}
