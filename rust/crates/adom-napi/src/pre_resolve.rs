//! Pré-resolve do protetor de link BR em UM lote no núcleo
//! (`resolveCardigannDownloads`, `src/providers/jackett-resolve.ts`).
//!
//! Antes de pagar o protetor (`/dl`, fetch que fica NO TS), o TS decidia por
//! post, em laço: relevância (`filterRelevantRaw`/`matchesBrTitle`), temporada
//! do título, episódio pedido, dedupe por identidade, score de escolha
//! (`resolveCandidateScore`) e corte pelo teto de resoluções. Tudo isso decide
//! aqui, numa chamada: saem só os índices aprovados (já na ordem final) e o
//! motivo de cada rejeição. O `isSafeDownloadUrl` do link é decidido SÓ no
//! conjunto pós-slice — no TS ele roda dentro do `resolveDownloadMagnet`, depois
//! do corte; adiantá-lo mudaria quem ocupa as vagas e divergiria do oráculo.
//! Bloqueado NÃO sai da lista (no TS o item seguia sem magnet): o motivo só
//! marca quem o TS deve pular sem fetch.
//!
//! A lógica real é a de `adom_core` (relevância, título BR, episódio, URL),
//! com golden contra o TS do `esm`. Duas peças vivem AQUI porque o core ainda
//! não as tem (REPORTADO ao orquestrador):
//! - `resolve_candidate_score`: porte fiel do `resolveCandidateScore` do TS,
//!   sobre os portes existentes (`audio_from_title`, `quality_from_title`,
//!   `source_from_title`, `parse_title_season_episode`); golden futuro contra o esm;
//! - `title_season_marker`: a regex de temporada do título do laço TS
//!   (`\bS(\d{1,2})\b` | `(\d{1,2})\s*[ªº]\s*Temporada`), portada à mão para o
//!   crate não ganhar uma dependência de regex só para isto.

use adom_core::{
    audio_from_title, filter_relevant_raw, is_safe_download_url, matches_br_title_prepared,
    matches_episode, parse_title_season_episode, quality_from_title, source_from_title,
    title_tokens, BrTitleName, RelevanceItem as CoreItem, RelevanceQuery as CoreQuery,
    RelevanceSettings as CoreSettings, UNKNOWN_QUALITY,
};
use napi_derive::napi;

/// Motivos de rejeição, na ordem em que as etapas rodam no laço TS.
/// A string do rótulo fica do lado Node (`PRE_RESOLVE_REJECT_LABELS`).
pub const REJECT_TITLE: u32 = 0;
pub const REJECT_SEASON: u32 = 1;
pub const REJECT_EPISODE: u32 = 2;
pub const REJECT_DUPLICATE: u32 = 3;
pub const REJECT_UNSAFE_URL: u32 = 4;

/// Campos por post que o lote lê. Os quatro primeiros espelham a entrada do
/// filtro de relevância (`None`/vazio = ausente, como o `||` do JS);
/// `link_trusted` é a exceção do download do próprio Jackett, decidida no TS
/// porque depende de `config.jackett.url`.
#[napi(object)]
pub struct PreResolvePost {
    pub title: Option<String>,
    pub title_pascal: Option<String>,
    pub magnet: Option<String>,
    pub magnet_uri: Option<String>,
    pub guid: Option<String>,
    pub is_br: bool,
    pub info_hash: Option<String>,
    pub download_url: Option<String>,
    pub link_trusted: bool,
}

/// Consulta, uma vez por chamada. `names` não vazio liga o caminho do filtro de
/// relevância; senão, o caminho `matchesBrTitle` com `wanted` (a query sem
/// Sxx/ano, extraída no TS). `br_is_series` é o `Boolean(requestedSeason)` do
/// caminho BR — distinto do `is_series` do `matchContext`.
#[napi(object)]
pub struct PreResolveQuery {
    pub names: Vec<String>,
    pub wanted: Option<String>,
    /// Ano de catálogo para o filtro de relevância (pode vir sujo, "2024–").
    pub year: Option<String>,
    /// Ano da QUERY ("Coringa 2019"), só do caminho `matchesBrTitle`.
    pub query_year: Option<String>,
    pub alt_year: Option<String>,
    pub is_series: bool,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub multi_work_root: Option<String>,
    pub home_release_at: Option<i64>,
    pub br_is_series: bool,
    pub requested_season: Option<i64>,
    pub requested_ep_season: Option<i64>,
    pub requested_ep: Option<i64>,
    /// `config.jackett.maxDownloadResolves`.
    pub max_resolves: i64,
    /// `config.jackett.allowPrivateDownloadIps`.
    pub allow_private_urls: bool,
}

/// Config que o TS lê em tempo de chamada (`config.search` + relógio).
#[napi(object)]
pub struct PreResolveSettings {
    pub now_ms: i64,
    pub pre_home_release_cut: bool,
    pub pre_home_release_margin_ms: i64,
    /// Também governa o piso de precisão do caminho `matchesBrTitle`.
    pub title_precision_tail_cut: bool,
}

#[napi(object)]
pub struct PreResolveRejected {
    pub index: u32,
    pub reason: u32,
}

/// Aprovados já na ordem final (score desc, ordem original em empate) e já
/// cortados pelo teto; os cortados PELO TETO não são rejeição — não aparecem
/// em lista nenhuma, como no TS.
#[napi(object)]
pub struct PreResolveOutcome {
    pub approved: Vec<u32>,
    pub rejected: Vec<PreResolveRejected>,
}

fn core_item(p: &PreResolvePost) -> CoreItem {
    CoreItem {
        title: p.title.clone(),
        title_pascal: p.title_pascal.clone(),
        magnet: p.magnet.clone(),
        magnet_uri: p.magnet_uri.clone(),
        guid: p.guid.clone(),
        is_br: p.is_br,
    }
}

/// Texto do título como o TS o usa (`String(item.title || '')`).
fn title_or_empty(p: &PreResolvePost) -> String {
    p.title.clone().unwrap_or_default()
}

fn has_hash_or_magnet(p: &PreResolvePost) -> bool {
    let hash = p.info_hash.as_deref().unwrap_or("");
    let magnet = p.magnet.as_deref().unwrap_or("");
    !hash.is_empty() || magnet.to_ascii_lowercase().starts_with("magnet:?")
}

/// A regex de temporada do laço TS, portada à mão: menor ocorrência de
/// `\bS(\d{1,2})\b` ou `(\d{1,2})\s*[ªº]\s*Temporada` (case-insensitive,
/// bordas de palavra ASCII como no JS).
fn title_season_marker(title: &str) -> Option<i64> {
    let chars: Vec<char> = title.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let parse_at = |slice: &[char]| -> Option<i64> {
        let text: String = slice.iter().collect();
        text.parse().ok()
    };
    let temporada_at = |slice: &[char]| -> bool {
        let rest = slice.iter().collect::<String>().to_ascii_lowercase();
        rest.starts_with("temporada")
    };
    for i in 0..chars.len() {
        // Padrão A: \bS(\d{1,2})\b — com backtracking greedy (2 dígitos, depois 1).
        if (chars[i] == 'S' || chars[i] == 's') && (i == 0 || !is_word(chars[i - 1])) {
            let mut digits = 0;
            while digits < 2
                && i + 1 + digits < chars.len()
                && chars[i + 1 + digits].is_ascii_digit()
            {
                digits += 1;
            }
            for take in (1..=digits).rev() {
                let end = i + 1 + take;
                if end >= chars.len() || !is_word(chars[end]) {
                    return parse_at(&chars[i + 1..end]);
                }
            }
        }
        // Padrão B: (\d{1,2})\s*[ªº]\s*Temporada.
        if chars[i].is_ascii_digit() {
            for take in [2usize, 1] {
                let Some(head) = chars.get(i..i + take) else {
                    continue;
                };
                if !head.iter().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let mut j = i + take;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && (chars[j] == 'ª' || chars[j] == 'º') {
                    j += 1;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if temporada_at(&chars[j..]) {
                        return parse_at(head);
                    }
                }
            }
        }
    }
    None
}

/// Score de escolha do candidato (`resolveCandidateScore` do TS), porte fiel.
fn resolve_candidate_score(title: &str, season: Option<i64>, episode: Option<i64>) -> i64 {
    let parsed = parse_title_season_episode(title);
    let mut score: i64 = 0;
    if let (Some(season), Some(episode)) = (season, episode) {
        if parsed.seasons.contains(&season) && parsed.episodes.contains(&episode) {
            score += 100;
        } else if parsed.episodes.is_empty()
            && parsed.seasons.len() == 1
            && parsed.seasons[0] == season
        {
            score += 70;
        } else if parsed.episodes.is_empty() && parsed.seasons.contains(&season) {
            score += 50;
        } else if parsed.episodes.is_empty()
            && (parsed.complete || (parsed.season_pack && parsed.seasons.is_empty()))
        {
            score += 30;
        }
    }
    match audio_from_title(title) {
        "Dual" => score += 110,
        "Dublado" => score += 100,
        "Nacional" => score += 95,
        "Legendado" => score -= 50,
        _ => {}
    }
    score += match quality_from_title(title) {
        "2160p" => 15,
        "1080p" => 12,
        "720p" => 6,
        "480p" => 3,
        "SD" => 1,
        UNKNOWN_QUALITY => 4,
        _ => 0,
    };
    match source_from_title(title) {
        "BluRay" => score += 8,
        "WEB-DL" => score += 6,
        "WEBRip" | "HDTV" => score += 4,
        "CAM" => score -= 200,
        _ => {}
    }
    score
}

/// O pré-resolve inteiro em uma chamada (ver cabeçalho do módulo).
#[napi(catch_unwind)]
pub fn pre_resolve_br_napi(
    posts: Vec<PreResolvePost>,
    query: PreResolveQuery,
    settings: PreResolveSettings,
) -> PreResolveOutcome {
    let mut rejected: Vec<PreResolveRejected> = Vec::new();
    let mut alive: Vec<bool> = vec![true; posts.len()];
    // Títulos como texto uma vez: as etapas abaixo os leem repetidamente e o
    // `title_or_empty` clonaria a mesma string em cada passe.
    let titles: Vec<String> = posts.iter().map(title_or_empty).collect();
    let mark =
        |alive: &mut Vec<bool>, rejected: &mut Vec<PreResolveRejected>, i: usize, reason: u32| {
            alive[i] = false;
            rejected.push(PreResolveRejected {
                index: i as u32,
                reason,
            });
        };

    // Etapa 1: relevância. Com nomes, o filtro INTEIRO no core (o TS chamava
    // `filterRelevantRaw([item], ctx)` por post; o filtro é independente por
    // item, então o lote dá o mesmo veredito). Sem nomes: mantém tudo, ou o
    // `matchesBrTitle` contra a query limpa.
    if !query.names.is_empty() {
        let items: Vec<CoreItem> = posts.iter().map(core_item).collect();
        let year = query.year.clone().unwrap_or_default();
        let core_query = CoreQuery {
            names: &query.names,
            year: &year,
            alt_year: query.alt_year.as_deref(),
            is_series: query.is_series,
            season: query.season,
            episode: query.episode,
            multi_work_root: query.multi_work_root.as_deref(),
            home_release_at: query.home_release_at,
        };
        let core_settings = CoreSettings {
            now_ms: settings.now_ms,
            pre_home_release_cut: settings.pre_home_release_cut,
            pre_home_release_margin_ms: settings.pre_home_release_margin_ms,
            title_precision_tail_cut: settings.title_precision_tail_cut,
        };
        let outcome = filter_relevant_raw(&items, &core_query, &core_settings);
        for &(i, _reason) in &outcome.rejected {
            mark(&mut alive, &mut rejected, i, REJECT_TITLE);
        }
    } else if let Some(wanted) = query.wanted.as_deref().filter(|w| !w.is_empty()) {
        let prepared = BrTitleName::new(wanted);
        let year = query.query_year.as_deref().unwrap_or("");
        for (i, _post) in posts.iter().enumerate() {
            if !alive[i] {
                continue;
            }
            let title = titles[i].as_str();
            let own = title_tokens(title);
            if !matches_br_title_prepared(
                title,
                &prepared,
                year,
                query.br_is_series,
                None,
                &own,
                None,
                settings.title_precision_tail_cut,
            ) {
                mark(&mut alive, &mut rejected, i, REJECT_TITLE);
            }
        }
    }

    // Etapa 2: temporada declarada no título tem que ser a pedida.
    if let Some(requested) = query.requested_season {
        for (i, _post) in posts.iter().enumerate() {
            if !alive[i] {
                continue;
            }
            if let Some(season) = title_season_marker(&titles[i]) {
                if season != requested {
                    mark(&mut alive, &mut rejected, i, REJECT_SEASON);
                }
            }
        }
    }

    // Etapa 3: release de outro episódio morre antes do protetor (pack passa).
    if query.season.is_none() {
        if let (Some(s), Some(e)) = (query.requested_ep_season, query.requested_ep) {
            for (i, _post) in posts.iter().enumerate() {
                if !alive[i] {
                    continue;
                }
                if !matches_episode(&titles[i], Some(s), Some(e)) {
                    mark(&mut alive, &mut rejected, i, REJECT_EPISODE);
                }
            }
        }
    }

    // Etapa 4: dedupe por identidade (infoHash || magnet || downloadUrl).
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (i, post) in posts.iter().enumerate() {
        if !alive[i] {
            continue;
        }
        let identity = post
            .info_hash
            .as_deref()
            .filter(|s| !s.is_empty())
            .or_else(|| post.magnet.as_deref().filter(|s| !s.is_empty()))
            .or_else(|| post.download_url.as_deref().filter(|s| !s.is_empty()));
        let Some(identity) = identity else {
            continue;
        };
        let key = identity.trim().to_lowercase();
        if !seen.insert(key) {
            mark(&mut alive, &mut rejected, i, REJECT_DUPLICATE);
        }
    }

    // Etapa 5: score de escolha, ordena (score desc, ordem original) e corta.
    let mut scored: Vec<(usize, i64)> = posts
        .iter()
        .enumerate()
        .filter(|(i, _)| alive[*i])
        .map(|(i, _post)| {
            let score = resolve_candidate_score(&titles[i], query.season, query.episode);
            (i, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let max = if query.max_resolves < 0 {
        0
    } else {
        query.max_resolves as usize
    };
    let approved: Vec<usize> = scored.into_iter().map(|(i, _)| i).take(max).collect();

    // Etapa 6: guarda SSRF do link, SÓ no conjunto pós-slice — no TS a checagem
    // vive no `resolveDownloadMagnet`, depois do corte; a exceção do próprio
    // Jackett (`link_trusted`) e quem já é hash/magnet nem chegam nela.
    // Bloqueado NÃO sai da lista: no TS o item segue sem magnet, apenas sem o
    // fetch (o `resolveDownloadMagnet` devolvia null e o item ficava). Aqui o
    // motivo só MARCA quem o TS deve pular/logar.
    for &i in approved.iter() {
        let post = &posts[i];
        if has_hash_or_magnet(post)
            || post.link_trusted
            || post
                .download_url
                .as_deref()
                .filter(|u| !u.is_empty())
                .is_none()
        {
            continue;
        }
        if !is_safe_download_url(
            post.download_url.as_deref().unwrap_or(""),
            query.allow_private_urls,
        ) {
            mark(&mut alive, &mut rejected, i, REJECT_UNSAFE_URL);
        }
    }

    rejected.sort_by_key(|r| r.index);
    PreResolveOutcome {
        approved: approved.into_iter().map(|i| i as u32).collect(),
        rejected,
    }
}

/// Score de um candidato isolado (a ponte do `resolveCandidateScore` exportado
/// do TS, que o teste de prioridade consome).
#[napi(catch_unwind)]
pub fn resolve_candidate_score_napi(
    title: String,
    season: Option<i64>,
    episode: Option<i64>,
) -> i64 {
    resolve_candidate_score(&title, season, episode)
}

/// Guarda SSRF do link de download: export novo na ponte (`net-safety.ts`
/// vira chamada ao núcleo; DNS/fetch seguem no TS).
#[napi(catch_unwind)]
pub fn is_safe_download_url_napi(raw: String, allow_private: bool) -> bool {
    is_safe_download_url(&raw, allow_private)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(title: &str) -> PreResolvePost {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        PreResolvePost {
            title: Some(title.to_string()),
            title_pascal: None,
            magnet: None,
            magnet_uri: None,
            guid: None,
            is_br: false,
            info_hash: None,
            // URL única por post: senão o dedupe por downloadUrl come os casos.
            download_url: Some(format!("https://tracker.example/file{n}.torrent")),
            link_trusted: false,
        }
    }

    fn query() -> PreResolveQuery {
        PreResolveQuery {
            names: Vec::new(),
            wanted: Some("Filme".to_string()),
            year: None,
            query_year: None,
            alt_year: None,
            is_series: false,
            season: None,
            episode: None,
            multi_work_root: None,
            home_release_at: None,
            br_is_series: false,
            requested_season: None,
            requested_ep_season: None,
            requested_ep: None,
            max_resolves: 20,
            allow_private_urls: false,
        }
    }

    fn settings() -> PreResolveSettings {
        PreResolveSettings {
            now_ms: 1_760_000_000_000,
            pre_home_release_cut: true,
            pre_home_release_margin_ms: 48 * 3600 * 1000,
            title_precision_tail_cut: true,
        }
    }

    #[test]
    fn marcador_de_temporada_espelha_a_regex_do_ts() {
        // "S01E05": \bS(\d{1,2})\b não casa (o E cola no dígito) — como no JS.
        assert_eq!(title_season_marker("Serie S01E05 1080p"), None);
        assert_eq!(title_season_marker("Serie S01 1080p"), Some(1));
        assert_eq!(title_season_marker("Serie 2ª Temporada"), Some(2));
        assert_eq!(title_season_marker("Serie 3º TEMPORADA COMPLETA"), Some(3));
        assert_eq!(title_season_marker("Serie 3 ª Temporada"), Some(3));
        assert_eq!(title_season_marker("AbS01 resto"), None); // sem borda antes
        assert_eq!(title_season_marker("S012 x"), None); // \b falha nos 2 e no 1
        assert_eq!(title_season_marker("sem marcador"), None);
    }

    #[test]
    fn score_espelha_a_ordem_do_ts() {
        let s4k_dual =
            resolve_candidate_score("Filme (2024) 4K 2160p Dual Áudio WEB-DL", None, None);
        let s1080_dual =
            resolve_candidate_score("Filme (2024) 1080p Dual Áudio WEB-DL", None, None);
        let s_cam = resolve_candidate_score("Filme (2024) 1080p Dual Áudio CAM", None, None);
        assert!(s4k_dual > s1080_dual);
        assert!(s1080_dual > s_cam);
        // Bônus de episódio pedido.
        assert!(resolve_candidate_score("Serie S01E05", Some(1), Some(5)) > 0);
    }

    #[test]
    fn lote_aprova_filtrando_e_ordenando() {
        let mut posts = vec![
            post("Outra Obra 2020 1080p DUBLADO"),
            post("Filme 2020 1080p Dublado WEB-DL"),
            post("Filme 2020 CAM Dublado"),
            post("Filme 2020 2160p Dual Áudio BluRay"),
            post("Filme S03 1080p"),
        ];
        posts[4].download_url = Some("http://127.0.0.1:9117/dl/x".to_string());
        posts[3].info_hash = Some("abc".to_string());
        let mut q = query();
        q.requested_season = Some(1);
        let out = pre_resolve_br_napi(posts, q, settings());
        // 0 = outra obra; 4 = temporada errada ("S03" contra S01 pedida).
        // A URL privada do índice 4 bloqueada antes do fetch? Não: 4 já morreu
        // na etapa de temporada — a guarda de URL só roda pós-slice.
        assert_eq!(out.approved, vec![3, 1, 2]);
        assert_eq!(out.rejected.len(), 2);
        assert_eq!(out.rejected[0].index, 0);
        assert_eq!(out.rejected[0].reason, REJECT_TITLE);
        assert_eq!(out.rejected[1].index, 4);
        assert_eq!(out.rejected[1].reason, REJECT_SEASON);
    }

    #[test]
    fn url_insegura_rejeitada_so_pos_slice() {
        let mut posts = vec![
            post("Filme 2020 CAM Dublado"),
            post("Filme 2020 2160p Dual BluRay"),
        ];
        // O CAM sobrevive ao corte: fica na lista SEM fetch, só marcado.
        posts[0].download_url = Some("http://127.0.0.1:9117/api/x".to_string());
        let out = pre_resolve_br_napi(posts, query(), settings());
        assert_eq!(out.approved, vec![1, 0]);
        assert_eq!(out.rejected.len(), 1);
        assert_eq!(out.rejected[0].index, 0);
        assert_eq!(out.rejected[0].reason, REJECT_UNSAFE_URL);
    }

    #[test]
    fn url_insegura_cortada_pelo_teto_nem_chega_a_guarda() {
        let posts = vec![
            post("Filme 2020 CAM Dublado"), // score baixo, fora do teto 1
            post("Filme 2020 2160p Dual BluRay"),
        ];
        let mut q = query();
        q.max_resolves = 1;
        let out = pre_resolve_br_napi(posts, q, settings());
        // O CAM (índice 0) nem chega ao corte da URL: foi cortado pelo teto.
        assert_eq!(out.approved, vec![1]);
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn link_confiado_passa_da_guarda_de_url() {
        let mut posts = vec![post("Filme 2020 Dublado")];
        posts[0].link_trusted = true;
        posts[0].download_url = Some("http://127.0.0.1:7000/dl/bludv/a".to_string());
        let out = pre_resolve_br_napi(posts, query(), settings());
        assert_eq!(out.approved, vec![0]);
        assert!(out.rejected.is_empty());
    }

    #[test]
    fn url_insegura_aprovada_com_allow_private() {
        let mut posts = vec![post("Filme 2020 Dublado")];
        posts[0].download_url = Some("http://192.168.1.10/file".to_string());
        let mut q = query();
        q.allow_private_urls = true;
        let out = pre_resolve_br_napi(posts, q, settings());
        assert_eq!(out.approved, vec![0]);
    }

    #[test]
    fn episodiode_outro_episodio_rejeitado() {
        let posts = vec![
            post("Filme S01E02 1080p Dublado"),
            post("Filme S01E05 1080p"),
        ];
        let mut q = query();
        q.requested_ep_season = Some(1);
        q.requested_ep = Some(5);
        let out = pre_resolve_br_napi(posts, q, settings());
        assert_eq!(out.approved, vec![1]);
        assert_eq!(out.rejected[0].index, 0);
        assert_eq!(out.rejected[0].reason, REJECT_EPISODE);
    }

    #[test]
    fn duplicado_por_url_rejeitado() {
        let mut posts = vec![post("Filme 2020 Dublado"), post("Filme 2020 Dublado x")];
        posts[1].download_url = posts[0].download_url.clone();
        let out = pre_resolve_br_napi(posts, query(), settings());
        assert_eq!(out.approved, vec![0]);
        assert_eq!(out.rejected[0].index, 1);
        assert_eq!(out.rejected[0].reason, REJECT_DUPLICATE);
    }

    #[test]
    fn lote_vazio_devolve_vazio() {
        let out = pre_resolve_br_napi(Vec::new(), query(), settings());
        assert!(out.approved.is_empty() && out.rejected.is_empty());
    }
}
