//! Fábrica de PRODUÇÃO do worker nativo: uma porta por serviço e UM gate RD.
//!
//! # O que cada serviço usa como fato
//!
//! - **AllDebrid** — guarda `adrm` lida do `cache.db` (somente leitura). Sem
//!   banco legível, nada é enviado (`GuardUnavailable`); `inventory_ready` vem
//!   do memo de inventário da conta (`cleanup_inventory::known_before`).
//! - **TorBox / Premiumize / DebridLink** — só a chave da conta; o cache é
//!   perguntado na hora ao serviço.
//! - **Real-Debrid** — gate AIMD do PROCESSO (um só, criado no boot) + intent
//!   durável ([`RdKvStore`]) + ledger `rdc:v2` para o `check`.
//!
//! # O que ficou fail-safe
//!
//! - `Provenance::Unavailable` na AllDebrid: "novo × pré-existente" é prova
//!   POR HASH e a fábrica só conhece a conta, então o worker nunca marca posse
//!   de magnet que não enviou (sem posse = a limpeza não apaga acervo).
//! - `inventory_ready` só é `true` quando o memo de inventário tem snapshot
//!   vigente para a conta; sem ele a guarda bloqueia (fail-closed).
//! - O ledger RD não tem veredito para hash novo: o lote sai recusado com
//!   `unknown-cache` em vez de chutar ⚡ (ver `docs` do `check` da porta).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use adom_debrid::alldebrid::{AllDebrid, Provenance};
use adom_debrid::alldebrid_cleanup::known_before;
use adom_debrid::autofetch_ports::{AlldebridFacts, AutofetchPorts, RdPorts};
use adom_debrid::debridlink::DebridLink;
use adom_debrid::premiumize::Premiumize;
use adom_debrid::rd_gate_executor::RdGateExecutor;
use adom_debrid::rd_scheduler::RdSchedulerConfig;
use adom_debrid::realdebrid::RealDebrid;
use adom_debrid::torbox::TorBox;
use adom_debrid::HttpClient;
use adom_index::NativeKv;

use super::ports::{self, AdapterBuilder, DebridFactory, DebridIo, PortedDebrid};
use super::rd_store::{self, RdKvStore};
use super::vault::Vault;

/// Os cinco serviços que a fábrica atende (o vocabulário de `Service::id`).
/// Só os testes iteram a lista: o `match` de [`Build::ports_for`] é a régua.
#[cfg(test)]
pub(crate) const SERVICES: [&str; 5] = [
    "alldebrid",
    "torbox",
    "premiumize",
    "realdebrid",
    "debridlink",
];

/// Peças de produção compartilhadas por TODAS as contas do processo.
pub(crate) struct Build {
    http: HttpClient,
    kv: Arc<NativeKv>,
    cache_db: PathBuf,
    /// UM por processo: o `RdScheduler` é o AIMD da conta, e duas instâncias
    /// fariam o gate mentir sobre gap/cooldown. Todo `RdPorts` recebe um clone
    /// deste mesmo executor.
    gate: RdGateExecutor,
    store: Arc<RdKvStore>,
    ledger: bool,
}

impl Build {
    /// `None` = sem cliente HTTP: o worker fica `prepared` (boot não quebra).
    pub(crate) fn new(kv: Arc<NativeKv>, cache_db: &Path) -> Option<Self> {
        let http = HttpClient::new()
            .map_err(|err| eprintln!("[autofetch] cliente HTTP do debrid indisponível: {err}"))
            .ok()?;
        Some(Self::assemble(
            http,
            kv,
            cache_db,
            gate_config(),
            rd_store::ledger_enabled(),
        ))
    }

    fn assemble(
        http: HttpClient,
        kv: Arc<NativeKv>,
        cache_db: &Path,
        config: RdSchedulerConfig,
        ledger: bool,
    ) -> Self {
        Self {
            http,
            gate: new_gate(config),
            store: Arc::new(RdKvStore::new(Arc::clone(&kv))),
            kv,
            cache_db: cache_db.to_path_buf(),
            ledger,
        }
    }

    /// Fábrica por conta: o laço chama isto a cada passo e a chave vem do
    /// cofre no momento do uso (`ports::factory`).
    pub(crate) fn factory(self: Arc<Self>, vault: Arc<Vault>) -> DebridFactory {
        let build = Arc::clone(&self);
        let builder: AdapterBuilder =
            Arc::new(move |service, api_key, scope| build.adapter(service, api_key, scope));
        ports::factory(vault, builder)
    }

    /// Adaptador de UMA conta. `None` = serviço fora dos cinco: o passo é
    /// pulado, nunca vira erro do lote.
    pub(crate) fn adapter(&self, service: &str, api_key: &str, scope: &str) -> Option<DebridIo> {
        let ports = self.ports_for(service, api_key, scope)?;
        Some(Arc::new(PortedDebrid::new(ports)))
    }

    fn ports_for(&self, service: &str, api_key: &str, scope: &str) -> Option<Arc<AutofetchPorts>> {
        let http = self.http.clone();
        let ports = match service {
            "alldebrid" => AutofetchPorts::alldebrid(
                Arc::new(AllDebrid::new(http)),
                api_key,
                self.alldebrid_facts(scope),
            ),
            "torbox" => AutofetchPorts::torbox(Arc::new(TorBox::new(http)), api_key),
            "premiumize" => AutofetchPorts::premiumize(Arc::new(Premiumize::new(http)), api_key),
            "realdebrid" => {
                let torrents = Arc::new(RealDebrid::new(http));
                let mut rd = RdPorts::new(torrents, self.gate.clone(), self.store.clone());
                if let Some(peek) = rd_store::ledger_peek(Arc::clone(&self.kv), self.ledger) {
                    rd = rd.with_ledger(peek);
                }
                AutofetchPorts::realdebrid(rd, api_key)
            }
            "debridlink" => AutofetchPorts::debridlink(Arc::new(DebridLink::new(http)), api_key),
            _ => return None,
        };
        Some(Arc::new(ports))
    }

    /// Fatos da guarda `adrm`: `cache.db` do processo + memo de inventário da
    /// conta (por `accountScope`, que é o sufixo do escopo do cofre).
    fn alldebrid_facts(&self, scope: &str) -> AlldebridFacts {
        let account = scope
            .split_once(':')
            .map(|(_, account)| account)
            .unwrap_or("");
        AlldebridFacts {
            db_path: Some(self.cache_db.clone()),
            inventory_ready: known_before(account).is_some(),
            // Fail-safe documentado: a fábrica não tem prova por hash, então
            // nenhum upload daqui reivindica posse de magnet pré-existente.
            provenance: Provenance::Unavailable,
        }
    }
}

/// Réguas do gate AIMD — os MESMOS nomes/defaults do warmer, para um `.env` só
/// governar as duas pontas do RD.
fn gate_config() -> RdSchedulerConfig {
    RdSchedulerConfig {
        min_gap_ms: env_num_f("DEBRID_RD_GATE_MIN_GAP_MS", 1_000.0),
        max_gap_ms: env_num_f("DEBRID_RD_GATE_MAX_GAP_MS", 30_000.0),
        cooldown_ms: env_num_f("DEBRID_RD_GATE_COOLDOWN_MS", 90_000.0),
        play_max_wait_ms: env_num_f("DEBRID_RD_GATE_PLAY_MAX_WAIT_MS", 1_500.0),
        success_threshold: 5,
        enabled: env_flag("DEBRID_RD_GATE"),
    }
}

/// Kill-switch do gate: só `true`/`false` explícitos importam (default LIGADO,
/// igual ao warmer — gate desligado é atalho de operador, não default).
fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

fn env_num_f(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| *value >= 0.0)
        .unwrap_or(default)
}

/// Contador de gates criados (só teste): prova que dois escopos RD compartilham
/// UM executor.
#[cfg(test)]
static GATES_BUILT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn new_gate(config: RdSchedulerConfig) -> RdGateExecutor {
    #[cfg(test)]
    GATES_BUILT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    RdGateExecutor::new(config)
}

/// Quantos `RdGateExecutor` o processo criou até agora.
#[cfg(test)]
pub(crate) fn gates_built() -> usize {
    GATES_BUILT.load(std::sync::atomic::Ordering::SeqCst)
}

/// Serializa os testes que mexem em env ou no contador global de gates.
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

/// Réguas fixas: nenhuma env do processo entra na conta do teste.
#[cfg(test)]
fn gate_fixture() -> RdSchedulerConfig {
    RdSchedulerConfig {
        min_gap_ms: 0.0,
        max_gap_ms: 0.0,
        cooldown_ms: 0.0,
        play_max_wait_ms: 0.0,
        success_threshold: 5,
        enabled: true,
    }
}

/// Fábrica de teste sobre um `cache.db` de fixture (ledger LIGADO).
#[cfg(test)]
pub(crate) fn fixture(kv: Arc<NativeKv>, cache_db: &Path) -> Arc<Build> {
    fixture_with(kv, cache_db, true)
}

/// Idem, com o ledger controlado pelo teste.
#[cfg(test)]
pub(crate) fn fixture_with(kv: Arc<NativeKv>, cache_db: &Path, ledger: bool) -> Arc<Build> {
    let http = HttpClient::new().expect("cliente HTTP de fixture");
    Arc::new(Build::assemble(http, kv, cache_db, gate_fixture(), ledger))
}

#[cfg(test)]
#[path = "build_tests.rs"]
mod tests;
