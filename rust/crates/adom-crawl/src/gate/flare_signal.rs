//! Sinal EXTERNO de FlareSolverr ocupado para o executor de portões (Fase 2.2).
//!
//! O solver é UM no container e atende um pedido por vez; até aqui o executor
//! só enxergava o ocupado do PRÓPRIO processo (sonda local, `FlareProbe`) e
//! podia disparar o pagamento (~30s de solver) em cima de uma busca ao vivo do
//! usuário. Esta ponte pergunta à admin do gateway (`GET /flare/busy` na 8711,
//! MESMO token da invalidação de streams) se há pedido do solver em voo do lado
//! de lá, e o `run_round` combina as duas fontes:
//! `flare.flare_busy() (local) || external_flare_busy() (esta ponte)`.
//!
//! Contrato de falha: fail-open SEMPRE — erro, timeout, rota ausente e corpo
//! estranho devolvem `false` (o portão segue como livre). Uma ponte que
//! bloqueasse por defeito próprio seria pior que nenhuma ponte: a sonda local
//! do motor continua valendo independentemente desta.
//!
//! Custo: timeout TOTAL curto (250 ms) e cache do resultado — sucesso OU
//! falha — por 1,5 s. A rodada do executor é ~1 s: sem cache, cada decisão
//! martelaria a admin; com ele, no máximo ~1 consulta por rodada.
//!
//! Teto: ceder por este sinal NÃO debita `gate_hourly` (a rodada morre antes
//! de tomar linha). O teto por site do BLUDV (o "teto em 120" do plano) é o
//! RITMO do motor — régua de outro agente; daqui só sai a garantia de que o
//! portão não entra na fila do solver quando ele está ocupado de verdade
//! (enfileirado, o callback chega `too_fast` ou `outro_navegador`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use reqwest::Client;
use serde::Deserialize;

use super::{GateExecutor, GateExecutorConfig};
use crate::motor::types::now_ms;

/// Admin do gateway (`adom-server::store_admin`) no loopback do container —
/// nunca hostname de container.
pub(crate) const DEFAULT_ADMIN_URL: &str = "http://127.0.0.1:8711";
/// A MESMA env da ponte de invalidação (`adom-crawl::ingest::native`): uma
/// só env governa onde o sidecar acha a admin do gateway.
const URL_ENV: &str = "STREAM_STORE_ADMIN_URL";
/// Primeiro elo da cadeia do token (a precedência completa está em
/// [`token_from_lookup`]).
const TOKEN_ENV: &str = "STREAM_STORE_ADMIN_TOKEN";
/// O MESMO header que a camada `auth` da admin exige.
pub(crate) const TOKEN_HEADER: &str = "x-indexer-test-token";
/// Prazo TOTAL do sinal: é decisão de freio, não I/O de pagamento — na faixa
/// 200-300 ms da Fase 2.2; estourar é fail-open.
const ADMIN_TIMEOUT_MS: u64 = 250;
/// Cache do resultado (ocupado OU livre, sucesso OU falha): 1,5 s evita que a
/// rodada (~1 s) martele a admin e fica na faixa 1-2 s da Fase 2.2.
const BUSY_CACHE_TTL_MS: u64 = 1_500;

/// O que a admin responde: `{"busy": bool}`. Campo ausente/estranho vira
/// `false` — o default do bool já é o fail-open.
#[derive(Deserialize)]
struct FlareBusyBody {
    #[serde(default)]
    busy: bool,
}

/// Cache do último resultado com o relógio da leitura.
struct CacheHit {
    busy: bool,
    at_ms: i64,
}

/// Ponte da admin do gateway: `busy()` devolve o sinal externo com cache e
/// fail-open. Montada pela config do executor (`from_config`); sem credencial
/// não há ponte (e sem rede).
pub(crate) struct ExternalFlareSignal {
    client: Client,
    endpoint: String,
    token: String,
    cache_ttl_ms: u64,
    cache: StdMutex<Option<CacheHit>>,
    /// Um aviso por rajada de falha: a rodada é ~1 s e a admin fora do ar não
    /// pode virar spam — e o log NUNCA mostra o token (só o endpoint).
    fail_logged: AtomicBool,
}

impl ExternalFlareSignal {
    pub(crate) fn new(
        base_url: &str,
        token: impl Into<String>,
        timeout_ms: u64,
        cache_ttl_ms: u64,
    ) -> Self {
        // Builder não falha em HTTP puro de loopback; o default cobre mesmo assim.
        let client = Client::builder()
            .timeout(Duration::from_millis(timeout_ms.max(1)))
            .build()
            .unwrap_or_default();
        Self {
            client,
            endpoint: format!("{}/flare/busy", base_url.trim().trim_end_matches('/')),
            token: token.into().trim().to_string(),
            cache_ttl_ms: cache_ttl_ms.max(1),
            cache: StdMutex::new(None),
            fail_logged: AtomicBool::new(false),
        }
    }

    /// Ponte montada da config do executor: `Some` só com credencial — sem
    /// token a admin recusaria tudo (401) e a ponte seria fail-open gastando
    /// rede à toa; `None` é o mesmo fail-open sem o custo.
    pub(crate) fn from_config(cfg: &GateExecutorConfig) -> Option<Arc<Self>> {
        if cfg.flare_admin_token.trim().is_empty() {
            return None;
        }
        Some(Arc::new(Self::new(
            &cfg.flare_admin_url,
            &cfg.flare_admin_token,
            ADMIN_TIMEOUT_MS,
            BUSY_CACHE_TTL_MS,
        )))
    }

    /// Ocupado segundo a admin, com cache curto. `false` SEMPRE significa
    /// "pode pagar": é o fail-open do contrato.
    pub(crate) async fn busy(&self) -> bool {
        if let Some(busy) = self.cached() {
            return busy;
        }
        let busy = self.probe().await;
        let mut guard = self.cache.lock().expect("lock do cache do sinal");
        *guard = Some(CacheHit {
            busy,
            at_ms: now_ms(),
        });
        drop(guard);
        busy
    }

    /// Cache ainda quente? Guarda também o resultado de FALHA: admin fora do
    /// ar não vira consulta nova a cada rodada.
    fn cached(&self) -> Option<bool> {
        let guard = self.cache.lock().expect("lock do cache do sinal");
        let hit = guard.as_ref()?;
        (now_ms() - hit.at_ms < self.cache_ttl_ms as i64).then_some(hit.busy)
    }

    /// UMA consulta à admin. Erro de qualquer natureza é `false`.
    async fn probe(&self) -> bool {
        if self.token.is_empty() {
            // Uso direto sem credencial (teste/diagnóstico): nem rede.
            return false;
        }
        let pedido = self
            .client
            .get(&self.endpoint)
            // Credencial SÓ no header (o mesmo `X-Indexer-Test-Token` da
            // admin); nunca na query, nunca em log.
            .header(TOKEN_HEADER, &self.token)
            .send()
            .await;
        match pedido {
            Ok(resp) if resp.status().is_success() => {
                self.fail_logged.store(false, Ordering::Relaxed);
                match resp.json::<FlareBusyBody>().await {
                    Ok(body) => body.busy,
                    Err(err) => {
                        self.note_failure(format!("corpo do /flare/busy: {err}"));
                        false
                    }
                }
            }
            Ok(resp) => {
                // 401/404/503...: admin recusando (gateway velho sem a rota,
                // token fora de sintonia) — fail-open.
                self.note_failure(format!("HTTP {}", resp.status().as_u16()));
                false
            }
            Err(err) => {
                // Timeout/conexão recusada: admin fora. Fail-open.
                self.note_failure(err.to_string());
                false
            }
        }
    }

    fn note_failure(&self, motivo: String) {
        if !self.fail_logged.swap(true, Ordering::Relaxed) {
            eprintln!(
                "[gate] sinal flare da admin ({}) indisponível ({motivo}); portão segue como livre",
                self.endpoint
            );
        }
    }
}

// ─── Ambiente (mesma régua da ponte de invalidação) ─────────────────────────

/// URL da admin: `STREAM_STORE_ADMIN_URL` vence, default no loopback.
pub(super) fn admin_url_from_env() -> String {
    env_or(URL_ENV, DEFAULT_ADMIN_URL)
}

/// Token da admin: a MESMA cadeia do `store_admin`; vazia, cai para o token
/// unificado do sidecar (`motor.admin_token` — cobre o alias `ADMIN_TOKEN`).
pub(super) fn admin_token_from_env(fallback: &str) -> String {
    let chain = token_from_lookup(|key| std::env::var(key).ok());
    if chain.is_empty() {
        return fallback.trim().to_string();
    }
    chain
}

/// `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`.
/// A MESMA precedência de `adom-server::store_admin` (gateway) e de
/// `adom-crawl::ingest::native` (invalidação): os três lados têm que achar o
/// MESMO valor. Vazio/ausente não vence.
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

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

// ─── A metade externa do freio da rodada ────────────────────────────────────

impl GateExecutor {
    /// O segundo termo do `||` do `run_round`: `true` só com a admin
    /// respondendo `{"busy":true}` dentro do prazo. Sem ponte montada ou com
    /// a ponte falhando, `false` — o portão nunca fica refém do sinal.
    pub(super) async fn external_flare_busy(&self) -> bool {
        match &self.flare_signal {
            Some(signal) => signal.busy().await,
            None => false,
        }
    }
}
