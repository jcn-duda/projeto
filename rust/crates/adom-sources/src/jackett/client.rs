//! Cliente HTTP Torznab/JSON do Jackett.
//!
//! - Globais: o caller agrupa (plano em `adom-core::plan_jackett_queries`);
//!   aqui cada indexer da lista é consultado em paralelo.
//! - BR/slow: o caller isola + manda query pt-BR; `shape_search_query` aplica
//!   `strip_diacritics` só quando `is_br`.
//! - Breaker só em offline; falha de rede → `[]` / outcome honesto, sem panic.
//! - A API key nunca entra em log (só na query string da requisição).

use std::sync::Arc;
use std::time::Instant;

use reqwest::Client;

use super::breaker::Breaker;
use super::config::JackettConfig;
use super::download::{self, download_client};
use super::query::{budget_for, shape_for, shape_search_query};
use super::types::{IndexerStatus, JackettMediaType, JackettRawItem, QueryOutcome, SearchOptions};
use crate::http::remaining;

/// Cliente Jackett reutilizável (HTTP + breaker compartilhado).
#[derive(Clone)]
pub struct JackettClient {
    config: Arc<JackettConfig>,
    http: Client,
    download_http: Client,
    breaker: Arc<Breaker>,
}

impl JackettClient {
    pub fn new(config: JackettConfig) -> Result<Self, String> {
        let mut builder = Client::builder();
        let agent = config.user_agent.trim();
        if !agent.is_empty() {
            builder = builder.user_agent(agent);
        }
        let http = builder
            .build()
            .map_err(|err| format!("cliente HTTP Jackett: {err}"))?;
        let download_http = download_client(&config.user_agent)?;
        Ok(Self {
            config: Arc::new(config),
            http,
            download_http,
            breaker: Arc::new(Breaker::new()),
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::new(JackettConfig::from_env())
    }

    pub fn config(&self) -> &JackettConfig {
        &self.config
    }

    pub fn breaker(&self) -> &Breaker {
        &self.breaker
    }

    /// Consulta a lista de indexers em paralelo. Sem chave / query vazia → `[]`.
    ///
    /// Lista vazia de indexers cai no agregado `/all` (mesmo contrato do TS).
    /// O status por indexer é perdido AQUI de propósito (API legada); quem
    /// precisa dele usa [`JackettClient::search_outcomes`].
    pub async fn search(
        &self,
        query: &str,
        media_type: JackettMediaType,
        indexers: &[String],
        options: &SearchOptions,
    ) -> Vec<JackettRawItem> {
        self.search_outcomes(query, media_type, indexers, options)
            .await
            .into_iter()
            .flat_map(|outcome| outcome.items)
            .collect()
    }

    /// Consulta UM indexer (cascata sequencial no mesmo deadline).
    pub async fn query_indexer(
        &self,
        indexer: &str,
        query: &str,
        media_type: JackettMediaType,
        options: &SearchOptions,
    ) -> QueryOutcome {
        let started = Instant::now();
        let is_br = self.config.is_br(indexer);
        let timeout = options
            .timeout_ms
            .unwrap_or_else(|| budget_for(indexer, &self.config));
        let deadline_at = crate::http::now_ms() + timeout as i64;
        let skip_resolve = options.skip_resolve || !self.config.resolves_download(indexer);

        let mut source_error: Option<String> = None;
        let mut live_fetches = 0u32;

        let fetch_one = |candidate: String, is_cascade: bool| {
            let this = self.clone();
            let indexer = indexer.to_string();
            async move {
                this.fetch_torznab(
                    &indexer,
                    &candidate,
                    media_type,
                    is_br,
                    deadline_at,
                    is_cascade,
                )
                .await
            }
        };

        let primary = fetch_one(query.to_string(), false).await;
        live_fetches += primary.live;
        if let Some(err) = primary.envelope_error {
            source_error = Some(err);
        }
        let mut found_query = primary.search_query;
        let mut found_items = primary.items;
        let mut shaped_seen = vec![found_query.clone()];

        // Cascata sequencial (mesmas regras do TS, sem matchContext/relevância
        // nesta fatia: abre quando a lista ainda está VAZIA).
        let mut cascade: Vec<(String, &'static str, bool)> = Vec::new();
        if is_br {
            if let Some(v) = &options.variant_query {
                cascade.push((v.clone(), "variante numérica", false));
            }
        }
        let bare = strip_trailing_year_token(query);
        if bare != query {
            cascade.push((bare, "título sem ano", false));
        }
        if is_br {
            if let Some(v) = &options.franchise_query {
                cascade.push((v.clone(), "raiz da franquia", false));
            }
            if let Some(v) = &options.multi_work_query {
                cascade.push((v.clone(), "coleção multiobra da franquia", true));
            }
            if let Some(v) = &options.fallback_query {
                cascade.push((v.clone(), "fallback do plano BR", false));
            }
        }
        if let Some(orig) = &options.original_query {
            let bilingual_useful = is_br
                && options.fallback_query.as_ref().is_some_and(|fb| {
                    shape_search_query(indexer, fb, is_br, self.config.is_bare_title(indexer))
                        != shape_search_query(
                            indexer,
                            query,
                            is_br,
                            self.config.is_bare_title(indexer),
                        )
                });
            if !bilingual_useful {
                cascade.push((orig.clone(), "título original da obra", false));
                let ascii = adom_core::strip_diacritics(orig);
                if ascii != *orig {
                    cascade.push((ascii, "título original sem acento", false));
                }
            }
        }

        for (step_q, label, is_multiwork) in cascade {
            let shaped = shape_for(indexer, &step_q, &self.config);
            if shaped.is_empty() || shaped_seen.contains(&shaped) {
                continue;
            }
            let left = remaining(deadline_at)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if left <= 400 {
                continue;
            }
            // Sem matchContext: multiobra complementar só abre se ainda vazio;
            // os demais também exigem vazio (gate clássico).
            let opens = found_items.is_empty() || is_multiwork;
            if !opens {
                continue;
            }
            if found_items.is_empty() {
                eprintln!("[jackett] {indexer}: nenhum resultado; tentando {label}");
            } else if is_multiwork {
                eprintln!(
                    "[jackett] {indexer}: pack da franquia pode existir só na coleção; tentando {label}"
                );
            }
            shaped_seen.push(shaped);
            let step = fetch_one(step_q, true).await;
            live_fetches += step.live;
            // Degrau não reclassifica saúde da primária.
            if is_multiwork && !found_items.is_empty() {
                found_items.extend(step.items);
            } else {
                found_items = step.items;
            }
            found_query = step.search_query;
        }
        let _ = found_query;

        let items = if skip_resolve {
            found_items
        } else {
            self.resolve_links(indexer, found_items, deadline_at).await
        };

        let source_ok = !items.is_empty() || source_error.is_none();
        let status = if source_ok {
            if items.is_empty() {
                IndexerStatus::Empty
            } else {
                IndexerStatus::Ok
            }
        } else {
            // Timeout individual é falha declarada (`source_error:timeout`),
            // como `responded:false` no Node — NUNCA `Pending`/partial.
            IndexerStatus::Failed
        };
        QueryOutcome {
            indexer: indexer.to_string(),
            items,
            ms: started.elapsed().as_millis() as u64,
            from_cache: live_fetches == 0,
            source_ok,
            source_error: if source_ok { None } else { source_error },
            status,
            record_status: options.record_status(),
        }
    }

    /// Resolve um `Link` com guarda SSRF + redirect manual.
    pub async fn resolve_download_magnet(&self, url: &str, budget_ms: u64) -> Option<String> {
        download::resolve_download_magnet(&self.download_http, url, &self.config, budget_ms).await
    }
}

#[path = "client_fetch.rs"]
mod client_fetch;
use client_fetch::*;

#[path = "client_outcomes.rs"]
mod client_outcomes;
