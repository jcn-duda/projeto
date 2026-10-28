//! Passo de dreno da represa (`autofetch:v3:sup:`) — o `drainSuppressed` do Node.
//!
//! A represa guarda o que a remoção automática deixou de apagar: hash + id da
//! transferência + `fails`/`nextAt`. O worker nativo já a ESCREVE
//! ([`crate::autofetch::recheck_expire`]) desde a leva do recheck, mas nunca a
//! drenava — a rota `suppressed-drain` respondia `drained:0` sem olhar o KV.
//!
//! Este módulo é declarado em `mod.rs`, e as guardas (gate + retenção viva)
//! vivem em `suppressed_guard.rs` (`#[path]` daqui) pela catraca de linhas.
//!
//! # Gate do knob — o passo é DESTRUTIVO
//!
//! Régua do Node (`src/providers/autofetch-suppressed.ts:280`): sem
//! `DEBRID_REMOVE_BY_ID` (default OFF) e sem `force`, o dreno é NO-OP — não
//! varre chave de remoção, não chama o serviço e devolve `kept = depth` com
//! `gate = "remove-by-id-off"` ([`DrainGate`]). O laço usa
//! [`DrainGate::automatic`] e NUNCA força; `force` só existe na ação do painel
//! (`POST /autofetch/suppressed-drain`), que é destrutiva e exige
//! `{"confirm":true}` no corpo.
//!
//! # Formato da chave (idêntico ao Node)
//!
//! `autofetch:v3:sup:{adapter}:{account}:{hash}` — `adapter`/`account` crus,
//! `hash` em minúsculas, nessa ordem. Confere com
//! `adom_autofetch::v3::suppressed_key` (`NAMESPACE_V3` = `autofetch:v3`) e com
//! `src/providers/autofetch-suppressed.ts` (`${SUP_PREFIX}${adapter}:${account}:${hash}`,
//! `prefix('autofetch')` = `autofetch:v3:`). Registro `{ id, at, fails, nextAt }`;
//! legado `{ id, at }` lê como `fails: 0, nextAt: 0` (sempre elegível).
//!
//! # O id é o ATUAL, nunca o lido no início da passagem
//!
//! Bug documentado em `adom_autofetch::v3::suppressed`: o Node usa o id do
//! começo do drain. Outro ator (recheck de outro lote, porta do painel, um novo
//! `note`) pode trocá-lo no meio da passagem, e apagar o antigo é apagar um
//! transfer que não é mais o nosso. Aqui a represa é RELIDA imediatamente antes
//! da chamada de rede e o `remove` usa `record.id` dessa releitura, que também
//! reconfere `nextAt` para não atropelar backoff escrito no intervalo.
//!
//! # O que NUNCA sai
//!
//! - retenção viva (`adhold:v1:` volátil ou `adprot:v1:` durável do pool BR) —
//!   invariante 6 do `AGENTS.md`: a limpeza não apaga acervo BR;
//! - `nextAt` no futuro (a falha anterior já agendou a espera);
//! - conta sem adaptador resolvido (sem credencial no cofre): o passo é PULADO,
//!   como no laço (`no-credential`) — pular não pode virar falha, ou um escopo
//!   sem chave queimaria as cinco tentativas de um registro bom.
//!
//! `adsub:v1:` (posse) NÃO defende: é a prova que AUTORIZA apagar. `adrm:v1:`
//! prova que a transferência já saiu — a entrada cai sem chamada de rede.
//!
//! # Dupla propriedade (Node × gateway)
//!
//! Quem age é quem tem credencial: o passo só executa com a fábrica registrada
//! ([`register_factory`], no boot do worker). Sem ela a rota responde
//! `effect:"none"` e o Node segue dono (`autofetchEffectApplied`).

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use adom_autofetch::v3::{QueueV3, SuppressedRetry, SuppressedV3, NAMESPACE_V3};
use adom_index::NativeKv;
use serde_json::{json, Value};

use crate::autofetch::ports::DebridFactory;

#[path = "suppressed_guard.rs"]
mod guard;

pub(crate) use guard::{already_removed, defended, DrainGate, GATE_REMOVE_BY_ID_OFF};

/// `config.debrid.suppressedTtl` do Node (`DEBRID_SUPPRESSED_TTL`, 30 dias).
const TTL_DEFAULT_SECONDS: i64 = 2_592_000;
/// `config.debrid.suppressedDrainMax` do Node (25 por passagem).
const MAX_DEFAULT: usize = 25;
/// Teto duro do `max` vindo do corpo da rota (rajada controlada).
const MAX_CAP: usize = 500;

/// Prefixo da represa (`autofetch:v3:sup:`), derivado do namespace do crate.
pub(crate) fn press_prefix() -> String {
    format!("{NAMESPACE_V3}:sup:")
}

/// TTL do registro (`DEBRID_SUPPRESSED_TTL`): só para reescrever o `nextAt` de
/// um registro cujo TTL restante sumiu entre a leitura e a falha.
pub(crate) fn ttl_seconds() -> i64 {
    env_num("DEBRID_SUPPRESSED_TTL")
        .filter(|value| *value > 0)
        .unwrap_or(TTL_DEFAULT_SECONDS)
}

/// Teto por passagem (`DEBRID_SUPPRESSED_DRAIN_MAX`). Conta CHAMADAS de remoção,
/// não entradas varridas: o que sobra volta na passagem seguinte.
pub(crate) fn drain_max() -> usize {
    env_num("DEBRID_SUPPRESSED_DRAIN_MAX")
        .filter(|value| *value > 0)
        .map(|value| (value as usize).min(MAX_CAP))
        .unwrap_or(MAX_DEFAULT)
}

fn env_num(key: &str) -> Option<i64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
}

/// Uma remoção represada, campo a campo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pressed {
    pub(crate) adapter: String,
    /// `accountScope` (`sha256` da chave) — o mesmo das chaves `q:`/`dead:`.
    pub(crate) account: String,
    pub(crate) hash: String,
    /// Id ATUAL da transferência: é este que o dreno pode apagar.
    pub(crate) id: String,
    /// Tentativas já contabilizadas (`fails`) e a marca do próximo retry
    /// (`0` = elegível agora).
    pub(crate) tries: i64,
    pub(crate) next_at: i64,
    /// Por que continua represada: `eligible`, `backoff` ou `protected`.
    pub(crate) motive: &'static str,
    /// `pool` (`br`/`seeds`/`any`) e `obra` do marker — vazios quando o enqueue
    /// deste worker não gravou meta.
    pub(crate) pool: String,
    pub(crate) obra: String,
}

/// Contadores de UMA passagem. `retried` = falhas que receberam backoff;
/// `dropped` = entradas que saíram da represa (remoção confirmada, `givenup`,
/// órfã sem id, já liquidada por outro ator); `kept` = as que ficaram
/// (retenção/backoff/sem credencial/acima do teto); `failed` = chamadas de
/// remoção não confirmadas — as aposentadas contam nos dois.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DrainCounters {
    pub(crate) retried: usize,
    pub(crate) dropped: usize,
    pub(crate) kept: usize,
    pub(crate) failed: usize,
}

/// Resultado de uma passagem. `operations > 0` = o serviço foi chamado, logo o
/// gateway EXECUTOU (a rota pode responder `effect:"applied"`).
#[derive(Clone, Debug)]
pub(crate) struct DrainReport {
    pub(crate) counters: DrainCounters,
    pub(crate) operations: usize,
    /// Profundidade que sobrou na represa (relida do KV).
    pub(crate) depth: usize,
    pub(crate) at: i64,
    /// Gate que barrou a passagem (`None` = o dreno rodou).
    pub(crate) gate: Option<&'static str>,
}

impl DrainReport {
    /// Forma publicada no painel (`lastSuppressedDrain`).
    pub(crate) fn snapshot(&self) -> Value {
        json!({
            "retried": self.counters.retried,
            "dropped": self.counters.dropped,
            "kept": self.counters.kept,
            "failed": self.counters.failed,
            "operations": self.operations,
            "depth": self.depth,
            "at": self.at,
            "gate": self.gate,
        })
    }
}

/// Chaves vivas da represa como `(adapter, account, hash)`, na ordem do store.
pub(crate) fn keys(kv: &NativeKv, now_ms: i64) -> Result<Vec<(String, String, String)>, String> {
    let prefix = press_prefix();
    Ok(kv
        .keys_matching(&prefix, now_ms)?
        .iter()
        .filter_map(|key| split_key(&prefix, key))
        .collect())
}

/// Profundidade da represa (o `suppressed` do painel). O `keys_matching` já poda
/// o vencido: registro expirado não é profundidade.
pub(crate) fn count(kv: &NativeKv, now_ms: i64) -> Result<usize, String> {
    Ok(kv.keys_matching(&press_prefix(), now_ms)?.len())
}

/// Leitura completa de UMA entrada (`None` = registro sem id / ilegível).
pub(crate) fn read_one(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    hash: &str,
    now_ms: i64,
) -> Result<Option<Pressed>, String> {
    let Some(record) = SuppressedV3::new(kv).read(adapter, account, hash, now_ms)? else {
        return Ok(None);
    };
    let marker = QueueV3::new(kv).marker(adapter, account, hash, now_ms)?;
    let field = |name: &str| match marker.as_ref().and_then(|value| value.get(name)) {
        Some(value) => value.as_str().unwrap_or_default().to_string(),
        None => String::new(),
    };
    let motive = if defended(kv, adapter, account, hash, now_ms)? {
        "protected"
    } else if record.next_at > now_ms {
        "backoff"
    } else {
        "eligible"
    };
    Ok(Some(Pressed {
        adapter: adapter.to_string(),
        account: account.to_string(),
        hash: hash.to_string(),
        id: record.id,
        tries: record.fails,
        next_at: record.next_at,
        motive,
        pool: field("pool"),
        obra: field("obra"),
    }))
}

/// Drena a represa: apaga até `max` transferências por passagem, com backoff.
///
/// `resolve` é a fábrica por CONTA do ciclo (`adapter:conta` → adaptador): a
/// chave é lida do cofre no momento do uso, e escopo sem chave devolve `None`.
/// `gate` fechado = NO-OP: nada é varrido e o serviço não é chamado.
pub(crate) async fn drain(
    kv: &NativeKv,
    resolve: DebridFactory,
    max: usize,
    now_ms: i64,
    gate: DrainGate,
) -> Result<DrainReport, String> {
    if !gate.open() {
        // Gate fechado: nenhuma chave de remoção é varrida nem o serviço é
        // chamado — só a profundidade, que é o que o painel cobra.
        let depth = count(kv, now_ms)?;
        let report = DrainReport {
            counters: DrainCounters {
                kept: depth,
                ..DrainCounters::default()
            },
            operations: 0,
            depth,
            at: now_ms,
            gate: Some(GATE_REMOVE_BY_ID_OFF),
        };
        publish(&report);
        return Ok(report);
    }
    let ttl = ttl_seconds();
    let limit = max.max(1);
    let suppressed = SuppressedV3::new(kv);
    let mut counters = DrainCounters::default();
    let mut operations = 0usize;

    for (adapter, account, hash) in keys(kv, now_ms)? {
        let Some(entry) = read_one(kv, &adapter, &account, &hash, now_ms)? else {
            // Registro sem id (ou ilegível) não é remoção represada.
            suppressed.forget(&adapter, &account, &hash)?;
            counters.dropped += 1;
            continue;
        };
        if already_removed(kv, &account, &hash, now_ms)? {
            suppressed.forget(&adapter, &account, &hash)?;
            counters.dropped += 1;
            continue;
        }
        if entry.motive != "eligible" {
            counters.kept += 1;
            continue;
        }
        if operations >= limit {
            counters.kept += 1;
            continue;
        }
        let Some(debrid) = resolve(&format!("{}:{}", entry.adapter, entry.account)) else {
            // Sem credencial no cofre o passo é PULADO, nunca vira falha.
            counters.kept += 1;
            continue;
        };
        // ID ATUAL: a represa é relida DEPOIS de resolver o adaptador. Outro
        // ator pode ter trocado o id ou agendado um backoff neste intervalo.
        let Some(current) = suppressed.read(&adapter, &account, &hash, now_ms)? else {
            counters.dropped += 1;
            continue;
        };
        if current.id.is_empty() || current.next_at > now_ms {
            counters.kept += 1;
            continue;
        }
        operations += 1;
        if matches!(debrid.remove(&current.id).await, Ok(true)) {
            suppressed.forget(&adapter, &account, &hash)?;
            counters.dropped += 1;
            continue;
        }
        counters.failed += 1;
        // Hash e id (nunca a chave da conta) para o operador achar a linha no serviço.
        eprintln!(
            "[autofetch] represa: {} hash={} id={} não apagou (obra={} pool={} tentativas={})",
            entry.adapter, entry.hash, entry.id, entry.obra, entry.pool, entry.tries
        );
        match suppressed.retry(&adapter, &account, &hash, ttl, now_ms)? {
            // Sumiu ou foi aposentada: não recriar registro de id morto.
            SuppressedRetry::Missing | SuppressedRetry::GivenUp => counters.dropped += 1,
            SuppressedRetry::Scheduled => counters.retried += 1,
        }
    }

    let report = DrainReport {
        counters,
        operations,
        depth: count(kv, now_ms)?,
        at: now_ms,
        gate: None,
    };
    publish(&report);
    Ok(report)
}

/// Registro do último passo (a rota publica em `lastSuppressedDrain`).
pub(crate) fn last() -> Option<Value> {
    lock(&shared().last).clone()
}

/// Fábrica do CICLO (dona do gate RD): chamada UMA vez no boot do worker, com a
/// MESMA fábrica que o laço recebe. Fiação (fora desta leva) em `boot::spawn_at`,
/// logo depois de `let debrid = ...`, antes de `AutofetchHandle::build(..)`:
/// `routes::suppressed_step::register_factory(factory.clone())` com `debrid.as_ref()`.
#[allow(dead_code)]
pub(crate) fn register_factory(factory: DebridFactory) {
    *lock(&shared().factory) = Some(factory);
}

/// Fábrica registrada, se o ciclo já subiu com credencial.
pub(crate) fn factory() -> Option<DebridFactory> {
    lock(&shared().factory).clone()
}

struct Shared {
    factory: Mutex<Option<DebridFactory>>,
    last: Mutex<Option<Value>>,
}

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Shared {
        factory: Mutex::new(None),
        last: Mutex::new(None),
    })
}

fn publish(report: &DrainReport) {
    *lock(&shared().last) = Some(report.snapshot());
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `adapter:account:hash` a partir da chave completa. O hash é o resto (o Node
/// também faz `parts.slice(2).join(':')`), então nada de texto livre se perde.
fn split_key(prefix: &str, key: &str) -> Option<(String, String, String)> {
    let rest = key.strip_prefix(prefix)?;
    let (adapter, rest) = rest.split_once(':')?;
    let (account, hash) = rest.split_once(':')?;
    if adapter.is_empty() || account.is_empty() || hash.is_empty() {
        return None;
    }
    Some((adapter.into(), account.into(), hash.into()))
}

/// Serializa os testes que chamam o passo (ele publica num registro do PROCESSO).
#[cfg(test)]
pub(crate) async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    lock.lock().await
}

/// Zera a fábrica e o último passo (fim de um teste que registrou a sua).
#[cfg(test)]
pub(crate) fn clear() {
    *lock(&shared().factory) = None;
    *lock(&shared().last) = None;
}

#[cfg(test)]
#[path = "suppressed_step_tests.rs"]
mod tests;
