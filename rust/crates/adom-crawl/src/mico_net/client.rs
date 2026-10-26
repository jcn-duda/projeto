//! Cliente HTTP do Mico Leão Dublado: busca páginas do catálogo com throttle.
//!
//! Porte do módulo TS `src/providers/crawl-sites/mico-shared.ts:157-189`.

use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, RETRY_AFTER, USER_AGENT};
use reqwest::Client;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::mico::SeriesMeta;
use crate::mico_net::api::{parse_series_meta, MicoApi, MicoFuture, CINEMETA_BASE};
use crate::mico_net::throttle::MicoThrottle;
use crate::mico_net::types::{CatalogPage, CatalogType, MicoClientConfig, MicoError};

/// Regex para validar IMDb IDs: `tt` seguido de 1 a 10 dígitos.
const IMDB_ID_PATTERN: &str = r"^tt\d{1,10}$";

/// Cliente HTTP do Mico Leão Dublado.
///
/// Encapsula throttle, timeout e parsing de resposta do catálogo.
pub struct MicoClient {
    /// URL base da API (sem trailing slash).
    base_url: String,
    /// Timeout por requisição.
    timeout: Duration,
    /// Throttle serializado (gap mínimo + Retry-After).
    throttle: MicoThrottle,
    /// Cliente HTTP (reqwest).
    client: Client,
    /// Regex compilada para validar IMDb IDs.
    imdb_re: Regex,
}

impl MicoClient {
    /// Cria um novo cliente com a configuração especificada.
    pub fn new(config: MicoClientConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_millis(config.timeout_ms))
            .build()
            .expect("failed to build reqwest client");

        let throttle =
            MicoThrottle::new(config.min_gap_ms).with_max_retry_after(config.max_retry_after_ms);
        let imdb_re = Regex::new(IMDB_ID_PATTERN).expect("invalid IMDb ID regex");

        Self {
            base_url: config.base_url.trim_end_matches('/').to_string(),
            timeout: Duration::from_millis(config.timeout_ms),
            throttle,
            client,
            imdb_re,
        }
    }

    /// Busca uma página do catálogo do Mico.
    ///
    /// Fluxo:
    /// 1. `throttle.wait()` — espera intervalo mínimo e/ou Retry-After.
    /// 2. Monta URL: `{base_url}/catalog/{type}/{catalog_id}/skip={skip}.json`.
    /// 3. GET com header `Accept: application/json`.
    /// 4. Se 429: `throttle.honor_retry_after()` → `Err(MicoError::RateLimited)`.
    /// 5. Se não-OK: `Err(MicoError::HttpError)`.
    /// 6. Parse JSON: `data.metas[].id` — filtra só IMDb IDs válidos.
    /// 7. `throttle.record_call()` — registra o instante da chamada.
    /// 8. Retorna `CatalogPage { count, ids }`.
    pub async fn fetch_catalog_page(
        &self,
        kind: CatalogType,
        catalog_id: &str,
        skip: usize,
    ) -> Result<CatalogPage, MicoError> {
        // Espera o throttle (gap mínimo + Retry-After).
        self.throttle.wait().await;

        // Monta a URL.
        let url = format!(
            "{}/catalog/{}/{}/skip={}.json",
            self.base_url,
            kind.as_str(),
            catalog_id,
            skip
        );

        // Faz o GET com timeout e header Accept.
        let response = self
            .client
            .get(&url)
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    MicoError::Timeout
                } else {
                    MicoError::ConnectionError(e.to_string())
                }
            })?;

        let status = response.status();

        // 429 → Rate Limited.
        if status == 429 {
            let retry_after_ms = parse_retry_after(response.headers()).unwrap_or(0);
            self.throttle.honor_retry_after(retry_after_ms);
            return Err(MicoError::RateLimited { retry_after_ms });
        }

        // Outros status não-OK.
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(MicoError::HttpError {
                status: status.as_u16(),
                body,
            });
        }

        // Parse JSON tolerante a surrogate órfão (nome cortado no meio do
        // emoji), como o `JSON.parse` do TS: ver `adom_core::json_text`.
        let text = response
            .text()
            .await
            .map_err(|e| MicoError::JsonParseError(e.to_string()))?;
        let data: Value =
            serde_json::from_str(&adom_core::json_text::drop_lone_surrogate_escapes(&text))
                .map_err(|e| MicoError::JsonParseError(e.to_string()))?;

        // Extrai metas[].id e filtra por IMDb ID válido.
        let metas = data
            .get("metas")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();

        let count = metas.len();
        let ids: Vec<String> = metas
            .iter()
            .filter_map(|meta| {
                meta.get("id")
                    .and_then(|id| id.as_str())
                    .map(|s| s.trim().to_string())
            })
            .filter(|id| self.imdb_re.is_match(id))
            .collect();

        // Registra a chamada para o throttle.
        self.throttle.record_call();

        Ok(CatalogPage { count, ids })
    }

    /// Acesso apenas para teste ao throttle (reset de estado).
    #[doc(hidden)]
    pub fn _throttle(&self) -> &MicoThrottle {
        &self.throttle
    }

    /// GET JSON cru com o MESMO throttle do catálogo.
    ///
    /// `4xx` (exceto 429) devolve `Ok(None)`: é da obra/requisição e não prova
    /// host caído — mesma semântica do `fetchMicoStreams` do TS. `429`, `5xx`,
    /// timeout e rede sobem como `Err` (o motor faz backoff).
    pub async fn get_json(&self, url: &str) -> Result<Option<String>, MicoError> {
        self.throttle.wait().await;
        let response = self
            .client
            .get(url)
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .timeout(self.timeout)
            .send()
            .await;
        // O gap vale entre INÍCIOS: registra mesmo quando o request falha.
        self.throttle.record_call();
        let response = response.map_err(|e| {
            if e.is_timeout() {
                MicoError::Timeout
            } else {
                MicoError::ConnectionError(e.to_string())
            }
        })?;
        let status = response.status();
        if status == 429 {
            let retry_after_ms = parse_retry_after(response.headers()).unwrap_or(0);
            self.throttle.honor_retry_after(retry_after_ms);
            return Err(MicoError::RateLimited { retry_after_ms });
        }
        if status.is_client_error() {
            return Ok(None);
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(MicoError::HttpError {
                status: status.as_u16(),
                body,
            });
        }
        response
            .text()
            .await
            .map(Some)
            .map_err(|e| MicoError::JsonParseError(e.to_string()))
    }

    /// Metadados de série da Cinemeta (episódios por temporada + datas).
    pub async fn series_meta(&self, imdb: &str) -> Result<Option<SeriesMeta>, MicoError> {
        let url = format!("{CINEMETA_BASE}/meta/series/{imdb}.json");
        let response = self
            .client
            .get(&url)
            .header(ACCEPT, HeaderValue::from_static("application/json"))
            .header(USER_AGENT, HeaderValue::from_static("stremio-adom/1.0"))
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    MicoError::Timeout
                } else {
                    MicoError::ConnectionError(e.to_string())
                }
            })?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let text = response
            .text()
            .await
            .map_err(|e| MicoError::JsonParseError(e.to_string()))?;
        Ok(parse_series_meta(&text))
    }
}

impl MicoApi for MicoClient {
    fn catalog_page<'a>(
        &'a self,
        kind: CatalogType,
        catalog_id: &'a str,
        skip: usize,
    ) -> MicoFuture<'a, Result<CatalogPage, MicoError>> {
        Box::pin(async move { self.fetch_catalog_page(kind, catalog_id, skip).await })
    }

    fn get_json<'a>(&'a self, url: &'a str) -> MicoFuture<'a, Result<Option<String>, MicoError>> {
        Box::pin(async move { MicoClient::get_json(self, url).await })
    }

    fn series_meta<'a>(
        &'a self,
        imdb: &'a str,
    ) -> MicoFuture<'a, Result<Option<SeriesMeta>, MicoError>> {
        Box::pin(async move { MicoClient::series_meta(self, imdb).await })
    }
}

/// Extrai o valor do header `Retry-After` e converte para milissegundos.
///
/// O header pode ser:
/// - Integer seconds: `120` → 120_000 ms.
/// - HTTP date: `Wed, 21 Oct 2026 07:28:00 GMT` → ms até essa data.
///
/// Retorna `None` se o header estiver ausente ou for inválido.
pub fn parse_retry_after(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?;
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }

    // Tenta parse como integer seconds.
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(secs * 1000);
    }

    // Tenta parse como HTTP date (RFC 2822).
    if let Some(ms) = parse_http_date_to_ms(raw) {
        return Some(ms);
    }

    None
}

/// Converte uma data HTTP (RFC 2822) para milissegundos até esse instante.
///
/// Formato: `Wed, 21 Oct 2026 07:28:00 GMT`.
/// Retorna `None` se o parse falhar.
fn parse_http_date_to_ms(date_str: &str) -> Option<u64> {
    // Parse simplificado de RFC 2822: "Day, DD Mon YYYY HH:MM:SS GMT".
    let parts: Vec<&str> = date_str.split_whitespace().collect();
    if parts.len() < 6 {
        return None;
    }

    // parts[0] = "Wed," (day of week, ignorado)
    // parts[1] = "21" (day)
    // parts[2] = "Oct" (month)
    // parts[3] = "2026" (year)
    // parts[4] = "07:28:00" (time)
    // parts[5] = "GMT" (timezone, assumido UTC)

    let day: u32 = parts[1].parse().ok()?;
    let month = month_to_number(parts[2])?;
    let year: u32 = parts[3].parse().ok()?;

    let time_parts: Vec<&str> = parts[4].split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }
    let hour: u32 = time_parts[0].parse().ok()?;
    let min: u32 = time_parts[1].parse().ok()?;
    let sec: u32 = time_parts[2].parse().ok()?;

    // Converte para timestamp Unix (simplificado, sem leap year correction).
    let timestamp = date_to_unix_timestamp(year, month, day, hour, min, sec)?;

    // Calcula ms até esse instante.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;

    let diff_secs = timestamp as i64 - now;
    if diff_secs < 0 {
        Some(0)
    } else {
        Some(diff_secs as u64 * 1000)
    }
}

/// Converte nome do mês para número (1-12).
fn month_to_number(month: &str) -> Option<u32> {
    match month.to_lowercase().as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

/// Converte uma data para timestamp Unix (seconds since epoch).
///
/// Fórmula simplificada (não considera leap seconds, mas é suficiente para Retry-After).
fn date_to_unix_timestamp(
    year: u32,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
) -> Option<u64> {
    // Anos desde epoch (1970).
    if year < 1970 {
        return None;
    }

    // Dias desde epoch.
    let mut days: u64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }

    // Dias dos meses completos deste ano.
    let month_days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for m in 1..month {
        days += month_days[(m - 1) as usize] as u64;
        if m == 2 && is_leap_year(year) {
            days += 1;
        }
    }

    // Dias do mês atual.
    days += (day - 1) as u64;

    // Converte para segundos e adiciona hora/minuto/segundo.
    let timestamp = days * 86400 + hour as u64 * 3600 + min as u64 * 60 + sec as u64;
    Some(timestamp)
}

/// Verifica se um ano é bissexto.
fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}
