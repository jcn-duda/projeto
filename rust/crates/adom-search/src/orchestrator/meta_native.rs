//! Fonte NATIVA de metadados — os clientes puros de `adom-sources` no lugar de
//! `POST /internal/search/meta`.
//!
//! Contrato com o caminho Node:
//!
//! - **nomes/aliases/ano** saem das MESMAS réguas do núcleo que o orquestrador
//!   aplica à resposta da rota: `adom_sources::MetaSources` já devolve
//!   `MetaLookup` com `names` deduplicado na ordem do `resolveSearchNames`
//!   (Cinemeta, en, pt, original, aliases BR) e o ano escolhido por
//!   `catalog_year_of`/`catalog_alt_year_of`;
//! - **montagem** passa por [`super::meta::build_search_meta`], a mesma função
//!   usada por [`super::meta::meta_from_response`] — queries, degraus,
//!   `ptTitleDual` e multiobra não podem divergir entre as fontes;
//! - **data do episódio** sai de `episodeAired["S:E"]` e vira ms pelo parser do
//!   núcleo (`adom_core::parse_date_ms`); `firstAired` segue a regra do TS
//!   (`meta.firstAired ?? data do episódio`);
//! - **fail-open**: `lookup` nunca devolve erro; campo sem resposta fica `None`.
//!   O `Orchestrator` ainda cobre o caso de erro com o `SearchMeta::from_id`.
//!
//! O Node segue no caminho como FALLBACK: o [`FallbackMetaSource`] o chama
//! quando o nativo falha (ou volta sem nome) — a rede de segurança fica até
//! haver medida da taxa de fallback. A taxa é medida em `meta.*`
//! ([`super::meta_metrics`]); nada aqui muda de comportamento por causa dela.

use std::sync::Arc;

use serde_json::Value;

use adom_sources::{LookupOptions, MediaType, MetaLookup, MetaSources};

use super::internal_routes::RouteFuture;
use super::meta::{
    build_search_meta, first_year, MetaParts, MetaQuery, MetaSource, MetaTitles, SearchMeta,
};
use super::meta_metrics::{self, MetaMetrics};

/// Prazo do lookup quando a requisição não traz deadline (passe tardio): teto
/// curto, nunca maior que o orçamento de uma busca normal.
pub const DEFAULT_LOOKUP_TIMEOUT_MS: i64 = 5_000;

/// Fonte nativa: `MetaSources` (Cinemeta + TMDB + coleção/data) já montados com
/// store injetado (SQLite `cache.db` em produção, memória nos testes).
pub struct NativeMetaSource {
    sources: Arc<MetaSources>,
    /// Prazo do lookup quando o [`MetaQuery`] não traz `deadline_at_ms`.
    fallback_timeout_ms: i64,
}

impl NativeMetaSource {
    pub fn new(sources: Arc<MetaSources>) -> Self {
        Self {
            sources,
            fallback_timeout_ms: DEFAULT_LOOKUP_TIMEOUT_MS,
        }
    }

    /// Teto próprio para o passe sem deadline (diagnóstico/teste).
    pub fn with_timeout_ms(mut self, timeout_ms: i64) -> Self {
        self.fallback_timeout_ms = timeout_ms.max(1);
        self
    }

    pub fn sources(&self) -> &Arc<MetaSources> {
        &self.sources
    }
}

impl MetaSource for NativeMetaSource {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            let media_type = MediaType::parse(&req.kind)
                .ok_or_else(|| format!("tipo de metadados desconhecido: {}", req.kind))?;
            let parsed = adom_core::parse_stremio_id(&req.id);
            let imdb = parsed
                .get("imdbId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if imdb.is_empty() {
                return Err(format!("id sem IMDb: {}", req.id));
            }
            let deadline = req
                .deadline_at_ms
                .unwrap_or_else(|| adom_sources::now_ms().saturating_add(self.fallback_timeout_ms));
            let options = LookupOptions {
                include_multiwork: req.include_multiwork,
                include_home_release: req.include_home_release,
                // O teto do opt-in é do operador (`TMDB_COLLECTION_TIMEOUT_MS`).
                collection_timeout_ms: None,
            };
            let lookup = self
                .sources
                .lookup(&imdb, media_type, deadline, &options)
                .await;
            Ok(meta_from_lookup(&lookup, &req))
        })
    }
}

/// Fallback do caminho nativo: usa o Node quando o nativo falha ou volta sem
/// nome (nunca deve acontecer, mas falha de rede não pode zerar a busca). Se o
/// Node também falhar, devolve o parcial do nativo quando houver.
///
/// A instrumentação (`meta.*`) só MEDE: a ordem, as chamadas e o valor
/// devolvido são exatamente os de antes dela.
pub struct FallbackMetaSource {
    primary: Arc<dyn MetaSource>,
    fallback: Arc<dyn MetaSource>,
    /// Contadores `meta.*` (a global em produção; instância local no teste).
    metrics: MetaMetrics,
}

impl FallbackMetaSource {
    pub fn new(primary: Arc<dyn MetaSource>, fallback: Arc<dyn MetaSource>) -> Self {
        Self::with_metrics(primary, fallback, meta_metrics::global_metrics().clone())
    }

    /// Instância própria de métricas: os testes não disputam a global entre
    /// casos paralelos.
    pub fn with_metrics(
        primary: Arc<dyn MetaSource>,
        fallback: Arc<dyn MetaSource>,
        metrics: MetaMetrics,
    ) -> Self {
        Self {
            primary,
            fallback,
            metrics,
        }
    }

    /// Contadores desta instância (diagnóstico/teste).
    pub fn metrics(&self) -> &MetaMetrics {
        &self.metrics
    }
}

/// Título "de verdade": não vazio e diferente do próprio IMDb. É a régua do
/// `meta.native.incomplete` — `meta_from_lookup` cai no IMDb quando os títulos
/// faltaram, então `name` vazio não é a única forma de metadado incompleto.
fn has_real_title(meta: &SearchMeta) -> bool {
    let name = meta.name.trim();
    !name.is_empty() && name != meta.imdb_id.trim()
}

impl MetaSource for FallbackMetaSource {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            self.metrics.inc(meta_metrics::RESOLVE_TOTAL, 1);
            match self.primary.resolve(req.clone()).await {
                // Gate INALTERADO (nome vazio): `name == imdb_id` devolve o
                // primário sem chamar o Node — só a contagem o distingue.
                Ok(meta) if !meta.name.trim().is_empty() => {
                    if has_real_title(&meta) {
                        self.metrics.inc(meta_metrics::NATIVE_OK, 1);
                    } else {
                        self.metrics.inc(meta_metrics::NATIVE_INCOMPLETE, 1);
                    }
                    Ok(meta)
                }
                Ok(meta) => {
                    self.metrics.inc(meta_metrics::NATIVE_INCOMPLETE, 1);
                    match self.fallback.resolve(req).await {
                        Ok(fallback) if has_real_title(&fallback) => {
                            self.metrics.inc(meta_metrics::FALLBACK_USED, 1);
                            Ok(fallback)
                        }
                        Ok(fallback) => {
                            self.metrics.inc(meta_metrics::FALLBACK_EMPTY, 1);
                            Ok(fallback)
                        }
                        Err(_) => {
                            self.metrics.inc(meta_metrics::FALLBACK_ERROR, 1);
                            Ok(meta)
                        }
                    }
                }
                Err(err) => {
                    self.metrics.inc(meta_metrics::NATIVE_ERROR, 1);
                    eprintln!("[search] metadados nativos falharam ({err}); usando Node");
                    match self.fallback.resolve(req).await {
                        Ok(fallback) if has_real_title(&fallback) => {
                            self.metrics.inc(meta_metrics::FALLBACK_USED, 1);
                            Ok(fallback)
                        }
                        Ok(fallback) => {
                            self.metrics.inc(meta_metrics::FALLBACK_EMPTY, 1);
                            Ok(fallback)
                        }
                        Err(err) => {
                            self.metrics.inc(meta_metrics::FALLBACK_ERROR, 1);
                            Err(err)
                        }
                    }
                }
            }
        })
    }
}

/// `MetaLookup` (clientes puros) → [`SearchMeta`] no MESMO formato do caminho
/// Node. Função pura: o teste de corpus a exercita sem rede.
pub fn meta_from_lookup(lookup: &MetaLookup, req: &MetaQuery) -> SearchMeta {
    let parsed = adom_core::parse_stremio_id(&req.id);
    let imdb_id = if lookup.imdb.trim().is_empty() {
        parsed
            .get("imdbId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        lookup.imdb.trim().to_string()
    };
    let season = parsed.get("season").and_then(Value::as_i64);
    let episode = parsed.get("episode").and_then(Value::as_i64);
    let titles = lookup.title_pt.is_some()
        || lookup.title_original.is_some()
        || lookup.title_en.is_some()
        || lookup.titles_year.is_some();
    // `meta?.name || titles.en || titles.original || titles.pt || imdbId`.
    let name = lookup
        .meta_name
        .clone()
        .or_else(|| lookup.title_en.clone())
        .or_else(|| lookup.title_original.clone())
        .or_else(|| lookup.title_pt.clone())
        .unwrap_or_else(|| imdb_id.clone());
    let year = lookup
        .year
        .clone()
        .map(Value::String)
        .unwrap_or(Value::Null);
    let year_text = lookup.year.clone().unwrap_or_default();
    let collection_root = lookup
        .collection
        .as_ref()
        .map(|collection| collection.root.clone())
        .filter(|root| !root.is_empty())
        .filter(|_| first_year(&year_text) != 0);
    let aired_text = season
        .zip(episode)
        .and_then(|(season, episode)| lookup.episode_aired_at(season, episode));
    let first_aired = lookup
        .first_aired
        .clone()
        .or_else(|| aired_text.map(str::to_string));
    build_search_meta(MetaParts {
        imdb_id,
        season,
        episode,
        name,
        names: lookup.names.clone(),
        year,
        alt_year: lookup.alt_year.map(|year| year.to_string()),
        released: lookup.released.clone(),
        first_aired,
        episode_aired_at_ms: aired_text.and_then(adom_core::parse_date_ms),
        home_release_at: lookup.home_release_at,
        titles: titles.then(|| MetaTitles {
            pt: lookup.title_pt.clone(),
            original: lookup.title_original.clone(),
            en: lookup.title_en.clone(),
            year: lookup.titles_year.clone().map(Value::String),
        }),
        collection_root,
        episode_counts: lookup.episode_counts(),
    })
}

#[cfg(test)]
#[path = "meta_native_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "meta_corpus_tests.rs"]
mod corpus_tests;
