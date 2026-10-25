//! Pré-resolve do protetor de link BR em UM lote
//! (`resolveCardigannDownloads`, `src/providers/jackett-resolve.ts` do `esm`).
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
//! Mora no NÚCLEO (era do `adom-napi` até 2026-10-24): a regra é do core e o
//! `adom-napi` só converte os tipos `#[napi(object)]`. Com a regra no crate
//! napi, o golden linkava as funções `#[napi]` e o executável de teste não
//! fechava no Linux (símbolos `napi_*` só existem dentro do Node) — o job Rust
//! do CI ficou vermelho de 23/10 a 24/10.

use crate::{
    filter_relevant_raw, is_safe_download_url, matches_br_title_prepared, matches_episode,
    title_tokens, BrTitleName, RelevanceItem as CoreItem, RelevanceQuery as CoreQuery,
    RelevanceSettings as CoreSettings,
};

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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreResolveSettings {
    pub now_ms: i64,
    pub pre_home_release_cut: bool,
    pub pre_home_release_margin_ms: i64,
    /// Também governa o piso de precisão do caminho `matchesBrTitle`.
    pub title_precision_tail_cut: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PreResolveRejected {
    pub index: u32,
    pub reason: u32,
}

/// Aprovados já na ordem final (score desc, ordem original em empate) e já
/// cortados pelo teto; os cortados PELO TETO não são rejeição — não aparecem
/// em lista nenhuma, como no TS.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

#[path = "pre_resolve_score.rs"]
mod pre_resolve_score;
pub use pre_resolve_score::resolve_candidate_score;
use pre_resolve_score::title_season_marker;

/// O pré-resolve inteiro em uma chamada (ver cabeçalho do módulo).
pub fn pre_resolve_br(
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

#[cfg(test)]
#[path = "pre_resolve_tests.rs"]
mod tests;
