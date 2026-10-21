use std::time::Instant;

use reqwest::header::ACCEPT;
use reqwest::Url;
use serde_json::Value;

use super::super::query::shape_for;
use super::super::results::{category_policy, indexer_failure, map_results, MapOptions};
use super::super::types::{
    IndexerStatus, JackettMediaType, JackettRawItem, QueryOutcome, SearchOptions, ALL_QUERY_INDEXER,
};
use super::JackettClient;
use crate::http::{now_ms, remaining};

impl JackettClient {
    /// Ramo agregado `/all` com o mesmo contrato de status por indexer.
    pub(super) async fn search_all_outcome(
        &self,
        query: &str,
        _media_type: JackettMediaType,
        options: &SearchOptions,
    ) -> QueryOutcome {
        let started = Instant::now();
        let deadline = now_ms() + self.config.indexer_timeout_ms as i64;
        match self.get_results_json("all", query, None, deadline).await {
            Ok(payload) => {
                let items = map_results(
                    &payload,
                    MapOptions {
                        is_br: false,
                        indexer: "",
                        category_bucket: 0,
                        other_as_unknown: false,
                    },
                );
                QueryOutcome {
                    indexer: ALL_QUERY_INDEXER.to_string(),
                    status: if items.is_empty() {
                        IndexerStatus::Empty
                    } else {
                        IndexerStatus::Ok
                    },
                    items,
                    ms: started.elapsed().as_millis() as u64,
                    from_cache: false,
                    source_ok: true,
                    source_error: None,
                    record_status: options.record_status(),
                }
            }
            Err(err) => {
                eprintln!("[jackett] {}", err.message);
                QueryOutcome {
                    indexer: ALL_QUERY_INDEXER.to_string(),
                    items: Vec::new(),
                    ms: started.elapsed().as_millis() as u64,
                    from_cache: false,
                    source_ok: false,
                    // Timeout do `/all` também é falha declarada (o Node
                    // responde `all=error`, nunca `pending`, ao estourar).
                    status: IndexerStatus::Failed,
                    source_error: Some(err.message),
                    record_status: options.record_status(),
                }
            }
        }
    }

    pub(super) async fn fetch_torznab(
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
                eprintln!("[jackett] {indexer}: {}", err.message);
                FetchStep {
                    search_query,
                    items: Vec::new(),
                    envelope_error: Some(err.message),
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
    ) -> Result<Value, FetchError> {
        let Some(budget) = remaining(deadline_at) else {
            return Err(FetchError::timeout());
        };
        let mut url = self.results_url(indexer).map_err(FetchError::failed)?;
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
            let response = request.send().await.map_err(reqwest_error)?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(reqwest_error)?;
            Ok::<_, FetchError>((status, bytes))
        };

        match tokio::time::timeout(budget, exchange).await {
            Ok(Ok((status, bytes))) => {
                if !(200..300).contains(&status) {
                    eprintln!("[jackett] {label}: HTTP {status}");
                    return Err(FetchError::failed(format!("HTTP {status}")));
                }
                serde_json::from_slice(&bytes).map_err(|err| {
                    eprintln!("[jackett] {label}: JSON inválido");
                    FetchError::failed(format!("JSON inválido: {err}"))
                })
            }
            Ok(Err(err)) => {
                eprintln!("[jackett] {label}: falha de rede");
                Err(err)
            }
            Err(_) => {
                eprintln!("[jackett] {label}: prazo absoluto estourado");
                Err(FetchError::timeout())
            }
        }
    }

    fn results_url(&self, indexer: &str) -> Result<Url, String> {
        let base = self.config.url.trim_end_matches('/');
        let raw = format!("{base}/api/v2.0/indexers/{indexer}/results");
        Url::parse(&raw).map_err(|err| format!("URL Jackett inválida: {err}"))
    }

    pub(super) async fn resolve_links(
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

pub(super) struct FetchStep {
    pub(super) search_query: String,
    pub(super) items: Vec<JackettRawItem>,
    pub(super) envelope_error: Option<String>,
    pub(super) live: u32,
}

/// Falha de transporte com o motivo já normalizado ("timeout" para prazo).
pub(super) struct FetchError {
    pub(super) message: String,
}

impl FetchError {
    fn failed(message: String) -> Self {
        Self { message }
    }

    fn timeout() -> Self {
        Self {
            message: "timeout".to_string(),
        }
    }
}

/// O teto por requisição do reqwest vence antes do timeout externo: o motivo
/// vira o mesmo "timeout" do prazo absoluto (falha declarada, não pending).
fn reqwest_error(err: reqwest::Error) -> FetchError {
    if err.is_timeout() {
        FetchError::timeout()
    } else {
        FetchError::failed(err.to_string())
    }
}

pub(super) fn strip_trailing_year_token(query: &str) -> String {
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
