//! Catálogo de indexers do Jackett no gateway (F4.2) — cache em processo,
//! refresh periódico e o estado que a admin 8711 lê em `GET /indexers/catalog`.
//!
//! Porte da fiação de `src/providers/jackett-catalog.ts` (a COLETA já é o
//! `adom_sources::jackett::catalog` — esta fatia é o cache/task/rota):
//!
//! - **Memo TTL** (o `cacheTtlMs` do TS): `JACKETT_CATALOG_TTL` (default 900 s,
//!   a mesma env do Node). Publicado `fallback` COM chave, o memo encurta para
//!   `min(ttl, 30 s)` — no boot o Jackett costuma subir DEPOIS do gateway e com
//!   o TTL cheio o painel passava 15 min sem os indexers que só existem lá.
//! - **`startAutoRefresh`** (o `tick` do TS): tenta a cada 30 s até o vivo
//!   chegar; dali em diante a cada `max(60 s, TTL)`. Sem chave não há task —
//!   o fallback do `.env` nasce com o hub e não há o que refrescar.
//! - **Fetcher injetável**: produção é o [`LiveFetch`] (o client do gateway +
//!   config do env); teste injeta duplo e roda sem rede.
//! - **Card virtual do Mico** (o `withVirtual` do TS): entra só na SAÍDA da
//!   rota quando `MICO_ENABLED`, com `virtual:true` FORA da prova de vida — a
//!   régua do tri-state do painel é o `source: live|fallback` da coleta.
//!
//! O estado é global do processo (padrão do `status_board`): a task publica,
//! a rota só lê — nada de fiação nova no `AdminState`. O gateway é o dono
//! único do spawn (`proxy::spawn_store_admin` → [`spawn_from_env`]). Sem hub
//! instalado a rota devolve vazio com `fallback`: nunca inventa medição.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::Duration;

use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_sources::jackett::{
    fallback_catalog, load_catalog, CatalogCard, CatalogSnapshot, CatalogSource, JackettConfig,
};
use adom_sources::mico::{MicoConfig, MICO_ID};

use crate::store_admin::AdminState;

/// TTL do catálogo em segundos (`JACKETT_CATALOG_TTL`, a env do `catalogTtl`).
pub(crate) const TTL_ENV: &str = "JACKETT_CATALOG_TTL";
/// Default do TTL (o `num(process.env.JACKETT_CATALOG_TTL, 900)` do Node).
const TTL_DEFAULT_S: u64 = 900;
/// Retry no fallback (`FALLBACK_RETRY_MS` do TS): a vida do fallback é curta
/// de propósito, porque no boot o Jackett sobe depois.
const FALLBACK_RETRY_MS: u64 = 30_000;
/// Piso do refresh vivo (o `Math.max(60_000, ttl)` do TS).
const LIVE_FLOOR_MS: u64 = 60_000;
/// Rótulo do card virtual (o `catalogEntry` de `src/providers/mico.ts`).
const MICO_LABEL: &str = "Mico Leão Dublado";

/// Fonte do catálogo injetável: produção consulta o Jackett via
/// `load_catalog`; o teste injeta um duplo que devolve fila pronta, sem rede.
pub(crate) trait CatalogFetch: Send + Sync {
    fn fetch(&self) -> Pin<Box<dyn Future<Output = CatalogSnapshot> + Send + '_>>;
}

/// Fetcher de produção: o client HTTP com o MESMO builder do `JackettClient`
/// (User-Agent `stremio-adom/1.0` da config) e a config `JACKETT_*` lida no
/// boot. A chave vai só na query e erro sai redigido — regra do
/// `adom_sources::jackett::catalog`, não desta fatia.
pub(crate) struct LiveFetch {
    http: reqwest::Client,
    config: JackettConfig,
}

impl LiveFetch {
    fn from_env(config: &JackettConfig) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder();
        let agent = config.user_agent.trim();
        if !agent.is_empty() {
            builder = builder.user_agent(agent);
        }
        let http = builder
            .build()
            .map_err(|err| format!("cliente HTTP do catálogo: {err}"))?;
        Ok(Self {
            http,
            config: config.clone(),
        })
    }
}

impl CatalogFetch for LiveFetch {
    fn fetch(&self) -> Pin<Box<dyn Future<Output = CatalogSnapshot> + Send + '_>> {
        Box::pin(load_catalog(&self.http, &self.config))
    }
}

/// TTL em ms a partir do valor cru da env (uso no boot; teste com valor
/// sintético). Segundos → ms com saturação; inválido/negativo é default — a
/// `num` do Node faz o mesmo com o `catalogTtl`.
fn ttl_ms_from(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1_000))
        .unwrap_or(TTL_DEFAULT_S * 1_000)
}

fn ttl_ms_from_env() -> u64 {
    ttl_ms_from(std::env::var(TTL_ENV).ok().as_deref())
}

fn now_u64() -> u64 {
    u64::try_from(adom_sources::now_ms()).unwrap_or(0)
}

/// Cache publicado + hora da gravação (o `cached`/`cachedAt` do TS).
struct Published {
    snapshot: CatalogSnapshot,
    cached_at: u64,
}

/// Estado do catálogo em processo: memo com TTL, task de refresh e a saída da
/// rota. O fallback do `.env` nasce com o hub — a rota nunca responde vazio.
pub(crate) struct CatalogHub {
    fetch: Arc<dyn CatalogFetch>,
    fallback: CatalogSnapshot,
    ttl_ms: u64,
    /// `config.jackett.apiKey` do TS: sem chave não há consulta nem task.
    has_key: bool,
    /// `MICO_ENABLED` no boot (o `config.mico.enabled` do TS).
    mico_enabled: bool,
    published: RwLock<Option<Published>>,
}

impl CatalogHub {
    pub(crate) fn new(
        fetch: Arc<dyn CatalogFetch>,
        fallback: CatalogSnapshot,
        ttl_ms: u64,
        has_key: bool,
        mico_enabled: bool,
    ) -> Self {
        Self {
            fetch,
            fallback,
            ttl_ms,
            has_key,
            mico_enabled,
            published: RwLock::new(None),
        }
    }

    /// O `cacheTtlMs` do TS: fallback COM chave recarrega em 30 s; sem chave
    /// (nada vai refrescar mesmo) ou `live`, o TTL cheio.
    fn ttl_effective(&self, source: CatalogSource) -> u64 {
        if source == CatalogSource::Fallback && self.has_key {
            self.ttl_ms.min(FALLBACK_RETRY_MS)
        } else {
            self.ttl_ms
        }
    }

    /// O memo do `load` do TS: publicado dentro do TTL efetivo não refresca.
    fn needs_refresh(&self, now_ms: u64) -> bool {
        let guard = self.published.read().unwrap_or_else(|err| err.into_inner());
        match guard.as_ref() {
            Some(entry) => {
                now_ms.saturating_sub(entry.cached_at) >= self.ttl_effective(entry.snapshot.source)
            }
            None => true,
        }
    }

    /// Próxima espera do `tick` do TS: fallback → 30 s; vivo → `max(60 s, TTL)`.
    fn next_wait_ms(&self, source: CatalogSource) -> u64 {
        match source {
            CatalogSource::Live => self.ttl_ms.max(LIVE_FLOOR_MS),
            CatalogSource::Fallback => FALLBACK_RETRY_MS,
        }
    }

    /// Publica o snapshot (o `.then` do `load` do TS: grava + hora). A hora é
    /// parâmetro para o teste mandar no relógio.
    fn publish(&self, snapshot: CatalogSnapshot, cached_at: u64) {
        *self
            .published
            .write()
            .unwrap_or_else(|err| err.into_inner()) = Some(Published {
            snapshot,
            cached_at,
        });
    }

    /// Um tick do `startAutoRefresh` do TS: refresca se o memo expirou e
    /// devolve `(foi live?, quanto esperar pelo próximo)`. Sem chave devolve
    /// `(false, ttl)` sem tocar rede — o TS nem agenda a task nesse caso.
    pub(crate) async fn tick(&self) -> (bool, u64) {
        if !self.has_key {
            return (false, self.ttl_ms);
        }
        if !self.needs_refresh(now_u64()) {
            // Memo fresco (tick colidindo com refresh recente): o resultado
            // vigente manda, como o `load` devolveria do cache.
            let guard = self.published.read().unwrap_or_else(|err| err.into_inner());
            let source = guard
                .as_ref()
                .map(|entry| entry.snapshot.source)
                .unwrap_or(CatalogSource::Fallback);
            return (source == CatalogSource::Live, self.next_wait_ms(source));
        }
        let snapshot = self.fetch.fetch().await;
        let live = snapshot.source == CatalogSource::Live;
        let wait = self.next_wait_ms(snapshot.source);
        self.publish(snapshot, now_u64());
        (live, wait)
    }

    /// A task do boot (o `void tick()` do TS): roda até o fim do processo.
    /// Diferença assumida: o TS resolve uma promessa no primeiro vivo (quem
    /// gera URL espera até 60 s); aqui ninguém bloqueia boot por catálogo —
    /// o painel lê a rota quando abre.
    pub(crate) async fn refresh_loop(self: Arc<Self>) {
        loop {
            let (_, wait) = self.tick().await;
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
    }

    /// Snapshot vigente: o publicado ou, antes do primeiro tick, o fallback do
    /// `.env` com que o hub nasceu (a rota nunca fica sem resposta).
    fn current(&self) -> CatalogSnapshot {
        self.published
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
            .map(|entry| entry.snapshot.clone())
            .unwrap_or_else(|| self.fallback.clone())
    }
}

fn hub_slot() -> &'static OnceLock<Arc<CatalogHub>> {
    static SLOT: OnceLock<Arc<CatalogHub>> = OnceLock::new();
    &SLOT
}

/// Instala o hub do processo; o gateway chama UMA vez no boot.
fn install(hub: Arc<CatalogHub>) -> bool {
    hub_slot().set(hub).is_ok()
}

fn hub() -> Option<&'static Arc<CatalogHub>> {
    hub_slot().get()
}

/// O `withVirtual` do TS: card do Mico no fim quando `MICO_ENABLED` e nenhum
/// indexer do Jackett se chama "mico". `virtual:true` separa o card da prova
/// de vida — catálogo vivo só com ele continua "Jackett sem indexer" no
/// painel. Os cards da coleta saem sem o campo (o `virtual` é do Mico).
fn with_virtual(cards: &[CatalogCard], mico_enabled: bool) -> Vec<Value> {
    let mut out: Vec<Value> = cards
        .iter()
        .map(|card| serde_json::to_value(card).unwrap_or(Value::Null))
        .collect();
    if mico_enabled && cards.iter().all(|card| card.id != MICO_ID) {
        out.push(json!({
            "id": MICO_ID,
            "label": MICO_LABEL,
            "language": "pt-BR",
            "isBr": true,
            "virtual": true,
        }));
    }
    out
}

/// Payload da rota `GET /indexers/catalog`: `{ok, cards, source}` com cards
/// `id/label/language/isBr` (+ `virtual` só no Mico) e a procedência da
/// coleta. Sem hub (admin sem o spawn do gateway) devolve vazio com
/// `fallback` — nunca inventa medição.
fn payload_for(hub: Option<&Arc<CatalogHub>>) -> Value {
    match hub {
        Some(hub) => {
            let snapshot = hub.current();
            json!({
                "ok": true,
                "cards": with_virtual(&snapshot.cards, hub.mico_enabled),
                "source": snapshot.source,
            })
        }
        None => json!({ "ok": true, "cards": [], "source": "fallback" }),
    }
}

pub(crate) fn route_payload() -> Value {
    payload_for(hub())
}

/// Rotas do catálogo montadas no MESMO roteador da admin (o `auth` de lá —
/// loopback, token, 503 sem token — cobre tudo; aqui não existe servidor novo,
/// padrão do warmer). O handler não toca rede: só lê o snapshot publicado.
pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new().route("/indexers/catalog", axum::routing::get(indexer_catalog))
}

async fn indexer_catalog() -> Response {
    Json(route_payload()).into_response()
}

/// Boot do catálogo no gateway: instala o hub com o fallback do `.env` e
/// agenda a task de refresh — só COM chave, o mesmo corte do
/// `startAutoRefresh`. Falha de nada derruba o gateway: sem hub a rota
/// responde vazio/fallback.
pub(crate) fn spawn_from_env() {
    let config = JackettConfig::from_env();
    let has_key = config.has_api_key();
    // Falha de build do client é anormal (TLS interno); loga e segue sem hub:
    // a rota responde vazio/fallback, nunca derruba o gateway.
    let Ok(fetcher) = LiveFetch::from_env(&config) else {
        eprintln!("[jackett] catálogo sem client HTTP; só o fallback do .env na rota");
        return;
    };
    let hub = Arc::new(CatalogHub::new(
        Arc::new(fetcher),
        CatalogSnapshot {
            cards: fallback_catalog(
                &config.indexers,
                &config.pt_br_indexers,
                &config.slow_indexers,
            ),
            source: CatalogSource::Fallback,
        },
        ttl_ms_from_env(),
        has_key,
        MicoConfig::from_env().enabled,
    ));
    if !install(hub.clone()) {
        return;
    }
    if has_key {
        tokio::spawn(hub.refresh_loop());
        eprintln!(
            "[jackett] catálogo de indexers em refresh (TTL {}s)",
            ttl_ms_from_env() / 1_000
        );
    } else {
        eprintln!("[jackett] catálogo sem JACKETT_API_KEY: só o fallback do .env");
    }
}

#[cfg(test)]
#[path = "catalog_admin_route_tests.rs"]
mod route_tests;
#[cfg(test)]
#[path = "catalog_admin_tests.rs"]
mod tests;
