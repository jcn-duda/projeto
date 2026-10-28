//! Config, painel e canal do worker NATIVO do Chupim.
//!
//! Esta leva sobe o ciclo INTEIRO (cofre, enfileiramento, recheck, dreno) atrás
//! da trava `AUTOFETCH_WORKER=on`. Sem a trava — e sem fábrica de debrid — o
//! worker fica `prepared`: nenhum canal existe, nenhum lote é escrito e
//! `GET /autofetch` continua contando o que o KV já tinha no boot. A fábrica de
//! produção é montada no boot (`boot::spawn_at`, quando a trava está ligada) e
//! `spawn_with(Some(..))` injeta uma pronta para teste.
//!
//! O que o KV guarda aqui é SÓ `autofetch-worker:v1:config` (`paused` +
//! `intervalMs`). A chave do usuário vive no cofre em RAM (`vault.rs`) e não
//! atravessa este módulo: o status é montado de contadores, nunca de credencial.

use std::sync::{Arc, Mutex, OnceLock};

use adom_index::NativeKv;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::enqueue::Job;
use super::serve::{self, Control, DebridFactory, Message, Snapshot};
use super::vault::Vault;
use super::{worker_enabled, Policy, LOT_PREFIX, QUEUE_PREFIX};
use crate::harvest::HarvestHandle;

// O overlay da config ao vivo (`cfg:v1:autofetch`) mora em arquivo próprio pela
// catraca de 400: é a régua que o `Policy::from_env()` congelava no boot.
#[path = "live.rs"]
pub(super) mod live;

const CONFIG_KEY: &str = "autofetch-worker:v1:config";
const CONFIG_TTL_SECONDS: i64 = 10 * 365 * 24 * 60 * 60;
const DEFAULT_INTERVAL_MS: u64 = 60_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerConfig {
    pub(crate) paused: bool,
    pub(crate) interval_ms: u64,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            paused: false,
            interval_ms: DEFAULT_INTERVAL_MS,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutofetchStatus {
    /// `AUTOFETCH_WORKER=on` E adaptador presente. `false` = nada consome canal.
    pub(crate) enabled: bool,
    /// `prepared` | `paused` | `active` (`unavailable` é da rota sem worker).
    pub(crate) phase: &'static str,
    pub(crate) paused: bool,
    pub(crate) queue_depth: usize,
    pub(crate) lots: usize,
    pub(crate) inflight: bool,
    pub(crate) interval_ms: u64,
    /// Lotes processados desde o boot (a passagem do ciclo).
    pub(crate) processed: u64,
    /// Motivo de desistência → contagem (`autofetch.skip.<motivo>`).
    pub(crate) skips: std::collections::BTreeMap<String, usize>,
    /// Última falha da passagem. Nunca carrega chave: o erro nasce de store/rede
    /// e o cofre não entra na mensagem.
    pub(crate) last_error: Option<String>,
    /// Contas no cofre (contagem REDIGIDA: nem o escopo `sha256` sai daqui).
    pub(crate) vault_accounts: usize,
}

/// Retrato da fila lido UMA vez no boot. O ciclo atualiza os contadores, não
/// esta foto: `queueDepth`/`lots` continuam sendo o que o KV tinha ao subir.
#[derive(Clone, Copy, Debug, Default)]
struct Hydrated {
    queue_depth: usize,
    lots: usize,
}

struct Inner {
    kv: Arc<NativeKv>,
    config: Mutex<WorkerConfig>,
    hydrated: Hydrated,
    enabled: bool,
    vault: Option<Arc<Vault>>,
    control: Option<Arc<Control>>,
    tx: Option<mpsc::Sender<Message>>,
    /// Colhedor nativo: nasce DEPOIS do worker em `proxy::run` (o colhedor
    /// precisa do orquestrador, que precisa do tail, que precisa deste handle).
    /// O slot é preenchido uma vez pelo boot; vazio = `br_probe` volta ao Node.
    harvest: Arc<OnceLock<HarvestHandle>>,
}

impl Inner {
    fn snapshot(&self) -> Snapshot {
        self.control
            .as_ref()
            .map(|control| control.snapshot())
            .unwrap_or_default()
    }
}

#[derive(Clone)]
pub(crate) struct AutofetchHandle {
    inner: Arc<Inner>,
}

impl AutofetchHandle {
    /// Handle de admin sem ciclo: `prepared`, sem canal e sem fábrica. Só os
    /// testes usam (o boot sem laço passa por [`spawn_with`] com `None`).
    #[cfg(test)]
    pub(super) fn with_store(kv: Arc<NativeKv>) -> Self {
        Self::build(kv, &Policy::from_env(), super::vault::shared(), None)
    }

    /// Handle completo. `enabled` exige a trava E a fábrica por conta: sem os
    /// dois o canal nem é criado (`submit` devolve `false`).
    pub(crate) fn build(
        kv: Arc<NativeKv>,
        policy: &Policy,
        vault: Option<Arc<Vault>>,
        debrid: Option<DebridFactory>,
    ) -> Self {
        // O laço RELÊ o painel a cada passagem (`serve::engine_for_pass`), então a
        // base que ele recebe é a env PURA. Passar a foto do boot aqui faria uma
        // chave REMOVIDA do painel (`reset`) continuar valendo até o restart. O
        // overlay ainda é lido agora porque ele soma a PAUSA ao `Control`.
        let (config, _overlay) = load_effective(&kv);
        let hydrated = hydrate(&kv);
        let base = *policy;
        let wanted = worker_enabled() && debrid.is_some();
        let (tx, rx) = if wanted {
            let (tx, rx) = mpsc::channel(serve::CHANNEL_CAPACITY);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let control = wanted.then(|| Arc::new(Control::new(config.paused, config.interval_ms)));
        let harvest = Arc::new(OnceLock::new());
        let mut enabled = wanted;
        if let (Some(rx), Some(control), Some(debrid)) = (rx, control.clone(), debrid) {
            if let Err(err) = serve::spawn(
                Arc::clone(&kv),
                base,
                vault.clone(),
                debrid,
                rx,
                control,
                Arc::clone(&harvest),
            ) {
                // Sem laço o status NÃO pode dizer `active`: o canal morreria
                // cheio em silêncio.
                eprintln!("[autofetch] laço não iniciou: {err}; worker fica prepared");
                enabled = false;
            }
        }
        Self {
            inner: Arc::new(Inner {
                kv,
                config: Mutex::new(config),
                hydrated,
                enabled,
                vault,
                control: enabled.then_some(control).flatten(),
                tx,
                harvest,
            }),
        }
    }

    /// Handle LIGADO sem laço: só os testes usam, para provar o contrato do
    /// status (`enabled`, `inflight`, `lastError`, skips) sem subir thread nem
    /// depender de `AUTOFETCH_WORKER` no ambiente do processo.
    #[cfg(test)]
    pub(crate) fn stub_enabled(
        kv: Arc<NativeKv>,
        vault: Option<Arc<Vault>>,
        control: Arc<Control>,
    ) -> Self {
        let (config, _) = load_effective(&kv);
        let hydrated = hydrate(&kv);
        Self {
            inner: Arc::new(Inner {
                kv,
                config: Mutex::new(config),
                hydrated,
                enabled: true,
                vault,
                control: Some(control),
                tx: None,
                harvest: Arc::new(OnceLock::new()),
            }),
        }
    }

    /// Foto em memória: o `GET /autofetch` não toca SQLite.
    pub(crate) fn status(&self) -> AutofetchStatus {
        let config = self.config();
        let snapshot = self.inner.snapshot();
        AutofetchStatus {
            enabled: self.inner.enabled,
            phase: phase_of(self.inner.enabled, config.paused),
            paused: config.paused,
            queue_depth: self.inner.hydrated.queue_depth,
            lots: self.inner.hydrated.lots,
            inflight: snapshot.inflight,
            interval_ms: config.interval_ms,
            processed: snapshot.processed,
            skips: snapshot.skips,
            last_error: snapshot.last_error,
            vault_accounts: self
                .inner
                .vault
                .as_ref()
                .map(|vault| vault.len())
                .unwrap_or(0),
        }
    }

    pub(crate) fn config(&self) -> WorkerConfig {
        self.inner
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub(crate) fn update(&self, config: WorkerConfig) -> Result<AutofetchStatus, String> {
        let value = serde_json::to_value(&config).map_err(|err| err.to_string())?;
        let now = adom_sources::now_ms();
        let mut current = self
            .inner
            .config
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        self.inner
            .kv
            .put_json(CONFIG_KEY, &value, CONFIG_TTL_SECONDS, now)?;
        *current = config.clone();
        drop(current);
        if let Some(control) = self.inner.control.as_ref() {
            control.set_paused(config.paused);
            control.set_interval_ms(config.interval_ms);
            control.wake();
        }
        Ok(self.status())
    }

    /// Registra o colhedor nativo no slot (uma vez, no boot). `false` = já
    /// havia um colhedor: o primeiro vence, nunca há dois donos.
    pub(crate) fn set_harvest(&self, handle: HarvestHandle) -> bool {
        self.inner.harvest.set(handle).is_ok()
    }

    /// Colhedor nativo, quando o boot já o registrou.
    pub(crate) fn harvest(&self) -> Option<&HarvestHandle> {
        self.inner.harvest.get()
    }

    /// Publica um lote no canal do laço. `false` = worker desligado, sem canal
    /// ou fila cheia — quem publica decide o que fazer (hoje: nada).
    ///
    /// A ponte `autofetch` → `submit` no orquestrador é da leva do flip; até
    /// lá só os testes usam este caminho.
    #[allow(dead_code)]
    pub(crate) fn submit(&self, job: Job) -> bool {
        let Some(tx) = self.inner.tx.as_ref() else {
            return false;
        };
        if tx.try_send(Message::Batch(job)).is_err() {
            return false;
        }
        if let Some(control) = self.inner.control.as_ref() {
            control.wake();
        }
        true
    }

    /// Pede ao laço um dreno administrativo. `false` = não há laço.
    pub(crate) fn request_drain(&self) -> bool {
        let Some(tx) = self.inner.tx.as_ref() else {
            return false;
        };
        if tx.try_send(Message::Drain).is_err() {
            return false;
        }
        if let Some(control) = self.inner.control.as_ref() {
            control.wake();
        }
        true
    }
}

fn phase_of(enabled: bool, paused: bool) -> &'static str {
    match (enabled, paused) {
        (false, _) => "prepared",
        (true, true) => "paused",
        (true, false) => "active",
    }
}

pub(crate) fn spawn() -> Option<AutofetchHandle> {
    spawn_with(None)
}

/// Boot do ciclo. `Some(factory)` injeta a fábrica (teste); `None` monta a de
/// PRODUÇÃO quando `AUTOFETCH_WORKER=on` — sem a trava nada muda: `prepared`.
pub(crate) fn spawn_with(debrid: Option<DebridFactory>) -> Option<AutofetchHandle> {
    super::boot::spawn_at(
        &adom_store::default_cache_db_path(),
        super::vault::shared(),
        debrid,
    )
}

/// Leitura única (boot): profundidade da fila e lotes de recheck persistidos.
/// Falha vira 0 com log — status de painel nunca derruba o gateway.
fn hydrate(kv: &NativeKv) -> Hydrated {
    let now = adom_sources::now_ms();
    Hydrated {
        queue_depth: count_prefix(kv, QUEUE_PREFIX, now),
        lots: count_prefix(kv, LOT_PREFIX, now),
    }
}

/// Conta chaves vivas pelo prefixo com o `keys_matching` do store (o mesmo
/// `kvKeys` do Node), sem abrir SQLite à mão. A varredura poda as expiradas;
/// nenhuma linha é criada.
fn count_prefix(kv: &NativeKv, prefix: &str, now_ms: i64) -> usize {
    match kv.keys_matching(prefix, now_ms) {
        Ok(keys) => keys.len(),
        Err(err) => {
            eprintln!("[autofetch] leitura de {prefix}* falhou ({err}); contando 0");
            0
        }
    }
}

fn load_config(kv: &NativeKv) -> WorkerConfig {
    match kv.get_json(CONFIG_KEY, adom_sources::now_ms()) {
        Ok(Some(value)) => serde_json::from_value(value).unwrap_or_default(),
        Ok(None) => WorkerConfig::default(),
        Err(err) => {
            eprintln!("[autofetch] config persistida ilegível; usando defaults: {err}");
            WorkerConfig::default()
        }
    }
}

/// O par persistido (`paused`/`intervalMs`) + o overlay do painel, lidos UMA vez
/// no boot. Devolve o overlay junto porque o `Policy` do laço nasce dele.
///
/// A pausa do painel (`cfg:v1:autofetch`) só SOMA: o botão grava as duas
/// chaves, mas uma pausa esquecida no KV do Node não pode sumir no restart. Na
/// direção contrária quem manda é a admin (`update`), senão o
/// `POST /autofetch/pause {paused:false}` nunca retomaria o worker.
pub(super) fn load_effective(kv: &NativeKv) -> (WorkerConfig, Option<live::LiveOverlay>) {
    let mut config = load_config(kv);
    let overlay = live::LiveOverlay::load(kv, adom_sources::now_ms());
    if overlay.as_ref().is_some_and(|live| live.paused) {
        config.paused = true;
    }
    (config, overlay)
}

pub(crate) fn parse_config(
    body: &serde_json::Value,
    current: &WorkerConfig,
) -> Option<WorkerConfig> {
    let object = body.as_object()?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "paused" | "intervalMs"))
    {
        return None;
    }
    let paused = match object.get("paused") {
        Some(value) => value.as_bool()?,
        None => current.paused,
    };
    let interval_ms = match object.get("intervalMs") {
        Some(value) => value.as_u64().filter(|ms| (1..=3_600_000).contains(ms))?,
        None => current.interval_ms,
    };
    Some(WorkerConfig {
        paused,
        interval_ms,
    })
}
