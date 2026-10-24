//! Checagem de cache da AllDebrid: o upload é a consulta, e apagar é o preço.
//! Inventário ausente zera a lista de delete — falso negativo é pior.
//!
//! Contrato do Node (`src/debrid/alldebrid-check.ts` + `common.ts::batched`):
//! lotes de `DEBRID_BATCH_SIZE` (default 25) rodam **em paralelo**, cada um
//! com o MESMO teto de `DEBRID_CACHE_CHECK_TIMEOUT_MS` (default 10 s); um lote
//! que estoura vira `complete:false` sem apagar o ⚡ dos lotes que
//! responderam. O teto da checagem em lote (500 hashes) também
//! vale aqui: o excedente não é enviado e conta como `complete:false` — nunca
//! como "não está em cache". Falha de limpeza só avisa, como no Node.
//!
//! A limpeza é um PLANO (`CacheReport.cleanup`): esta função não apaga nada.
//! Quem executa é o chamador, em fundo (`CleanupPlan::run`), como o Node faz
//! com `dropMagnets` — a resposta do `/stream` nunca espera o backoff. Só
//! existe plano com `DEBRID_AL_CLEANUP=on` **e** `holds_complete` e inventário;
//! fora disso o relatório traz o motivo em `suppressed` (read-only).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use super::{AllDebrid, CHECK_TIMEOUT, DEFAULT_BATCH};
use crate::alldebrid_cleanup::{
    account_scope, bump, kill_switch_on, known_before, refresh_known_before, CleanupGate,
    CleanupMode, CleanupPlan, CleanupSuppressed, DurablePeek, METRIC_KNOWN_BEFORE, METRIC_PLANNED,
    METRIC_PROTECTED, METRIC_SUPPRESSED,
};
use crate::error::DebridError;

#[path = "alldebrid_check_fold.rs"]
mod fold;
use fold::{batches, lower_set};

#[path = "alldebrid_check_url.rs"]
mod url;
pub(super) use url::{accepted_base, base_rejected, query_url};
/// Mesmo teto da checagem Node que esta nativa substituiu (`MAX_HASHES` = 500).
pub const MAX_HASHES: usize = 500;

#[derive(Debug, Clone, Default)]
pub struct CheckOpts {
    pub timeout: Option<Duration>,
    pub batch_size: Option<usize>,
    pub drop_ready: bool,
    pub drop_uncached: bool,
    pub inventory_loaded: bool,
    pub known_before: HashSet<String>,
    pub held: HashSet<String>,
    pub blocked: HashSet<String>,
    /// `DEBRID_AL_CLEANUP` (default OFF). OFF = read-only mesmo com os `drop_*`.
    pub cleanup: CleanupMode,
    /// O chamador prova que `held` cobre TODOS os holds vivos da conta. Sem
    /// isso a nativa não apaga: o hold volátil do autofetch mora no Node.
    pub holds_complete: bool,
    /// Leitura de `adprot`/`adsub` no `cache.db` do Node. `None` = sem fonte
    /// durável (o hold volátil e o inventário continuam valendo).
    pub durable: Option<Arc<DurablePeek>>,
    /// Override do kill-switch (`None` = lê `DEBRID_AL_CLEANUP_KILL`). Existe
    /// para os testes não dependerem de env global.
    pub kill_switch: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheReport {
    pub cached: Vec<String>,
    /// Hashes que o anti-reenchimento (`adrm`) tirou do `/magnet/upload` nesta
    /// rodada, lower-case e sem repetição. NÃO é veredito: o Rust não tem o
    /// inventário PRONTO da conta (memo `dinv` do Node), então `cached` NÃO os
    /// inclui. O Node consome esta lista para o escape do `adrm` — hash que o
    /// inventário prova pronto volta a ter ⚡ e perde o marcador; sem prova,
    /// nada muda (`alldebrid-reupload.ts::unblockIfInventoryReady`).
    pub blocked: Vec<String>,
    /// `false` = algum lote não respondeu (ou o teto cortou hashes): o que não
    /// está em `cached` é "não perguntado", não "frio".
    pub complete: bool,
    /// Ids cuja remoção foi PEDIDA no plano (não é prova de remoção — a fila
    /// com backoff roda depois, em fundo, e falha só loga).
    pub deleted: Vec<String>,
    /// `false` só quando NADA foi enviado (todos bloqueados/lista vazia): o
    /// caller pode usar o fallback Node sem risco de segundo upload.
    pub attempted: bool,
    /// Plano da limpeza. `None` = flag OFF (nativa read-only). `Some` com
    /// `suppressed` = pedida mas barrada por kill-switch/hold/inventário.
    pub cleanup: Option<CleanupPlan>,
}

/// Falha da checagem com a mesma informação de `attempted` do sucesso.
#[derive(Debug)]
pub struct CheckFailure {
    pub error: DebridError,
    pub attempted: bool,
}

impl CheckFailure {
    fn new(error: DebridError, attempted: bool) -> Self {
        Self { error, attempted }
    }
}

/// Cópia própria dos vetos: os lotes rodam em tasks independentes.
struct Gate {
    blocked: HashSet<String>,
    /// `None` = flag OFF; `Some` com `suppressed` = pedida e barrada.
    cleanup: Option<CleanupRun>,
}

/// Estado imutável da limpeza nesta checagem: plano em construção, guarda e
/// snapshot. Compartilhado (Arc) pelos lotes em paralelo.
struct CleanupRun {
    plan: CleanupPlan,
    gate: CleanupGate,
    inventory: Option<Arc<HashSet<String>>>,
    account: String,
}

impl CleanupRun {
    fn active(&self) -> bool {
        self.plan.suppressed.is_none()
    }
}

pub(super) async fn check_cached(
    ad: &AllDebrid,
    api_key: &str,
    hashes: &[String],
    opts: &CheckOpts,
) -> Result<CacheReport, CheckFailure> {
    let account = account_scope(api_key);
    let gate = Arc::new(Gate {
        blocked: lower_set(&opts.blocked),
        cleanup: cleanup_run(ad, api_key, opts, &account),
    });
    // Partição do lote: hash vazio sai da conta e hash bloqueado sai do upload,
    // mas fica registrado — o Node precisa dele para tentar o escape do `adrm`
    // (a prova de "pronto" mora no inventário dele).
    let mut blocked: Vec<String> = Vec::new();
    let mut send: Vec<String> = Vec::with_capacity(hashes.len());
    for hash in hashes {
        let lower = hash.to_lowercase();
        if lower.is_empty() {
            continue;
        }
        if gate.blocked.contains(&lower) {
            if !blocked.contains(&lower) {
                blocked.push(lower);
            }
            continue;
        }
        send.push(hash.clone());
    }
    let attempted = !send.is_empty();
    // Teto: o excedente não vai ao serviço e o veredito sai incompleto.
    let overflow = send.len() > MAX_HASHES;
    let send = &send[..send.len().min(MAX_HASHES)];
    let size = batch_size(opts);
    let timeout = timeout_of(opts);
    let mut folded = match batches(ad, api_key, send, size, timeout, &gate).await {
        Ok(folded) => folded,
        // Erro de lote não gera plano: sem upload não há o que limpar.
        Err(error) => return Err(CheckFailure::new(error, attempted)),
    };
    // A posse (`adsub`) mora no `cache.db` do Node: devolve o que esta checagem
    // SUBIU e que o snapshot provou novo. Fora do prazo da resposta, fail-open.
    let submitted = std::mem::take(&mut folded.submitted);
    if !submitted.is_empty() {
        crate::marks_feed::spawn(crate::marks_feed::MarkedBatch {
            api_key: api_key.to_string(),
            submitted,
            removed: Vec::new(),
        });
    }
    let plan = gate.cleanup.as_ref().map(|run| {
        let mut plan = run.plan.clone();
        plan.ready = folded.ready;
        plan.uncached = folded.uncached;
        plan.known_before = folded.known;
        plan.protected = folded.protected;
        plan
    });
    if let Some(plan) = &plan {
        if let Some(reason) = plan.suppressed {
            bump(&format!("{METRIC_SUPPRESSED}.{}", reason.as_str()), 1);
        }
        bump(METRIC_PLANNED, plan.target_count() as u64);
        bump(METRIC_PROTECTED, plan.protected as u64);
        bump(METRIC_KNOWN_BEFORE, plan.known_before as u64);
    }
    let deleted = plan.as_ref().map(CleanupPlan::ids).unwrap_or_default();
    Ok(CacheReport {
        cached: folded.cached,
        blocked,
        complete: folded.complete && !overflow,
        deleted,
        attempted,
        cleanup: plan,
    })
}

/// Plano da limpeza desta checagem. `None` = flag OFF (read-only de verdade:
/// nem inventário é carregado). O resto é fail-closed, do mais barato ao mais
/// caro: kill-switch, holds incompletos, nenhum drop pedido, inventário
/// ausente.
fn cleanup_run(
    ad: &AllDebrid,
    api_key: &str,
    opts: &CheckOpts,
    account: &str,
) -> Option<CleanupRun> {
    if !opts.cleanup.is_on() {
        return None;
    }
    let gate = CleanupGate::new(
        opts.drop_ready,
        opts.drop_uncached,
        opts.holds_complete,
        opts.held.clone(),
        opts.durable.clone(),
        account,
    );
    let suppressed = if opts.kill_switch.unwrap_or_else(kill_switch_on) {
        Some(CleanupSuppressed::KillSwitch)
    } else if !opts.holds_complete {
        // O hold do autofetch mora no processo do Node. Sem a prova de que a
        // lista `held` cobre o lote, um `dropUncached` mataria o download.
        Some(CleanupSuppressed::HoldsIncomplete)
    } else if !(opts.drop_ready || opts.drop_uncached) {
        Some(CleanupSuppressed::NoDropFlags)
    } else {
        None
    };
    if let Some(reason) = suppressed {
        return Some(CleanupRun {
            plan: CleanupPlan::suppressed(reason),
            gate,
            inventory: None,
            account: account.to_string(),
        });
    }
    // Fatos do chamador (o Node tem o inventário em memória) ou snapshot
    // próprio: peek agora; vencido, refresh em fundo e esta rodada fica
    // fechada. O `/magnet/status` nunca entra no prazo da resposta.
    let inventory = if opts.inventory_loaded {
        Some(Arc::new(lower_set(&opts.known_before)))
    } else {
        let snapshot = known_before(account);
        if snapshot.is_none() {
            refresh_known_before(ad, api_key, account, opts.durable.clone());
        }
        snapshot
    };
    let plan = if inventory.is_none() {
        CleanupPlan::suppressed(CleanupSuppressed::InventoryMissing)
    } else {
        CleanupPlan::default()
    };
    Some(CleanupRun {
        plan,
        gate,
        inventory,
        account: account.to_string(),
    })
}

fn batch_size(opts: &CheckOpts) -> usize {
    opts.batch_size
        .or_else(|| env_usize("DEBRID_BATCH_SIZE"))
        .unwrap_or(DEFAULT_BATCH)
        .clamp(1, MAX_HASHES)
}

fn timeout_of(opts: &CheckOpts) -> Duration {
    opts.timeout
        .or_else(|| env_ms("DEBRID_CACHE_CHECK_TIMEOUT_MS"))
        .unwrap_or(CHECK_TIMEOUT)
        .max(Duration::from_millis(1))
}

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()?
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
}

fn env_ms(name: &str) -> Option<Duration> {
    env_usize(name).map(|value| Duration::from_millis(value as u64))
}

#[cfg(test)]
#[path = "alldebrid_check_tests.rs"]
mod check_tests;
