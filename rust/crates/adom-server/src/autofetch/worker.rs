use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_index::NativeKv;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

const CONFIG_KEY: &str = "autofetch-worker:v1:config";
const CONFIG_TTL_SECONDS: i64 = 10 * 365 * 24 * 60 * 60;
const DEFAULT_INTERVAL_MS: u64 = 60_000;
/// Prefixos de dono do Chupim que o retrato do boot lê. São os mesmos que o
/// Node e a ponte napi usam: fila por busca (`queue_key`) e lote de recheck
/// persistido (`autofetch_v3_lot_write`).
const QUEUE_PREFIX: &str = "autofetch:v3:q:";
const LOT_PREFIX: &str = "autofetch:v3:lot:";

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
    pub(crate) enabled: bool,
    pub(crate) phase: &'static str,
    pub(crate) paused: bool,
    pub(crate) queue_depth: usize,
    pub(crate) lots: usize,
    pub(crate) inflight: bool,
    pub(crate) interval_ms: u64,
}

/// Retrato da fila lido UMA vez no boot. Esta fatia não consome nem escreve:
/// o número é o que o KV nativo já tinha quando o gateway subiu.
#[derive(Clone, Copy, Debug, Default)]
struct Hydrated {
    queue_depth: usize,
    lots: usize,
}

struct Inner {
    kv: Arc<NativeKv>,
    config: Mutex<WorkerConfig>,
    hydrated: Hydrated,
    notify: Notify,
}

#[derive(Clone)]
pub(crate) struct AutofetchHandle {
    inner: Arc<Inner>,
}

impl AutofetchHandle {
    pub(super) fn with_store(kv: Arc<NativeKv>) -> Self {
        let config = load_config(&kv);
        let hydrated = hydrate(&kv);
        Self {
            inner: Arc::new(Inner {
                kv,
                config: Mutex::new(config),
                hydrated,
                notify: Notify::new(),
            }),
        }
    }

    /// Foto em memória: o `GET /autofetch` não toca SQLite. `queue_depth`/`lots`
    /// vêm da hidratação do boot — o ciclo que os atualiza é da fase B.
    pub(crate) fn status(&self) -> AutofetchStatus {
        let config = self.config();
        AutofetchStatus {
            // Phase B liga a fila e o executor. Não há caminho que habilite
            // downloads ou consuma entradas nesta fatia.
            enabled: false,
            phase: "prepared",
            paused: config.paused,
            queue_depth: self.inner.hydrated.queue_depth,
            lots: self.inner.hydrated.lots,
            inflight: false,
            interval_ms: config.interval_ms,
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
        self.inner.notify.notify_one();
        Ok(self.status())
    }
}

pub(crate) fn spawn() -> Option<AutofetchHandle> {
    let path = adom_store::default_cache_db_path();
    let kv = match NativeKv::open(&path) {
        Ok(kv) => Arc::new(kv),
        Err(err) => {
            eprintln!(
                "[autofetch] controle indisponível ({}): {err}; worker permanece ausente",
                path.display()
            );
            return None;
        }
    };
    let handle = AutofetchHandle::with_store(kv);
    let inner = handle.inner.clone();
    let thread_inner = inner;
    let thread = std::thread::Builder::new()
        .name("adom-autofetch".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    eprintln!("[autofetch] runtime idle não iniciou: {err}");
                    return;
                }
            };
            runtime.block_on(async move {
                loop {
                    let interval = thread_inner
                        .config
                        .lock()
                        .unwrap_or_else(|err| err.into_inner())
                        .interval_ms
                        .max(1);
                    tokio::select! {
                        _ = thread_inner.notify.notified() => {},
                        _ = tokio::time::sleep(Duration::from_millis(interval)) => {},
                    }
                    // Sem consumir filas nesta etapa. A fase B liga o ciclo de
                    // escolha, validação de credencial e execução.
                }
            });
        });
    if let Err(err) = thread {
        eprintln!("[autofetch] thread não iniciou: {err}");
        return None;
    }
    Some(handle)
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
