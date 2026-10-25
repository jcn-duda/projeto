//! Ponte NAPI do pré-resolve do protetor BR. A REGRA mora no núcleo
//! (`adom_core::pre_resolve`, com golden contra o TS do `esm`); aqui ficam só
//! os tipos `#[napi(object)]` que o JS envia e a conversão de/para o núcleo.
//! Teste da regra = teste do `adom-core` (o executável de teste do crate napi
//! não linka no Linux: os símbolos `napi_*` só existem dentro do Node).

use adom_core::is_safe_download_url;
use adom_core::pre_resolve as core;
use napi_derive::napi;

/// Motivos de rejeição (a string do rótulo fica do lado Node,
/// `PRE_RESOLVE_REJECT_LABELS`).
pub use adom_core::pre_resolve::{
    REJECT_DUPLICATE, REJECT_EPISODE, REJECT_SEASON, REJECT_TITLE, REJECT_UNSAFE_URL,
};

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

impl From<PreResolvePost> for core::PreResolvePost {
    fn from(p: PreResolvePost) -> Self {
        Self {
            title: p.title,
            title_pascal: p.title_pascal,
            magnet: p.magnet,
            magnet_uri: p.magnet_uri,
            guid: p.guid,
            is_br: p.is_br,
            info_hash: p.info_hash,
            download_url: p.download_url,
            link_trusted: p.link_trusted,
        }
    }
}

impl From<PreResolveQuery> for core::PreResolveQuery {
    fn from(q: PreResolveQuery) -> Self {
        Self {
            names: q.names,
            wanted: q.wanted,
            year: q.year,
            query_year: q.query_year,
            alt_year: q.alt_year,
            is_series: q.is_series,
            season: q.season,
            episode: q.episode,
            multi_work_root: q.multi_work_root,
            home_release_at: q.home_release_at,
            br_is_series: q.br_is_series,
            requested_season: q.requested_season,
            requested_ep_season: q.requested_ep_season,
            requested_ep: q.requested_ep,
            max_resolves: q.max_resolves,
            allow_private_urls: q.allow_private_urls,
        }
    }
}

impl From<PreResolveSettings> for core::PreResolveSettings {
    fn from(s: PreResolveSettings) -> Self {
        Self {
            now_ms: s.now_ms,
            pre_home_release_cut: s.pre_home_release_cut,
            pre_home_release_margin_ms: s.pre_home_release_margin_ms,
            title_precision_tail_cut: s.title_precision_tail_cut,
        }
    }
}

impl From<core::PreResolveOutcome> for PreResolveOutcome {
    fn from(o: core::PreResolveOutcome) -> Self {
        Self {
            approved: o.approved,
            rejected: o
                .rejected
                .into_iter()
                .map(|r| PreResolveRejected {
                    index: r.index,
                    reason: r.reason,
                })
                .collect(),
        }
    }
}

/// O pré-resolve inteiro em uma chamada (regra em `adom_core::pre_resolve`).
#[napi(catch_unwind)]
pub fn pre_resolve_br_napi(
    posts: Vec<PreResolvePost>,
    query: PreResolveQuery,
    settings: PreResolveSettings,
) -> PreResolveOutcome {
    core::pre_resolve_br(
        posts.into_iter().map(Into::into).collect(),
        query.into(),
        settings.into(),
    )
    .into()
}

/// Score de um candidato isolado (a ponte do `resolveCandidateScore` exportado
/// do TS, que o teste de prioridade consome).
#[napi(catch_unwind)]
pub fn resolve_candidate_score_napi(
    title: String,
    season: Option<i64>,
    episode: Option<i64>,
) -> i64 {
    core::resolve_candidate_score(&title, season, episode)
}

/// Guarda SSRF do link de download: export novo na ponte (`net-safety.ts`
/// vira chamada ao núcleo; DNS/fetch seguem no TS).
#[napi(catch_unwind)]
pub fn is_safe_download_url_napi(raw: String, allow_private: bool) -> bool {
    is_safe_download_url(&raw, allow_private)
}
