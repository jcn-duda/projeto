//! Adaptador Premiumize (fase D1): cache, directdl e conta.
//! Fora: `enqueue`, `torrentStatus`, `removeTorrent`, `sweepDead`. Sem log de chave, magnet ou corpo.
//! `/cache/check` não dispara directdl — isso escreve na conta e fica em `file_list`.

use std::collections::HashSet;
use std::time::Duration;

use adom_core::{pick_file, PickOutcome, PlayHint};
use reqwest::Method;
use serde_json::Value;

use crate::error::DebridError;
use crate::http::HttpClient;

const DEFAULT_BASE: &str = "https://www.premiumize.me/api";
const CACHE_TIMEOUT: Duration = Duration::from_millis(10_000);
const CALL_TIMEOUT: Duration = Duration::from_millis(6_000);
const DEFAULT_BATCH: usize = 25;

/// Teto de `scheduleFileLists` por checagem.
pub const FILE_LIST_CAP: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheReport {
    pub cached: Vec<String>,
    pub complete: bool,
    pub totals: Vec<(String, u64)>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentFile {
    pub path: String,
    pub size: u64,
    pub link: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreshLink {
    pub url: String,
    pub size: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct AccountStatus {
    pub limit_used: Option<f64>,
    pub premium_until: Option<f64>,
}
pub struct Premiumize {
    pub client: HttpClient,
    pub base: String,
    pub batch_size: usize,
}

impl Premiumize {
    /// Base recusada fica vazia: a chamada de rede erra sem pedir nada.
    pub fn new(client: HttpClient) -> Self {
        let base = match std::env::var("PREMIUMIZE_API_BASE") {
            Ok(raw) if !raw.trim().is_empty() => accepted_base(&raw).unwrap_or_default(),
            _ => DEFAULT_BASE.to_string(),
        };
        let parsed = std::env::var("DEBRID_BATCH_SIZE")
            .ok()
            .and_then(|raw| raw.trim().parse::<usize>().ok());
        Self {
            client,
            base,
            batch_size: parsed.filter(|n| *n > 0).unwrap_or(DEFAULT_BATCH),
        }
    }

    /// Lotes paralelos de `/cache/check`. `None` no prazo usa 10s.
    pub async fn check_cached(
        &self,
        api_key: &str,
        hashes: &[String],
        timeout: Option<Duration>,
    ) -> Result<CacheReport, DebridError> {
        let base = self.require_base()?.to_string();
        if hashes.is_empty() {
            return Ok(CacheReport {
                cached: Vec::new(),
                complete: true,
                totals: Vec::new(),
            });
        }
        let timeout = timeout.unwrap_or(CACHE_TIMEOUT);
        let size = self.batch_size.max(1);
        let mut handles = Vec::new();
        for batch in hashes.chunks(size) {
            let batch = batch.to_vec();
            let client = self.client.clone();
            let base = base.clone();
            let api_key = api_key.to_string();
            handles.push(tokio::spawn(async move {
                check_batch(&client, &base, &api_key, &batch, timeout).await
            }));
        }
        let mut results = Vec::with_capacity(handles.len());
        for handle in handles {
            results.push(match handle.await {
                Ok(result) => result,
                Err(_) => Err(DebridError::other("lote de checagem de cache cancelado")),
            });
        }
        fold_batches(results)
    }

    /// Régua de `scheduleFileLists`: só wanted, pula known e in_flight, teto.
    pub fn select_file_list_hashes(
        cached: &[String],
        wanted: &HashSet<String>,
        already_known: &HashSet<String>,
        in_flight: &HashSet<String>,
        max: usize,
    ) -> Vec<String> {
        let (wanted, known, flying) = (
            lower_set(wanted),
            lower_set(already_known),
            lower_set(in_flight),
        );
        let mut out = Vec::new();
        for raw in cached {
            if out.len() >= max {
                break;
            }
            let hash = raw.to_lowercase();
            if hash.is_empty() || out.iter().any(|item| item == &hash) {
                continue;
            }
            if wanted.contains(&hash) && !known.contains(&hash) && !flying.contains(&hash) {
                out.push(hash);
            }
        }
        out
    }

    pub async fn file_list(
        &self,
        api_key: &str,
        hash: &str,
        timeout: Option<Duration>,
        magnet: Option<&str>,
    ) -> Result<Vec<ContentFile>, DebridError> {
        self.directdl(api_key, hash, magnet, timeout.unwrap_or(CACHE_TIMEOUT))
            .await
    }

    pub async fn fresh_file_link(
        &self,
        api_key: &str,
        hash: &str,
        path: &str,
        magnet: Option<&str>,
    ) -> Result<Option<FreshLink>, DebridError> {
        Ok(self
            .directdl(api_key, hash, magnet, CACHE_TIMEOUT)
            .await?
            .into_iter()
            .find(|file| file.path == path)
            .and_then(|file| {
                (!file.link.is_empty()).then_some(FreshLink {
                    url: file.link,
                    size: file.size,
                })
            }))
    }

    /// Play usa 6s. Lista e link fresco usam os 10s da checagem.
    pub async fn resolve_link(
        &self,
        api_key: &str,
        hash: &str,
        hint: &PlayHint,
        magnet: Option<&str>,
    ) -> Result<Option<String>, DebridError> {
        let files = self.directdl(api_key, hash, magnet, CALL_TIMEOUT).await?;
        match pick_file(&as_debrid(&files), hint) {
            PickOutcome::Empty => Ok(None),
            PickOutcome::File { path, .. } => Ok(files
                .into_iter()
                .find(|file| file.path == path)
                .and_then(|file| (!file.link.is_empty()).then_some(file.link))),
            PickOutcome::Error {
                code,
                evidence,
                context,
            } => Err(pick_error(code, evidence, context)),
        }
    }

    pub async fn account_status(&self, api_key: &str) -> Result<AccountStatus, DebridError> {
        let data = self
            .get(api_key, "/account/info", &[], None, CALL_TIMEOUT)
            .await?;
        Ok(AccountStatus {
            limit_used: finite(data.get("limit_used")).map(|n| n.clamp(0.0, 1.0)),
            premium_until: finite(data.get("premium_until")),
        })
    }

    fn require_base(&self) -> Result<&str, DebridError> {
        if self.base.is_empty() {
            Err(base_rejected())
        } else {
            Ok(&self.base)
        }
    }

    async fn directdl(
        &self,
        api_key: &str,
        hash: &str,
        magnet: Option<&str>,
        timeout: Duration,
    ) -> Result<Vec<ContentFile>, DebridError> {
        let body = format!("src={}", form_encode(&choose_magnet(hash, magnet))).into_bytes();
        let data = self
            .get(api_key, "/transfer/directdl", &[], Some(body), timeout)
            .await?;
        Ok(content_of(&data))
    }

    async fn get(
        &self,
        api_key: &str,
        path: &str,
        params: &[(&str, &str)],
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Value, DebridError> {
        let method = if body.is_some() {
            Method::POST
        } else {
            Method::GET
        };
        request(
            &self.client,
            self.require_base()?,
            api_key,
            method,
            path,
            params,
            body,
            timeout,
        )
        .await
    }
}

#[path = "premiumize_http.rs"]
mod http_support;
use http_support::*;

#[cfg(test)]
#[path = "premiumize_tests.rs"]
mod premiumize_tests;

#[cfg(test)]
#[path = "premiumize_directdl_tests.rs"]
mod premiumize_directdl_tests;
