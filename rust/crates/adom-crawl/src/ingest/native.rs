//! Adaptadores de PRODUÇÃO das costuras de ingestão (T3-L3).
//!
//! [`TmdbCatalog`] liga o `identify`/`get_titles` nativos do `adom-sources` à
//! costura [`ObraCatalog`]: a página sem IMDb ganha o MESMO veredito de quatro
//! estados do TS (`identified|unidentified|ambiguous|unavailable`, e só o
//! último é retentável) e os nomes do filtro saem do `Titles` do cliente —
//! incluindo os aliases BR que o núcleo já filtra.
//!
//! [`AdminStreamInvalidator`] é a PONTE para o `streams.db` do gateway: o
//! sidecar é outro processo e o cache em memória só é invalidado pela API admin
//! em loopback (`POST /streams/invalidate`, `adom-server/src/store_admin.rs`).
//! Falha aqui é fail-open: a página já foi gravada e o pior caso é a lista
//! servir dado velho até o TTL — nunca derrubar a raspagem.

use std::sync::Arc;
use std::time::Duration;

use adom_core::dedupe_names;
use adom_sources::{
    identify, IdentifyInput, IdentifyOutcome, IdentifyResult, MemoryMetaStore, MetaStore,
    SearchWorkType, SourcesConfig, Titles, TmdbClient,
};
use adom_store::MetaCacheStore;
use reqwest::Client;
use serde_json::json;

use super::catalog::{
    BoxFuture, IdentifyRequest, IdentifyVerdict, ObraCatalog, PageVerdict, StreamInvalidator,
    WorkNames,
};
use super::CrawlObra;

// ─── Catálogo TMDB ───────────────────────────────────────────────────────────

/// Identificação e nomes pelo TMDB nativo.
pub struct TmdbCatalog {
    client: Arc<TmdbClient>,
}

impl TmdbCatalog {
    pub fn new(client: Arc<TmdbClient>) -> Self {
        Self { client }
    }

    /// Cliente de produção: `TMDB_API_KEY`/`TMDB_*` do ambiente e o `cache.db`
    /// do Node como store (memória quando o SQLite não abre — perde a
    /// persistência, nunca a consulta).
    pub fn from_env() -> Result<Self, String> {
        let config = SourcesConfig::from_env();
        let store: Arc<dyn MetaStore> = match MetaCacheStore::from_env() {
            Ok(store) => Arc::new(store),
            Err(err) => {
                eprintln!("[ingest] cache.db de metadados indisponível ({err}); memória");
                Arc::new(MemoryMetaStore::new())
            }
        };
        let client = TmdbClient::new(config.tmdb, &config.user_agent, store)?;
        Ok(Self::new(Arc::new(client)))
    }

    /// Sem chave não há identificação NEM nomes: a fiação não liga a ingestão
    /// (sem nomes o `record` falha sempre e queimaria `tries` de toda página).
    pub fn has_api_key(&self) -> bool {
        self.client.config().has_api_key()
    }
}

impl ObraCatalog for TmdbCatalog {
    fn identify<'a>(&'a self, request: &'a IdentifyRequest) -> BoxFuture<'a, IdentifyVerdict> {
        Box::pin(async move {
            // O `IdentifyInput` empresta os campos do pedido; a assinatura já
            // amarra o prazo da chamada ao mesmo `'a`.
            let input = to_input(request);
            verdict_of(identify(&*self.client, &input).await)
        })
    }

    fn names<'a>(&'a self, obra: &'a CrawlObra) -> BoxFuture<'a, Option<WorkNames>> {
        Box::pin(async move {
            // `get_titles` é background-only (sem prazo do caller): o teto de
            // UMA requisição do cliente é o orçamento de cada consulta.
            let deadline = adom_sources::now_ms() + self.client.config().request_timeout_ms as i64;
            let titles = self
                .client
                .get_titles(&obra.imdb, obra.kind.is_series(), deadline)
                .await?;
            names_of(&titles)
        })
    }
}

/// `IdentifyRequest` do motor → entrada do `identify` nativo.
pub(super) fn to_input(request: &IdentifyRequest) -> IdentifyInput<'_> {
    IdentifyInput {
        // O vocabulário do motor é o mesmo que o `from_kind` do crate conhece
        // (`movie`/`series`), então não há segunda tabela de tradução.
        kind: SearchWorkType::from_kind(request.kind.as_str()),
        title: request.title.as_str(),
        year: request.year,
        original_title: request.original_title.as_deref(),
        season: request.season,
    }
}

/// Veredito nativo → contrato da ingestão.
///
/// Os quatro estados são preservados; o IMDb só acompanha o `identified` —
/// nos outros três ele é `None` por construção (obra errada é pior que
/// nenhuma). `unavailable` continua sendo o ÚNICO retentável.
pub(super) fn verdict_of(result: IdentifyResult) -> IdentifyVerdict {
    let outcome = match result.outcome {
        IdentifyOutcome::Identified => PageVerdict::Identified,
        IdentifyOutcome::Unidentified => PageVerdict::Unidentified,
        IdentifyOutcome::Ambiguous => PageVerdict::Ambiguous,
        IdentifyOutcome::Unavailable => PageVerdict::Unavailable,
    };
    let imdb = match outcome {
        PageVerdict::Identified => result.imdb,
        _ => None,
    };
    IdentifyVerdict {
        outcome,
        imdb,
        reason: result.reason.to_string(),
    }
}

/// Nomes de busca a partir do `Titles` do cliente.
///
/// Mesma ordem do `resolveSearchNames` do TS sem o `meta.name` (o Cinemeta não
/// participa do caminho de raspagem): en → pt → original → aliases BR, com o
/// `dedupe_names` do núcleo (normaliza acento/caixa/pontuação). Sem nenhum
/// nome devolve `None` — o `record` transforma isso em falha retentável, como
/// no Node.
pub(super) fn names_of(titles: &Titles) -> Option<WorkNames> {
    let mut raw: Vec<Option<&str>> = vec![
        titles.en.as_deref(),
        titles.pt.as_deref(),
        titles.original.as_deref(),
    ];
    raw.extend(titles.aliases_br.iter().map(|alias| Some(alias.as_str())));
    let names = dedupe_names(&raw);
    if names.is_empty() {
        return None;
    }
    Some(WorkNames {
        names,
        year: titles.year.as_deref().and_then(parse_year),
    })
}

/// `Titles.year` já vem cortado em 4 caracteres; zero/negativo não é ano.
fn parse_year(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok().filter(|year| *year > 0)
}

// ─── Ponte admin do streams.db ──────────────────────────────────────────────

/// Base do gateway (`adom-server::store_admin`), na porta de loopback.
const DEFAULT_URL: &str = "http://127.0.0.1:8711";
/// Env da base; o `store_admin` lê `STREAM_STORE_ADMIN_LISTEN` (host:porta) do
/// MESMO serviço — aqui a env é a URL, para o teste injetar porta efêmera.
const URL_ENV: &str = "STREAM_STORE_ADMIN_URL";
const TIMEOUT_ENV: &str = "STREAM_STORE_ADMIN_TIMEOUT_MS";
const TOKEN_ENV: &str = "STREAM_STORE_ADMIN_TOKEN";
/// Timeout CURTO: a invalidação é efeito colateral da página, não escrita.
const DEFAULT_TIMEOUT_MS: u64 = 2_000;
/// O MESMO header que o `store_admin` do gateway exige.
const TOKEN_HEADER: &str = "x-indexer-test-token";

/// Invalidação pela ponte admin do gateway (outro processo).
pub struct AdminStreamInvalidator {
    client: Client,
    endpoint: String,
    token: String,
}

impl AdminStreamInvalidator {
    /// `base_url` é a raiz do gateway (`http://127.0.0.1:8711`); o caminho da
    /// rota é fixo. Construção não falha: cliente de loopback em HTTP puro não
    /// depende de TLS, e o `default` cobre um builder recusado.
    pub fn new(base_url: &str, token: impl Into<String>, timeout_ms: u64) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(1)))
            .build()
            .unwrap_or_default();
        Self {
            client,
            endpoint: format!(
                "{}/streams/invalidate",
                base_url.trim().trim_end_matches('/')
            ),
            token: token.into().trim().to_string(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(
            &env_or(URL_ENV, DEFAULT_URL),
            token_from_env(),
            env_u64(TIMEOUT_ENV, DEFAULT_TIMEOUT_MS),
        )
    }

    /// Endpoint resolvido (diagnóstico; não contém credencial).
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
}

impl StreamInvalidator for AdminStreamInvalidator {
    fn invalidate<'a>(&'a self, imdb_id: &'a str) -> BoxFuture<'a, bool> {
        let Some(imdb) = normalize_imdb(imdb_id) else {
            // IMDb inválido não vira chave na ponte: não há o que invalidar.
            eprintln!("[ingest] invalidação ignorada: imdb inválido");
            return Box::pin(async { false });
        };
        if self.token.is_empty() {
            return Box::pin(async move {
                eprintln!(
                    "[ingest] invalidação de {imdb} sem token \
                     (STREAM_STORE_ADMIN_TOKEN/DEBRID_INTERNAL_TOKEN/JACKETT_TEST_TOKEN)"
                );
                false
            });
        }
        Box::pin(async move {
            let response = self
                .client
                .post(&self.endpoint)
                .header(TOKEN_HEADER, &self.token)
                .json(&json!({ "imdbId": imdb }))
                .send()
                .await;
            match response {
                Ok(resp) if resp.status().is_success() => true,
                Ok(resp) => {
                    eprintln!(
                        "[ingest] ponte admin recusou a invalidação: HTTP {}",
                        resp.status().as_u16()
                    );
                    false
                }
                // Fail-open: nada derruba a página; o TTL vence o cache velho.
                Err(err) => {
                    eprintln!("[ingest] ponte admin indisponível: {err}");
                    false
                }
            }
        })
    }
}

/// IMDb canônico (`tt` + dígitos, minúsculo). O `streams.db` indexa a obra por
/// esse id; qualquer outra coisa não deve ser enviada pela ponte.
pub(super) fn normalize_imdb(raw: &str) -> Option<String> {
    let lower = raw.trim().to_ascii_lowercase();
    let digits = lower.strip_prefix("tt")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(lower)
}

/// `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`.
///
/// A MESMA precedência de `adom-server/src/store_admin.rs`: o gateway escolhe o
/// token por essa ordem e a ponte precisa achar o mesmo valor. Vazio/ausente
/// não vence.
pub(super) fn token_from_lookup(lookup: impl Fn(&str) -> Option<String>) -> String {
    for key in [TOKEN_ENV, "DEBRID_INTERNAL_TOKEN", "JACKETT_TEST_TOKEN"] {
        let Some(value) = lookup(key) else {
            continue;
        };
        let value = value.trim();
        if !value.is_empty() {
            return value.to_string();
        }
    }
    String::new()
}

fn token_from_env() -> String {
    token_from_lookup(|key| std::env::var(key).ok())
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default)
}
