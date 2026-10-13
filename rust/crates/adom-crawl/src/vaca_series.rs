//! Locação e evidências da Vaca (decodeEvidence, seasonFromCardSlug, declaredSeriesLocation, groupSeriesReleases, packSignature).
//!
//! Migração fiel de:
//! - `src/providers/crawl-sites/vaca-series-locate.ts`
//! - `src/providers/crawl-sites/vaca-series.ts` (regras puras de packSignature e re-exports)

use std::sync::OnceLock;

use adom_core::{
    decode_entities, live_action_year_contradicts, parse_title_season_episode,
    release_work_targets, ParsedSeasonEpisode, WorkTarget,
};

use crate::shared::decode_uri_component;

/// Locação de série: temporada e episódio opcionais.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct SeriesLocation {
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// Evidência disponível na onda em que a request de um botão nasce.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LinkEvidence {
    /// Slug `temporada-N`/ordinal do card (`season_from_card_slug`).
    pub card_season: Option<i64>,
    /// Texto da âncora do card ("Temporada 5", "Stranger Things 4", "East Blue1").
    pub card_title: String,
    pub is_batch: bool,
    /// Título real do batch ("BATCH – Reacher S01").
    pub real_title: Option<String>,
    /// Nome REAL do torrent (`magnet_display_name`), ou None.
    pub dn: Option<String>,
    /// Episódio da máquina de episódios (marcador `ss-ep-num`).
    pub link_episode: Option<i64>,
}

/// Representação padrão de release crua para o raspador.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct CrawlRelease {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "Title")]
    pub title_pascal: Option<String>,
    #[serde(default)]
    pub magnet: Option<String>,
    #[serde(default, rename = "MagnetUri")]
    pub magnet_uri: Option<String>,
    #[serde(default, rename = "Guid")]
    pub guid: Option<String>,
    #[serde(default, rename = "infoHash")]
    pub info_hash: Option<String>,
    #[serde(default)]
    pub indexer: Option<String>,
    #[serde(default)]
    pub tracker: Option<String>,
    #[serde(default, rename = "isBr")]
    pub is_br: Option<bool>,
    #[serde(default)]
    pub seeders: Option<i64>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
}

/// Trait para itens de release usados no agrupamento.
pub trait CrawlReleaseItem: Clone {
    fn title(&self) -> &str;
    fn magnet_display_name(&self) -> String;
}

impl CrawlReleaseItem for CrawlRelease {
    fn title(&self) -> &str {
        self.title
            .as_deref()
            .or(self.title_pascal.as_deref())
            .unwrap_or("")
    }

    fn magnet_display_name(&self) -> String {
        adom_core::magnet_display_name(
            self.magnet.as_deref(),
            self.magnet_uri.as_deref(),
            self.guid.as_deref(),
        )
    }
}

impl<T: CrawlReleaseItem> CrawlReleaseItem for &T {
    fn title(&self) -> &str {
        (*self).title()
    }

    fn magnet_display_name(&self) -> String {
        (*self).magnet_display_name()
    }
}

/// Entrada de release com a locação pedida pelo card que a produziu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesReleaseEntry<T = CrawlRelease> {
    pub release: T,
    pub request: SeriesLocation,
}

/// Opções para agrupamento de releases de série.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GroupSeriesOptions<'a> {
    pub year: Option<&'a str>,
    pub by_declared_location: bool,
}

/// Grupo de releases por locação declarada.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CrawlReleaseGroup<T = CrawlRelease> {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub releases: Vec<T>,
}

/// Repara entidades DESTRUÍDAS antes da decodificação.
///
/// O site/slug solta a entidade sem o "&" ("4ordf" = "4ª") ou mantém só o "#" ("4#170;").
pub fn repair_mangled_entities(value: &str) -> String {
    static RE_ORDF: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static RE_ORDM: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static RE_HASH_A: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static RE_HASH_O: OnceLock<fancy_regex::Regex> = OnceLock::new();

    let re_ordf = RE_ORDF.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordf(?![a-z0-9])").unwrap()
    });
    let re_ordm = RE_ORDM.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordm(?![a-z0-9])").unwrap()
    });
    let re_hash_a = RE_HASH_A.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*#(?:170|xaa|x00aa)(?![a-z0-9])")
            .unwrap()
    });
    let re_hash_o = RE_HASH_O.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*#(?:186|xba|x00ba)(?![a-z0-9])")
            .unwrap()
    });

    let s1 = re_ordf.replace_all(value, "${1}ª");
    let s2 = re_ordm.replace_all(&s1, "${1}º");
    let s3 = re_hash_a.replace_all(&s2, "${1}ª");
    let s4 = re_hash_o.replace_all(&s3, "${1}º");
    s4.into_owned()
}

/// Decodifica entidades HTML da evidência antes de inferir temporada/agrupar.
///
/// Duas passadas: a primeira repara entidades sem ";" e entidades destruídas.
/// Depois `decode_entities` roda duas vezes para resolver dupla codificação ("&amp;#170;").
pub fn decode_evidence(text: &str) -> String {
    static RE_UNCLOSED: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_unclosed = RE_UNCLOSED.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)&(#[0-9]+|#x[0-9a-f]+|[a-z]{2,8})(?![a-z0-9;])").unwrap()
    });

    let mangled = repair_mangled_entities(text);
    let repaired = re_unclosed.replace_all(&mangled, "&${1};");
    let first = decode_entities(&repaired);
    decode_entities(&first)
}

/// Temporada declarada no slug do card (`seasonFromCardSlug`).
pub fn season_from_card_slug(value: &str) -> Option<i64> {
    let parsed_url = if let Ok(u) = url::Url::parse(value) {
        u
    } else if let Ok(u) =
        url::Url::parse(&format!("http://localhost/{}", value.trim_start_matches('/')))
    {
        u
    } else {
        return None;
    };

    let decoded_path = decode_uri_component(parsed_url.path())?;
    let path = decode_evidence(&decoded_path).to_lowercase();

    static RE_SEGMENT: OnceLock<regex::Regex> = OnceLock::new();
    let re_segment =
        RE_SEGMENT.get_or_init(|| regex::Regex::new(r"/season/([^/]+)/?$").unwrap());
    let segment = re_segment
        .captures(&path)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())?;

    static RE_STRAIGHT: OnceLock<regex::Regex> = OnceLock::new();
    let re_straight =
        RE_STRAIGHT.get_or_init(|| regex::Regex::new(r"^temporada-(\d{1,2})$").unwrap());
    if let Some(caps) = re_straight.captures(segment) {
        if let Ok(n) = caps[1].parse::<i64>() {
            return season_or_null(n);
        }
    }

    static RE_ORDINAL: OnceLock<regex::Regex> = OnceLock::new();
    let re_ordinal = RE_ORDINAL.get_or_init(|| {
        regex::Regex::new(r"^(\d{1,2})[-_]*(?:[ªº°]|[ao])?[-_]*temporada$").unwrap()
    });
    if let Some(caps) = re_ordinal.captures(segment) {
        if let Ok(n) = caps[1].parse::<i64>() {
            return season_or_null(n);
        }
    }

    None
}

fn season_or_null(n: i64) -> Option<i64> {
    if (1..=99).contains(&n) {
        Some(n)
    } else {
        None
    }
}

/// Locação que um parse declara, ou `None` quando é silencioso.
fn location_of_parse(p: &ParsedSeasonEpisode) -> Option<SeriesLocation> {
    if p.complete || p.seasons.len() > 1 {
        return Some(SeriesLocation {
            season: None,
            episode: None,
        });
    }
    if p.seasons.len() == 1 {
        let episode = if p.episodes.len() == 1 {
            Some(p.episodes[0])
        } else {
            None
        };
        return Some(SeriesLocation {
            season: Some(p.seasons[0]),
            episode,
        });
    }
    None
}

/// O parse declara raiz (complete ou mais de uma temporada)?
fn parse_declares_root(p: &ParsedSeasonEpisode) -> bool {
    p.complete || p.seasons.len() > 1
}

/// Última "palavra" numérica de 1-2 dígitos do título ("East Blue1" → 1).
pub fn trailing_season_of(title: &str) -> Option<i64> {
    let text = title.trim();
    if text.is_empty() {
        return None;
    }
    static RE_YEAR: OnceLock<regex::Regex> = OnceLock::new();
    let re_year = RE_YEAR.get_or_init(|| regex::Regex::new(r"\d{3,}\s*$").unwrap());
    if re_year.is_match(text) {
        return None;
    }
    static RE_TRAILING: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_trailing =
        RE_TRAILING.get_or_init(|| fancy_regex::Regex::new(r"(?<!\d)(\d{1,2})\s*$").unwrap());
    let caps = re_trailing.captures(text).ok()??;
    let n = caps.get(1)?.as_str().parse::<i64>().ok()?;
    season_or_null(n)
}

/// Onde o botão nasce (regras 1 a 5 de precedência).
pub fn declared_series_location(e: &LinkEvidence) -> SeriesLocation {
    // Regra 1 — dn é conteúdo: o nome REAL do torrent vence qualquer página.
    let dn = decode_evidence(e.dn.as_deref().unwrap_or(""));
    if !dn.trim().is_empty() {
        let from_dn = location_of_parse(&parse_title_season_episode(&dn));
        if let Some(loc) = from_dn {
            return loc;
        }
    }

    // Episódio da página: só vale em card POR-EPISÓDIO (batch não tem episódio).
    let page_episode = if e.is_batch { None } else { e.link_episode };

    // Regra 2 — o rótulo do próprio card/batch declara.
    let candidates = [e.real_title.as_deref(), Some(e.card_title.as_str())];
    for candidate in candidates {
        let Some(candidate) = candidate else { continue };
        let text = decode_evidence(candidate);
        if text.trim().is_empty() {
            continue;
        }
        let p = parse_title_season_episode(&text);
        if parse_declares_root(&p) {
            return SeriesLocation {
                season: None,
                episode: None,
            };
        }
        if p.seasons.len() == 1 {
            return SeriesLocation {
                season: Some(p.seasons[0]),
                episode: page_episode,
            };
        }
    }

    // Regra 3 — slug do card: evidência da página, só quando rótulo é silencioso.
    if let Some(card_season) = e.card_season {
        return SeriesLocation {
            season: Some(card_season),
            episode: page_episode,
        };
    }

    // Regra 4 — última defesa sem dn: dígito final do card ("East Blue1").
    let trailing = trailing_season_of(&decode_evidence(&e.card_title));
    if let Some(trailing) = trailing {
        return SeriesLocation {
            season: Some(trailing),
            episode: page_episode,
        };
    }

    // Regra 5 — nada declara: raiz conservadora.
    SeriesLocation {
        season: None,
        episode: None,
    }
}

/// Agrupa releases por locação declarada (título × dn).
pub fn group_series_releases<T: CrawlReleaseItem + Clone>(
    entries: &[SeriesReleaseEntry<T>],
    opts: &GroupSeriesOptions,
) -> Vec<CrawlReleaseGroup<T>> {
    let mut groups: Vec<CrawlReleaseGroup<T>> = Vec::new();
    let year_str = opts.year.unwrap_or("");

    for entry in entries {
        let title = decode_evidence(entry.release.title());
        let dn_raw = entry.release.magnet_display_name();
        let dn_decoded = decode_evidence(&dn_raw);
        let dn = if dn_decoded.is_empty() {
            None
        } else {
            Some(dn_decoded.as_str())
        };

        let check_text = format!("{} {}", title, dn.unwrap_or(""));
        if live_action_year_contradicts(&check_text, year_str) {
            continue;
        }

        let targets: Vec<WorkTarget> = if opts.by_declared_location {
            vec![WorkTarget {
                season: entry.request.season,
                episode: entry.request.episode,
            }]
        } else {
            release_work_targets(
                &title,
                WorkTarget {
                    season: entry.request.season,
                    episode: entry.request.episode,
                },
                dn,
                "",
            )
        };

        for target in targets {
            if let Some(group) = groups
                .iter_mut()
                .find(|g| g.season == target.season && g.episode == target.episode)
            {
                group.releases.push(entry.release.clone());
            } else {
                groups.push(CrawlReleaseGroup {
                    season: target.season,
                    episode: target.episode,
                    releases: vec![entry.release.clone()],
                });
            }
        }
    }

    // Ordem determinística: episódio > temporada > raiz
    groups.sort_by(|a, b| match (a.season.is_none(), b.season.is_none()) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => {
            let s_a = a.season.unwrap_or(0);
            let s_b = b.season.unwrap_or(0);
            if s_a != s_b {
                s_a.cmp(&s_b)
            } else {
                let e_a = a.episode.unwrap_or(-1);
                let e_b = b.episode.unwrap_or(-1);
                e_a.cmp(&e_b)
            }
        }
    });

    groups
}

/// Dados de link para assinatura de pack.
#[derive(Debug, Clone, Default)]
pub struct PackSignatureInput<'a> {
    pub quality: Option<&'a str>,
    pub audio: Option<&'a str>,
    pub size: Option<&'a str>,
    pub episode: Option<i64>,
}

/// Assinatura de botão de PACK (sem episódio) com tamanho real.
pub fn pack_signature(link: &PackSignatureInput) -> Option<String> {
    if link.episode.is_some() {
        return None;
    }
    let raw_size = link.size.unwrap_or("");
    let mut size = String::with_capacity(raw_size.len());
    for c in raw_size.chars() {
        if !c.is_whitespace() {
            if c == ',' {
                size.push('.');
            } else {
                size.extend(c.to_lowercase());
            }
        }
    }
    if !size.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    if is_one_kb_sentinel(&size) {
        return None;
    }
    let q = link.quality.unwrap_or("-");
    let a = link.audio.unwrap_or("-");
    Some(format!("s:{q}|{a}|{size}"))
}

/// Helper para chamada direta de `pack_signature`.
pub fn pack_signature_parts(
    quality: Option<&str>,
    audio: Option<&str>,
    size: Option<&str>,
    episode: Option<i64>,
) -> Option<String> {
    pack_signature(&PackSignatureInput {
        quality,
        audio,
        size,
        episode,
    })
}

fn is_one_kb_sentinel(size: &str) -> bool {
    if !size.ends_with("kb") {
        return false;
    }
    let num_part = &size[..size.len() - 2];
    if num_part == "1" {
        return true;
    }
    if let Some(rest) = num_part.strip_prefix("1.") {
        return !rest.is_empty() && rest.chars().all(|c| c == '0');
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_evidence() {
        assert_eq!(
            decode_evidence("The.Walking.Dead.4&ordf;.Temporada.Completa.1080p"),
            "The.Walking.Dead.4ª.Temporada.Completa.1080p"
        );
        assert_eq!(
            decode_evidence("TWD.4&amp;#170;.Temporada.Completa.1080p"),
            "TWD.4ª.Temporada.Completa.1080p"
        );
        assert_eq!(
            decode_evidence("TWD.4&ordf Temporada.Completa"),
            "TWD.4ª Temporada.Completa"
        );
        assert_eq!(decode_evidence("4ordf"), "4ª");
        assert_eq!(decode_evidence("4#170;"), "4ª;");
    }

    #[test]
    fn test_season_from_card_slug() {
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/4&ordf;-temporada/"),
            Some(4)
        );
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/temporada-4/"),
            Some(4)
        );
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/1a-temporada/"),
            Some(1)
        );
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/2ª-temporada/"),
            Some(2)
        );
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/3o-temporada"),
            Some(3)
        );
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/especial/"),
            None
        );
        assert_eq!(
            season_from_card_slug("https://x/tv/twd/season/temporada-100/"),
            None
        );
    }

    #[test]
    fn test_trailing_season_of() {
        assert_eq!(trailing_season_of("East Blue1"), Some(1));
        assert_eq!(trailing_season_of("Enies Lobby9"), Some(9));
        assert_eq!(trailing_season_of("Show 2020"), None);
        assert_eq!(trailing_season_of("Show 0"), None);
        assert_eq!(trailing_season_of("Especial"), None);
        assert_eq!(trailing_season_of("Season 12 "), Some(12));
    }

    #[test]
    fn test_declared_series_location_rules() {
        let base = LinkEvidence {
            card_season: None,
            card_title: String::new(),
            is_batch: false,
            real_title: None,
            dn: None,
            link_episode: None,
        };

        // Regra 1: dn vence
        assert_eq!(
            declared_series_location(&LinkEvidence {
                dn: Some("Stranger.Things.1TemporadaCompleta.1080p".into()),
                link_episode: Some(1),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(1),
                episode: None
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                dn: Some("Stranger.Things.S05E08.EPISODIO.FINAL".into()),
                link_episode: Some(3),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(5),
                episode: Some(8)
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                dn: Some("Stranger.Things.4Temporada2022VOLUME.1".into()),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(4),
                episode: None
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                dn: Some("Stranger.Things.Todas.as.Temporadas".into()),
                ..base.clone()
            }),
            SeriesLocation {
                season: None,
                episode: None
            }
        );

        // Regra 2: título do card / batch
        assert_eq!(
            declared_series_location(&LinkEvidence {
                is_batch: true,
                real_title: Some("BATCH – Reacher S01".into()),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(1),
                episode: None
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                card_title: "Stranger Things 4".into(),
                link_episode: Some(2),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(4),
                episode: Some(2)
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                real_title: Some("BATCH – Série Completa".into()),
                ..base.clone()
            }),
            SeriesLocation {
                season: None,
                episode: None
            }
        );

        // Regra 3: card_season
        assert_eq!(
            declared_series_location(&LinkEvidence {
                card_season: Some(5),
                link_episode: Some(3),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(5),
                episode: Some(3)
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                card_season: Some(2),
                is_batch: true,
                link_episode: Some(1),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(2),
                episode: None
            }
        );

        // Regra 4: dígito final do card
        assert_eq!(
            declared_series_location(&LinkEvidence {
                card_title: "East Blue1".into(),
                ..base.clone()
            }),
            SeriesLocation {
                season: Some(1),
                episode: None
            }
        );
        assert_eq!(
            declared_series_location(&LinkEvidence {
                card_title: "Show 2020".into(),
                ..base.clone()
            }),
            SeriesLocation {
                season: None,
                episode: None
            }
        );

        // Regra 5: raiz conservadora
        assert_eq!(
            declared_series_location(&LinkEvidence {
                card_title: "Especial".into(),
                ..base.clone()
            }),
            SeriesLocation {
                season: None,
                episode: None
            }
        );
    }

    #[test]
    fn test_group_series_releases_twd() {
        let release = CrawlRelease {
            title: Some("The Walking Dead 4&#170; Temporada Completa DUAL 1080p".into()),
            magnet: Some(
                "magnet:?xt=urn:btih:abababababababababababababababababababab&dn=The.Walking.Dead.4%26ordf%3B.Temporada.Completa.1080p".into(),
            ),
            indexer: Some("vacatorrent".into()),
            tracker: Some("Vaca Torrent".into()),
            is_br: Some(true),
            seeders: Some(1),
            ..Default::default()
        };

        let groups = group_series_releases(
            &[SeriesReleaseEntry {
                release: release.clone(),
                request: SeriesLocation {
                    season: Some(4),
                    episode: None,
                },
            }],
            &GroupSeriesOptions::default(),
        );

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].season, Some(4));
        assert_eq!(groups[0].episode, None);
        assert_eq!(groups[0].releases.len(), 1);
    }

    #[test]
    fn test_pack_signature() {
        assert_eq!(
            pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1.5 GB"), None).as_deref(),
            Some("s:1080p|DUAL|1.5gb")
        );
        assert_eq!(
            pack_signature_parts(None, None, Some("700,5 MB"), None).as_deref(),
            Some("s:-|-|700.5mb")
        );
        // Episode presente -> None
        assert_eq!(
            pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1.5 GB"), Some(1)),
            None
        );
        // Sentinela 1 KB -> None
        assert_eq!(
            pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1 KB"), None),
            None
        );
        assert_eq!(
            pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1.00 kb"), None),
            None
        );
    }

    #[test]
    fn test_repair_mangled_entities() {
        assert_eq!(repair_mangled_entities("4ordf"), "4ª");
        assert_eq!(repair_mangled_entities("1ordm"), "1º");
        assert_eq!(repair_mangled_entities("2 ordm"), "2º");
        assert_eq!(repair_mangled_entities("4#170"), "4ª");
        assert_eq!(repair_mangled_entities("4#xaa"), "4ª");
        assert_eq!(repair_mangled_entities("4#x00aa"), "4ª");
        assert_eq!(repair_mangled_entities("2#186"), "2º");
        assert_eq!(repair_mangled_entities("2#xba"), "2º");
        // Não altera quando há letra antes ou letra depois
        assert_eq!(repair_mangled_entities("Accordf"), "Accordf");
        assert_eq!(repair_mangled_entities("4ordfx"), "4ordfx");
    }

    #[test]
    fn test_live_action_filtering() {
        let release = CrawlRelease {
            title: Some("One Piece Live Action 2023 S01 1080p".into()),
            magnet: Some("magnet:?xt=urn:btih:abababababababababababababababababababab".into()),
            ..Default::default()
        };

        // Sob o anime de 1999, o live action de 2023 é excluído!
        let groups = group_series_releases(
            &[SeriesReleaseEntry {
                release,
                request: SeriesLocation {
                    season: Some(1),
                    episode: None,
                },
            }],
            &GroupSeriesOptions {
                year: Some("1999"),
                by_declared_location: false,
            },
        );
        assert_eq!(groups.len(), 0);
    }

    #[test]
    fn test_group_sorting_order() {
        let r_root = CrawlRelease {
            title: Some("Show Series Completa".into()),
            ..Default::default()
        };
        let r_s2 = CrawlRelease {
            title: Some("Show S02".into()),
            ..Default::default()
        };
        let r_s1 = CrawlRelease {
            title: Some("Show S01".into()),
            ..Default::default()
        };
        let r_s1e1 = CrawlRelease {
            title: Some("Show S01E01".into()),
            ..Default::default()
        };

        let entries = vec![
            SeriesReleaseEntry {
                release: r_root,
                request: SeriesLocation {
                    season: None,
                    episode: None,
                },
            },
            SeriesReleaseEntry {
                release: r_s2,
                request: SeriesLocation {
                    season: Some(2),
                    episode: None,
                },
            },
            SeriesReleaseEntry {
                release: r_s1e1,
                request: SeriesLocation {
                    season: Some(1),
                    episode: Some(1),
                },
            },
            SeriesReleaseEntry {
                release: r_s1,
                request: SeriesLocation {
                    season: Some(1),
                    episode: None,
                },
            },
        ];

        let groups = group_series_releases(
            &entries,
            &GroupSeriesOptions {
                year: None,
                by_declared_location: true,
            },
        );

        let keys: Vec<(Option<i64>, Option<i64>)> =
            groups.iter().map(|g| (g.season, g.episode)).collect();

        // Esperado: S1 (None), S1 (E1), S2 (None), Root (None, None)
        assert_eq!(
            keys,
            vec![
                (Some(1), None),
                (Some(1), Some(1)),
                (Some(2), None),
                (None, None)
            ]
        );
    }
}
