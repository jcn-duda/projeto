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

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde_json::Value;

use super::breaker::{now_ms, Breaker};
use super::config::JackettConfig;
use super::download::{self, download_client};
use super::query::{budget_for, shape_for, shape_search_query};
use super::results::{category_policy, indexer_failure, map_results, MapOptions};
use super::types::{JackettMediaType, JackettRawItem, QueryOutcome, SearchOptions};
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
    pub async fn search(
        &self,
        query: &str,
        media_type: JackettMediaType,
        indexers: &[String],
        options: &SearchOptions,
    ) -> Vec<JackettRawItem> {
        if !self.config.has_api_key() {
            eprintln!("[jackett] JACKETT_API_KEY não configurada");
            return Vec::new();
        }
        if query.is_empty() {
            return Vec::new();
        }

        if indexers.is_empty() {
            return self.search_all(query, media_type, options).await;
        }

        let active: Vec<String> = if options.ignore_breaker {
            indexers.to_vec()
        } else {
            let now = now_ms();
            indexers
                .iter()
                .filter(|indexer| {
                    if !self.breaker.tripped(indexer, &self.config, now) {
                        self.breaker.clear_announced(indexer);
                        true
                    } else {
                        if self.breaker.should_announce_trip(indexer) {
                            let snap = self.breaker.snapshot(indexer, &self.config, now);
                            eprintln!(
                                "[jackett] {indexer}: circuit breaker aberto após {} falha(s) \
                                 seguidas; buscas pulam este indexer até {}min após a última falha",
                                snap.fail_streak.max(self.config.breaker_failures),
                                self.config.breaker_cooldown_ms / 60_000
                            );
                        }
                        false
                    }
                })
                .cloned()
                .collect()
        };
        if active.is_empty() {
            return Vec::new();
        }

        let mut handles = Vec::with_capacity(active.len());
        for indexer in &active {
            let this = self.clone();
            let indexer = indexer.clone();
            let query = query.to_string();
            let options = options.clone();
            handles.push(tokio::spawn(async move {
                this.query_indexer(&indexer, &query, media_type, &options)
                    .await
            }));
        }

        let mut out = Vec::new();
        let mut slow = Vec::new();
        for (idx, handle) in handles.into_iter().enumerate() {
            let indexer = &active[idx];
            match handle.await {
                Ok(outcome) => {
                    if options.record_status() && !outcome.from_cache {
                        self.breaker.record(
                            &outcome.indexer,
                            outcome.source_ok,
                            now_ms(),
                        );
                        if !outcome.source_ok {
                            if let Some(err) = &outcome.source_error {
                                eprintln!("[jackett] {}: fonte fora (HTTP 200): {err}", outcome.indexer);
                            }
                        }
                    }
                    if !outcome.source_ok {
                        slow.push(format!("{indexer} ✗ fonte"));
                    } else if !outcome.from_cache && outcome.ms > 2_000 {
                        slow.push(format!("{indexer} {:.1}s", outcome.ms as f64 / 1000.0));
                    }
                    out.extend(outcome.items);
                }
                Err(err) => {
                    // JoinError / panic no task — engole e segue (nunca propaga).
                    eprintln!("[jackett] {indexer}: tarefa abortada: {err}");
                    if options.record_status() {
                        self.breaker.record(indexer, false, now_ms());
                    }
                    slow.push(format!("{indexer} ✗"));
                }
            }
        }
        if !slow.is_empty() {
            eprintln!("[jackett] lentos/falharam: {}", slow.join(", "));
        }
        out
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
            let left = remaining(deadline_at).map(|d| d.as_millis() as u64).unwrap_or(0);
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
            self.resolve_links(indexer, found_items, deadline_at)
                .await
        };

        let source_ok = !items.is_empty() || source_error.is_none();
        QueryOutcome {
            indexer: indexer.to_string(),
            items,
            ms: started.elapsed().as_millis() as u64,
            from_cache: live_fetches == 0,
            source_ok,
            source_error: if source_ok { None } else { source_error },
        }
    }

    /// Resolve um `Link` com guarda SSRF + redirect manual.
    pub async fn resolve_download_magnet(&self, url: &str, budget_ms: u64) -> Option<String> {
        download::resolve_download_magnet(&self.download_http, url, &self.config, budget_ms).await
    }

    async fn search_all(
        &self,
        query: &str,
        _media_type: JackettMediaType,
        _options: &SearchOptions,
    ) -> Vec<JackettRawItem> {
        let deadline = crate::http::now_ms() + self.config.indexer_timeout_ms as i64;
        match self
            .get_results_json("all", query, None, deadline)
            .await
        {
            Ok(payload) => map_results(
                &payload,
                MapOptions {
                    is_br: false,
                    indexer: "",
                    category_bucket: 0,
                    other_as_unknown: false,
                },
            ),
            Err(err) => {
                eprintln!("[jackett] {err}");
                Vec::new()
            }
        }
    }

    async fn fetch_torznab(
        &self,
        indexer: &str,
        candidate_query: &str,
        media_type: JackettMediaType,
        is_br: bool,
        deadline_at: i64,
        _is_cascade: bool,
    ) -> FetchStep {
        let search_query = shape_for(indexer, candidate_query, &self.config);
        let bucket = media_type.category_bucket();
        let (send_category, filter_locally, other_as_unknown) = category_policy(indexer);
        let category = if send_category && bucket > 0 {
            Some(bucket)
        } else {
            None
        };
        let local_bucket = if filter_locally { bucket } else { 0 };

        match self
            .get_results_json(indexer, &search_query, category, deadline_at)
            .await
        {
            Ok(payload) => {
                let envelope_error = indexer_failure(&payload);
                let items = map_results(
                    &payload,
                    MapOptions {
                        is_br,
                        indexer,
                        category_bucket: local_bucket,
                        other_as_unknown,
                    },
                );
                FetchStep {
                    search_query,
                    items,
                    envelope_error,
                    live: 1,
                }
            }
            Err(err) => {
                eprintln!("[jackett] {indexer}: {err}");
                FetchStep {
                    search_query,
                    items: Vec::new(),
                    envelope_error: Some(err),
                    live: 1,
                }
            }
        }
    }

    /// GET `/api/v2.0/indexers/{id}/results`. A chave vai só na query — o log
    /// usa o `label` sem URL.
    async fn get_results_json(
        &self,
        indexer: &str,
        query: &str,
        category: Option<u32>,
        deadline_at: i64,
    ) -> Result<Value, String> {
        let Some(budget) = remaining(deadline_at) else {
            return Err("timeout".into());
        };
        let mut url = self.results_url(indexer)?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("apikey", &self.config.api_key);
            pairs.append_pair("Query", query);
            if let Some(cat) = category {
                pairs.append_pair("Category[]", &cat.to_string());
            }
        }
        // NÃO logar `url` — carrega a apikey.
        let label = format!("torznab/{indexer}");
        let request = self
            .http
            .get(url)
            .header(ACCEPT, "application/json")
            .timeout(budget);

        let exchange = async move {
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((status, bytes))
        };

        match tokio::time::timeout(budget, exchange).await {
            Ok(Ok((status, bytes))) => {
                if !(200..300).contains(&status) {
                    eprintln!("[jackett] {label}: HTTP {status}");
                    return Err(format!("HTTP {status}"));
                }
                serde_json::from_slice(&bytes).map_err(|err| {
                    eprintln!("[jackett] {label}: JSON inválido");
                    format!("JSON inválido: {err}")
                })
            }
            Ok(Err(err)) => {
                eprintln!("[jackett] {label}: falha de rede");
                Err(err)
            }
            Err(_) => {
                eprintln!("[jackett] {label}: prazo absoluto estourado");
                Err("timeout".into())
            }
        }
    }

    fn results_url(&self, indexer: &str) -> Result<Url, String> {
        let base = self.config.url.trim_end_matches('/');
        let raw = format!("{base}/api/v2.0/indexers/{indexer}/results");
        Url::parse(&raw).map_err(|err| format!("URL Jackett inválida: {err}"))
    }

    async fn resolve_links(
        &self,
        indexer: &str,
        items: Vec<JackettRawItem>,
        deadline_at: i64,
    ) -> Vec<JackettRawItem> {
        let mut out = Vec::with_capacity(items.len());
        let mut resolved = 0usize;
        for mut item in items {
            let has_hash = item
                .info_hash
                .as_deref()
                .filter(|h| !h.is_empty())
                .is_some();
            let has_magnet = item
                .magnet
                .as_deref()
                .is_some_and(|m| m.to_ascii_lowercase().starts_with("magnet:?"));
            if has_hash || has_magnet {
                out.push(item);
                continue;
            }
            let Some(link) = item.download_url.clone() else {
                continue;
            };
            if resolved >= self.config.max_download_resolves {
                continue;
            }
            let left = remaining(deadline_at)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if left < 400 {
                break;
            }
            resolved += 1;
            if let Some(magnet) = self.resolve_download_magnet(&link, left).await {
                item.magnet = Some(magnet);
                out.push(item);
            } else {
                eprintln!("[jackett] {indexer}: Link sem magnet útil");
            }
        }
        out
    }
}

struct FetchStep {
    search_query: String,
    items: Vec<JackettRawItem>,
    envelope_error: Option<String>,
    live: u32,
}

fn strip_trailing_year_token(query: &str) -> String {
    let trimmed = query.trim_end();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 4 {
        return query.to_string();
    }
    let year_start = bytes.len() - 4;
    let year = &bytes[year_start..];
    if !(year[0] == b'1' || year[0] == b'2')
        || !(year[1] == b'9' || year[1] == b'0')
        || !year[2].is_ascii_digit()
        || !year[3].is_ascii_digit()
    {
        return query.to_string();
    }
    if year_start == 0 || !bytes[year_start - 1].is_ascii_whitespace() {
        return query.to_string();
    }
    let mut cut = year_start;
    while cut > 0 && bytes[cut - 1].is_ascii_whitespace() {
        cut -= 1;
    }
    trimmed[..cut].trim().to_string()
}
