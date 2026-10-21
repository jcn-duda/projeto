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

use serde_json::Value;
use tokio::task::JoinSet;

use super::{magnet_id, AllDebrid, CHECK_TIMEOUT, DEFAULT_BATCH};
use crate::alldebrid_cleanup::{
    account_scope, bump, classify_drop, kill_switch_on, known_before, refresh_known_before,
    remember_submitted, CleanupGate, CleanupMode, CleanupPlan, CleanupSuppressed, DropVerdict,
    DurablePeek, METRIC_KNOWN_BEFORE, METRIC_PLANNED, METRIC_PROTECTED, METRIC_SUPPRESSED,
};
use crate::error::now_ms;
use crate::error::DebridError;

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

/// Resultado de um lote: o ⚡ confirmado e o que o plano manda apagar.
#[derive(Default)]
struct Piece {
    cached: Vec<String>,
    ready: Vec<crate::alldebrid_cleanup::CleanTarget>,
    uncached: Vec<crate::alldebrid_cleanup::CleanTarget>,
    protected: usize,
    known: usize,
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

#[derive(Default)]
struct Folded {
    cached: Vec<String>,
    ready: Vec<crate::alldebrid_cleanup::CleanTarget>,
    uncached: Vec<crate::alldebrid_cleanup::CleanTarget>,
    protected: usize,
    known: usize,
    complete: bool,
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
    let send: Vec<String> = hashes
        .iter()
        .filter(|hash| {
            let lower = hash.to_lowercase();
            !lower.is_empty() && !gate.blocked.contains(&lower)
        })
        .cloned()
        .collect();
    let attempted = !send.is_empty();
    // Teto: o excedente não vai ao serviço e o veredito sai incompleto.
    let overflow = send.len() > MAX_HASHES;
    let send = &send[..send.len().min(MAX_HASHES)];
    let size = batch_size(opts);
    let timeout = timeout_of(opts);
    let folded = match batches(ad, api_key, send, size, timeout, &gate).await {
        Ok(folded) => folded,
        // Erro de lote não gera plano: sem upload não há o que limpar.
        Err(error) => return Err(CheckFailure::new(error, attempted)),
    };
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

/// Lotes em paralelo, na ordem do input. `JoinSet` porque o número de lotes é
/// dinâmico; um panic de task vira lote falho, nunca pânico do caller.
async fn batches(
    ad: &AllDebrid,
    api_key: &str,
    send: &[String],
    size: usize,
    timeout: Duration,
    gate: &Arc<Gate>,
) -> Result<Folded, DebridError> {
    let batches: Vec<Vec<String>> = send.chunks(size).map(<[String]>::to_vec).collect();
    let mut set = JoinSet::new();
    for (index, batch) in batches.into_iter().enumerate() {
        let ad = ad.clone();
        let key = api_key.to_string();
        let gate = gate.clone();
        set.spawn(async move { (index, upload_batch(&ad, &key, &batch, timeout, &gate).await) });
    }
    let mut parts: Vec<(usize, Result<Piece, DebridError>)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(part) => parts.push(part),
            Err(error) => {
                // Task abortada/panic é LOTE FALHO, nunca "nada em cache":
                // sem esta entrada o fold poderia responder known:true vazio.
                eprintln!(
                    "[alldebrid] lote de checagem abortou (panic={})",
                    error.is_panic()
                );
                parts.push((
                    usize::MAX,
                    Err(DebridError::other("lote de checagem abortou")),
                ));
            }
        }
    }
    parts.sort_by_key(|(index, _)| *index);
    fold(parts.into_iter().map(|(_, part)| part).collect())
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

async fn upload_batch(
    ad: &AllDebrid,
    api_key: &str,
    batch: &[String],
    timeout: Duration,
    gate: &Gate,
) -> Result<Piece, DebridError> {
    let params: Vec<(&str, &str)> = batch
        .iter()
        .map(|hash| ("magnets[]", hash.as_str()))
        .collect();
    // abort_safe: largar a espera da busca não cancela o upload já enviado.
    let data = ad
        .call(api_key, "/magnet/upload", &params, timeout, true)
        .await?;
    let mut piece = Piece::default();
    let Some(list) = data.get("magnets").and_then(Value::as_array) else {
        return Ok(piece);
    };
    let now = now_ms() as i64;
    for magnet in list {
        let hash = magnet
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let ready = magnet.get("ready").and_then(Value::as_bool) == Some(true);
        if hash.is_empty() {
            continue;
        }
        if ready && !piece.cached.contains(&hash) {
            piece.cached.push(hash.clone());
        }
        let run = gate.cleanup.as_ref().filter(|run| run.active());
        if let Some(run) = run {
            // Posse (8.15): só o que o snapshot prova NÃO estar na conta vira
            // "nosso"; o upload é idempotente e não diz se criou ou reaproveitou.
            if run
                .inventory
                .as_ref()
                .is_some_and(|snapshot| !snapshot.contains(&hash))
            {
                remember_submitted(&run.account, &hash);
            }
            let flagged = if ready {
                run.gate.drop_ready
            } else {
                run.gate.drop_uncached
            };
            if !flagged {
                continue;
            }
            let Some(id) = magnet_id(magnet) else {
                continue;
            };
            match classify_drop(&run.gate, run.inventory.as_deref(), &hash, &id, now) {
                DropVerdict::Delete(target) => {
                    let list = if ready {
                        &mut piece.ready
                    } else {
                        &mut piece.uncached
                    };
                    if !list.iter().any(|item| item.id == target.id) {
                        list.push(target);
                    }
                }
                DropVerdict::Protected => piece.protected += 1,
                DropVerdict::KnownBefore => piece.known += 1,
                DropVerdict::NoInventory => {}
            }
        }
    }
    Ok(piece)
}

fn fold(parts: Vec<Result<Piece, DebridError>>) -> Result<Folded, DebridError> {
    if !parts.is_empty() && parts.iter().all(|part| part.is_err()) {
        return Err(only_failure(&parts));
    }
    let mut folded = Folded::default();
    let mut failed = false;
    for part in parts {
        match part {
            Ok(piece) => {
                for hash in piece.cached {
                    if !folded.cached.contains(&hash) {
                        folded.cached.push(hash);
                    }
                }
                for target in piece.ready {
                    if !folded.ready.iter().any(|item| item.id == target.id) {
                        folded.ready.push(target);
                    }
                }
                for target in piece.uncached {
                    if !folded.uncached.iter().any(|item| item.id == target.id) {
                        folded.uncached.push(target);
                    }
                }
                folded.protected += piece.protected;
                folded.known += piece.known;
            }
            Err(_) => failed = true,
        }
    }
    folded.complete = !failed;
    Ok(folded)
}

/// Igual a `batched` do TS: só quando TODOS os lotes falharam o erro sobe, e
/// auth/quota/rate limit só vencem se forem o motivo de todos. Rate limit é
/// transitório (o Node tenta de novo no passe tardio), por isso tem tipo
/// próprio — nunca vira `unusable`.
fn only_failure(parts: &[Result<Piece, DebridError>]) -> DebridError {
    let mut auth = 0usize;
    let mut quota = 0usize;
    let mut rate = 0usize;
    let mut auth_msg = String::new();
    let mut quota_msg = String::new();
    let mut rate_msg = String::new();
    let mut rate_after = None;
    for part in parts {
        let Err(err) = part else { continue };
        match err.kind() {
            "auth" => {
                auth += 1;
                auth_msg = err.message().to_string();
            }
            "quota" => {
                quota += 1;
                quota_msg = err.message().to_string();
            }
            "rate_limit" => {
                rate += 1;
                rate_msg = err.message().to_string();
                rate_after = rate_after.or(err.retry_after_ms());
            }
            _ => {}
        }
    }
    if auth == parts.len() {
        return DebridError::Auth(auth_msg);
    }
    if quota == parts.len() {
        return DebridError::Quota(quota_msg);
    }
    if rate == parts.len() {
        return DebridError::RateLimit {
            message: rate_msg,
            retry_after_ms: rate_after,
        };
    }
    DebridError::other("nenhum lote de checagem de cache respondeu")
}

fn lower_set(set: &HashSet<String>) -> HashSet<String> {
    set.iter().map(|item| item.to_lowercase()).collect()
}

pub(super) fn query_url(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{base}{path}?agent={}", form_encode(super::AGENT));
    for (key, value) in params {
        url.push('&');
        url.push_str(&form_encode(key));
        url.push('=');
        url.push_str(&form_encode(value));
    }
    url
}

/// `URLSearchParams`: espaço vira `+`.
fn form_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// `https` em qualquer host, ou `http` só em 127.0.0.1/localhost. Sem barra final.
pub(super) fn accepted_base(raw: &str) -> Result<String, DebridError> {
    let trimmed = raw.trim().trim_end_matches('/');
    let bad = trimmed.is_empty()
        || trimmed
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '@' | '\\' | '#' | '?'));
    let Some((scheme_raw, rest)) = (!bad).then(|| trimmed.split_once("://")).flatten() else {
        return Err(base_rejected());
    };
    let scheme = scheme_raw.to_ascii_lowercase();
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port_ok) = match authority.split_once(':') {
        Some((host, port)) => (
            host,
            !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()),
        ),
        None => (authority, true),
    };
    let allowed = !rest.is_empty()
        && !host.is_empty()
        && port_ok
        && match scheme.as_str() {
            "https" => true,
            "http" => host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"),
            _ => false,
        };
    if !allowed {
        return Err(base_rejected());
    }
    Ok(format!("{scheme}://{rest}"))
}

pub(super) fn base_rejected() -> DebridError {
    DebridError::other("ALLDEBRID_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}

#[cfg(test)]
#[path = "alldebrid_check_tests.rs"]
mod check_tests;
