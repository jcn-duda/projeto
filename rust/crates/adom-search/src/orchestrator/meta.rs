//! Metadados da obra (Cinemeta + TMDB + coleção multiobra) — a matéria-prima
//! do plano de busca e do build.
//!
//! A rede é do Node (`POST /internal/search/meta`, rota da F1.1); o que este
//! módulo faz é a PARTE PURA do `doSearch`: `resolveSearchNames`,
//! `buildSearchQuery`, o degrau do título original, a query da varredura pt-BR
//! e o `resolveMultiWork` — todas funções do núcleo, chamadas aqui na mesma
//! ordem do TS (`search-orchestrator.ts:101-119`).
//!
//! O que fica de fora, com o motivo:
//! - **data de estreia do episódio** (`meta.episodeAired`): o parser de data do
//!   núcleo cobre o subconjunto determinístico de ISO; o campo chega do
//!   Cinemeta como texto e a guarda de pré-air precisa de ms. Fica `None` (a
//!   guarda de 48h não roda) até a fatia que fixar esse parse — o build já
//!   aceita `episode_aired_at_ms`.
//! - **`first_seen` do banco de magnets**: vem de `/internal/search/state`, que
//!   o orquestrador ainda não chama; o pré-air da conta usa só `publishedAt`.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::internal_types::{MetaRequest, MetaResponse};
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};

/// Obra já resolvida: nomes, ano, S/E e as queries que o plano consome.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchMeta {
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// Nome principal (`resolveSearchNames.name`).
    pub name: String,
    /// Todos os nomes (aliases deduplicados).
    pub names: Vec<String>,
    /// Ano como o catálogo manda (texto ou número — a chave de cache preserva).
    pub year: Value,
    pub alt_year: Option<String>,
    /// `Nome SxxEyy` / `Nome Ano`.
    pub query: String,
    /// Segunda query, só quando o título pt-BR difere do original.
    pub pt_query: Option<String>,
    /// Query da varredura pt-BR nos globais (sem ano nem SxxEyy).
    pub sweep_query: Option<String>,
    /// Degrau do título original (nome cru).
    pub original_query: Option<String>,
    /// Raiz da coleção multiobra (opt-in TMDB), só com ano conhecido.
    pub multi_work_root: Option<String>,
    /// Query do degrau multiobra (raiz da coleção).
    pub multi_work_query: Option<String>,
    /// `[(temporada, episódios)]` do Cinemeta — 💾 de pack.
    pub episode_counts: Vec<(i64, i64)>,
    /// Instalação em modo demo (sem rede): filtro de título desligado.
    pub is_demo: bool,
}

impl SearchMeta {
    /// Fallback do `resolveSearchNames`: sem metadados, o nome e a query são o
    /// IMDb id (o TS nunca busca com query vazia). A rota de coleta recusaria
    /// `query: ""`.
    pub fn from_id(id: &str) -> Self {
        let parsed = adom_core::parse_stremio_id(id);
        let imdb_id = parsed
            .get("imdbId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let season = int_of(&parsed, "season");
        let episode = int_of(&parsed, "episode");
        SearchMeta {
            name: imdb_id.clone(),
            names: if imdb_id.is_empty() {
                Vec::new()
            } else {
                vec![imdb_id.clone()]
            },
            query: imdb_id.clone(),
            imdb_id,
            season,
            episode,
            year: Value::Null,
            alt_year: None,
            pt_query: None,
            sweep_query: None,
            original_query: None,
            multi_work_root: None,
            multi_work_query: None,
            episode_counts: Vec::new(),
            is_demo: false,
        }
    }

    /// Ano como TEXTO (`String(year ?? '')`) — o `BuildContext` compara prefixo.
    pub fn year_text(&self) -> String {
        match &self.year {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        }
    }

    /// `{ names, year }` — o `searchMeta` gravado no cache (recompute do trace).
    pub fn search_meta_json(&self) -> Value {
        json!({ "names": self.names, "year": self.year })
    }
}

/// Pedido de metadados (o `encoded` vai no corpo, nunca na URL).
#[derive(Debug, Clone)]
pub struct MetaQuery {
    pub encoded: String,
    pub kind: String,
    pub id: String,
    /// Coleção multiobra (uma ida extra ao TMDB) — só filme com debrid.
    pub include_multiwork: bool,
    /// 1º lançamento doméstico (outra ida ao TMDB) — só filme.
    pub include_home_release: bool,
}

/// Fonte de metadados injetada. Produção: [`NodeMetaSource`]; testes: stub.
pub trait MetaSource: Send + Sync {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta>;
}

/// Produção: a rota interna do Node.
pub struct NodeMetaSource {
    routes: Arc<dyn InternalRoutes>,
}

impl NodeMetaSource {
    pub fn new(routes: Arc<dyn InternalRoutes>) -> Self {
        NodeMetaSource { routes }
    }
}

impl MetaSource for NodeMetaSource {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            let response = self
                .routes
                .meta(MetaRequest {
                    encoded: req.encoded.clone(),
                    media_type: req.kind.clone(),
                    id: req.id.clone(),
                    include_multiwork: Some(req.include_multiwork),
                    include_home_release: Some(req.include_home_release),
                })
                .await?;
            Ok(meta_from_response(&response, &req))
        })
    }
}

/// Resposta da rota → [`SearchMeta`]. Função PURA (o teste exercita sem rede).
pub fn meta_from_response(response: &MetaResponse, req: &MetaQuery) -> SearchMeta {
    let parsed = adom_core::parse_stremio_id(&req.id);
    let imdb_id = if response.imdb_id.is_empty() {
        parsed
            .get("imdbId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        response.imdb_id.clone()
    };
    let season = response.season.or_else(|| int_of(&parsed, "season"));
    let episode = response.episode.or_else(|| int_of(&parsed, "episode"));

    let names = adom_core::resolve_search_names(&json!({
        "meta": response.meta,
        "titles": response.titles,
        "imdbId": imdb_id,
    }));
    let name = names
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let all_names = names
        .get("names")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let year = names.get("year").cloned().unwrap_or(Value::Null);
    let alt_year = names
        .get("altYear")
        .and_then(Value::as_i64)
        .map(|n| n.to_string());

    let season_episode = json!({ "season": season, "episode": episode });
    let query =
        adom_core::build_search_query(&json!({ "name": name, "year": year }), &season_episode);
    let titles = response.titles.as_ref();
    let pt = titles
        .and_then(|t| t.get("pt"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let original = titles
        .and_then(|t| t.get("original"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let titles_year = titles
        .and_then(|t| t.get("year"))
        .cloned()
        .unwrap_or(Value::Null);
    let pt_query = match pt {
        Some(pt) if Some(pt) != original => Some(adom_core::build_search_query(
            &json!({ "name": pt, "year": titles_year }),
            &season_episode,
        )),
        _ => None,
    };
    let sweep_query = adom_core::pt_sweep_query_for(pt, original);
    let original_query = adom_core::resolve_original_step_name(original, Some(name.as_str()));

    // `resolveMultiWork`: sem ano de catálogo a dica assinada não seleciona
    // arquivo dentro da coleção — a raiz não vale.
    let multi_work = response.multi_work.as_ref();
    let catalog_year = first_year(&year_text_of(&year));
    let (multi_work_root, multi_work_query) = match multi_work
        .and_then(|m| m.get("root"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(root) if catalog_year != 0 => (Some(root.to_string()), Some(root.to_string())),
        _ => (None, None),
    };

    SearchMeta {
        imdb_id,
        season,
        episode,
        name,
        names: all_names,
        year,
        alt_year,
        query,
        pt_query,
        sweep_query,
        original_query,
        multi_work_root,
        multi_work_query,
        episode_counts: episode_counts(response.meta.as_ref()),
        is_demo: false,
    }
}

fn year_text_of(year: &Value) -> String {
    match year {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Primeiro ano de 4 dígitos (`Number(String(year).match(/(?:19|20)\d{2}/))`).
fn first_year(text: &str) -> i64 {
    let bytes = text.as_bytes();
    for window in bytes.windows(4) {
        let candidate = std::str::from_utf8(window).unwrap_or("");
        if candidate.len() == 4
            && (candidate.starts_with("19") || candidate.starts_with("20"))
            && candidate.bytes().all(|b| b.is_ascii_digit())
        {
            return candidate.parse::<i64>().unwrap_or(0);
        }
    }
    0
}

fn int_of(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

/// `[(temporada, episódios)]` a partir de `meta.videos` (Cinemeta): conta
/// EPISÓDIOS distintos por temporada — o `annotateEpisodeSizes` usa a contagem
/// para a média do 💾 de pack.
fn episode_counts(meta: Option<&Value>) -> Vec<(i64, i64)> {
    let Some(videos) = meta.and_then(|m| m.get("videos")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<(i64, Vec<i64>)> = Vec::new();
    for video in videos {
        let Some(season) = video.get("season").and_then(Value::as_i64) else {
            continue;
        };
        let Some(episode) = video.get("episode").and_then(Value::as_i64) else {
            continue;
        };
        match out.iter_mut().find(|(s, _)| *s == season) {
            Some((_, episodes)) => {
                if !episodes.contains(&episode) {
                    episodes.push(episode);
                }
            }
            None => out.push((season, vec![episode])),
        }
    }
    out.into_iter()
        .map(|(season, episodes)| (season, episodes.len() as i64))
        .collect()
}

#[cfg(test)]
#[path = "meta_tests.rs"]
mod tests;
