//! Parte de I/O da cobertura BR da coorte: leitores do `cache.db`, laço de
//! fundo e rota admin `GET /br-coverage`. A régua (ledger, davail, alive,
//! agregação, JSON) mora em `br_coverage.rs`; aqui só se abre o SQLite e se
//! agenda a varredura. Tudo lê; nada escreve em debrid.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use adom_core::{account_scope, ledger_key, normalize_hash, prefix};
use adom_debrid::Store;
use adom_index::{DavailStore, IndexedRelease, MagnetStateStore, NativeKv, ReleaseIndexStore};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::Value;

use crate::br_coverage::{
    apply, build_sample, enabled_now, ledger_of, parse_cohort, release_status, sample_ms,
    status_json, top_per_type, Ledger, ReleaseStatus, Sample, STATE,
};
use crate::store_admin::AdminState;

/// Chave da coorte no KV (`seed:v1:cohort`).
const COHORT_KEY: &str = "cohort";
/// Adapter da conta do operador: só o Real-Debrid entra na medida.
const ADAPTER: &str = "realdebrid";

/// Conta do operador da medida: só RD, com `envOperatorAccount` (ALLOW_ENV_KEY
/// ou OPERATOR_ENV_ACCOUNT) e chave. A chave fica só aqui, nunca na saída.
#[derive(Clone)]
pub struct Operator {
    pub key: String,
    pub scope: String,
}

/// Lê a conta do operador do env (`DEBRID_SERVICE`/`DEBRID_API_KEY`).
pub fn operator_from_env() -> Option<Operator> {
    let get = |name: &str| std::env::var(name).ok();
    let service = get("DEBRID_SERVICE").unwrap_or_default().to_lowercase();
    let allow_env_key = matches!(
        get("DEBRID_ALLOW_ENV_KEY").as_deref(),
        None | Some("") | Some("true")
    );
    let operator_env = get("DEBRID_OPERATOR_ENV_ACCOUNT").as_deref() == Some("true");
    let key = get("DEBRID_API_KEY").unwrap_or_default().trim().to_string();
    if service != ADAPTER || !(allow_env_key || operator_env) || key.is_empty() {
        return None;
    }
    let scope = account_scope(&Value::String(key.clone()));
    Some(Operator { key, scope })
}

/// Leitores do `cache.db`, abertos uma vez (o `ReleaseIndexStore::open` faz a
/// faxina do índice, então não se abre a cada varredura).
pub struct Readers {
    kv: NativeKv,
    index: ReleaseIndexStore,
    davail: DavailStore,
    mag: MagnetStateStore,
    /// Leitor read-only do ledger; `None` = ledger desligado ou arquivo sem ele.
    ledger: Option<Store>,
    operator: Option<Operator>,
}

impl Readers {
    pub fn open(path: &Path, operator: Option<Operator>, ledger_on: bool) -> Result<Self, String> {
        let kv = NativeKv::open(path)?;
        let index = ReleaseIndexStore::open(path)?;
        let davail = DavailStore::open(path)?;
        let mag = MagnetStateStore::open(path)?;
        let ledger = if ledger_on {
            Store::open_cache_db(path).ok()
        } else {
            None
        };
        Ok(Self {
            kv,
            index,
            davail,
            mag,
            ledger,
            operator,
        })
    }

    /// Abre no `cache.db` do processo (`CACHE_DB_PATH`) com o env atual.
    pub fn open_env() -> Result<Self, String> {
        let ledger_on = adom_debrid::verdict::rd_ledger_enabled();
        Self::open(
            &adom_store::default_cache_db_path(),
            operator_from_env(),
            ledger_on,
        )
    }

    /// Estado do ledger de UM hash: leitura quieta, nunca escreve.
    fn ledger_state(&self, hash: &str, now: i64) -> Ledger {
        let Some(store) = self.ledger.as_ref() else {
            return Ledger::Unknown;
        };
        if normalize_hash(hash).is_empty() {
            return Ledger::Unknown;
        }
        let stored = store
            .get(&ledger_key(hash), now)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("s").and_then(Value::as_str).map(String::from));
        ledger_of(stored.as_deref())
    }

    /// Veredito de UMA release, pelas três fontes.
    pub fn status_of(&self, rel: &IndexedRelease, now: i64) -> ReleaseStatus {
        let ledger = self.ledger_state(&rel.hash, now);
        let (davail, alive) = match self.operator.as_ref() {
            None => (None, false),
            Some(op) => {
                let hash = rel.hash.to_ascii_lowercase();
                let davail = self.davail.get(ADAPTER, &op.key, &hash, now).ok().flatten();
                let alive = self
                    .mag
                    .peek_mark_scoped("alive", ADAPTER, &op.scope, &hash, now)
                    .unwrap_or(false);
                (davail, alive)
            }
        };
        release_status(ledger, davail, alive)
    }

    /// Uma varredura. `Ok(None)` = sem coorte válida (zera o estado).
    pub fn sample(&self, now: i64) -> Result<Option<Sample>, String> {
        let key = format!("{}{COHORT_KEY}", prefix("seed"));
        let Some(raw) = self.kv.get_json(&key, now)? else {
            return Ok(None);
        };
        let top = top_per_type(std::env::var("F3_BR_TOP_PER_TYPE").ok().as_deref());
        let Some(cohort) = parse_cohort(&raw, top) else {
            return Ok(None);
        };
        let ids: Vec<String> = cohort
            .movies
            .iter()
            .chain(cohort.series.iter())
            .cloned()
            .collect();
        let snap = self.index.snapshot_works(&ids, now)?;
        Ok(Some(build_sample(&cohort, &snap, now, |rel| {
            self.status_of(rel, now)
        })))
    }
}

/// Um passo do laço: abre os leitores se faltam, varre e devolve os leitores
/// para o próximo passo. Falha de abertura não guarda nada (tenta de novo).
fn run_blocking(owned: Option<Readers>) -> (Option<Readers>, Result<Option<Sample>, String>) {
    let readers = match owned {
        Some(readers) => readers,
        None => match Readers::open_env() {
            Ok(readers) => readers,
            Err(err) => return (None, Err(err)),
        },
    };
    let out = readers.sample(adom_sources::now_ms());
    (Some(readers), out)
}

/// Sobe o laço de fundo: a primeira varredura é no boot, depois a cada
/// `F3_BR_SAMPLE_MS`. Desligado por env não cria tarefa nenhuma.
pub fn spawn_from_env() {
    if !enabled_now() {
        eprintln!("[br-coverage] desativado (F3_BR_ENABLED ou F3_ENABLED off)");
        return;
    }
    let every = Duration::from_millis(sample_ms(std::env::var("F3_BR_SAMPLE_MS").ok().as_deref()));
    tokio::spawn(async move {
        let mut readers: Option<Readers> = None;
        let mut ticker = tokio::time::interval(every);
        loop {
            ticker.tick().await;
            let owned = readers.take();
            match tokio::task::spawn_blocking(move || run_blocking(owned)).await {
                Ok((back, outcome)) => {
                    readers = back;
                    match outcome {
                        Ok(sample) => {
                            let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
                            apply(&mut state, sample);
                        }
                        Err(err) => eprintln!("[br-coverage] varredura falhou: {err}"),
                    }
                }
                Err(join) => eprintln!("[br-coverage] varredura falhou: {join}"),
            }
        }
    });
}

/// `GET /br-coverage`: estado da última varredura. A credencial é a do
/// middleware de `store_admin` (token de superfície, 401 sem ele).
async fn get_status() -> Response {
    let enabled = enabled_now();
    let body = {
        let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        status_json(&state, enabled)
    };
    Json(body).into_response()
}

/// Rota admin, mergida no roteador de `store_admin`.
pub(crate) fn admin_router() -> Router<Arc<AdminState>> {
    Router::new().route("/br-coverage", get(get_status))
}

#[cfg(test)]
#[path = "br_coverage_io_tests.rs"]
mod tests;
