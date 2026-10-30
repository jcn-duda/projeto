//! Fatos da limpeza AllDebrid lidos no PRÓPRIO processo do gateway, sem rota
//! `POST /internal/debrid/holds` do Node (a rota saiu; o gateway calcula sozinho).
//!
//! Porte de `buildCleanupFacts` (`src/debrid/alldebrid-cleanup-facts.ts`),
//! `heldHashesFor`/`isCleanupProtected` (`src/debrid/protected.ts`) e
//! `alldebridLinkFacts` (`src/debrid/rust-link-facts.ts`). Os estados já moram
//! no KV nativo (tabela `cache` do `cache.db`, o `production_kv()` do
//! adom-debrid): `adhold:v1` (hold curto do autofetch), `adprot:v1` (retenção
//! BR) e `adsub:v1` (posse do que o addon subiu, lida pelo snapshot).
//!
//! Fail-closed em tudo: sem KV, chave vazia, hash ilegível ou leitura que
//! falha derruba `holds_complete` (a limpeza da rodada fica read-only) e o
//! `held` do play vira `true` (o magnet frio fica na conta).

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use adom_debrid::alldebrid::AllDebrid;
use adom_debrid::alldebrid_cleanup::{
    account_scope, adhold_key, adprot_key, known_before, refresh_known_before, DurablePeek,
};
use adom_debrid::holds_feed::HoldsFacts;
use adom_debrid::native_kv::production_kv;
use adom_debrid::HttpClient;
use adom_index::NativeKv;
use adom_search::HoldsFeed;

/// Flag com a regra do Node `String(process.env.X || 'true') === 'true'`: vazio
/// ou ausente liga; só o literal `true` vale (`1`/`on` NÃO ligam).
pub fn literal_true_env(name: &str) -> bool {
    literal_true(std::env::var(name).ok().as_deref())
}

pub(crate) fn literal_true(raw: Option<&str>) -> bool {
    match raw {
        None | Some("") => true,
        Some(value) => value == "true",
    }
}

/// `DEBRID_AUTO_FETCH_PROTECT_BR`: liga a retenção `adprot` na limpeza e no
/// `held` do play (`isDurablyProtected` do Node só age com a flag ligada).
fn protect_br_enabled() -> bool {
    literal_true_env("DEBRID_AUTO_FETCH_PROTECT_BR")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Entrada pura da régua: o que o processo sabe nesta chamada. Separada do I/O
/// para o teste escolher KV, inventário, flags e relógio.
pub struct FactsInput<'a> {
    pub api_key: &'a str,
    pub hashes: &'a [String],
    /// Snapshot `knownBefore` (conta menos a posse). `None` = não carregado.
    pub inventory: Option<Arc<HashSet<String>>>,
    /// KV do processo. `None` = sem leitura, logo sem prova de cobertura.
    pub kv: Option<&'a NativeKv>,
    pub protect_br: bool,
    pub drop_ready: bool,
    pub drop_uncached: bool,
    pub now_ms: i64,
}

/// Auditoria dos holds do lote (`heldHashesFor` do Node).
struct HoldAudit {
    held: Vec<String>,
    evaluated: Vec<String>,
    complete: bool,
}

/// Hold do autofetch OU `adprot` vivo (`isCleanupProtected`). `Err` = leitura
/// que falhou: quem chama NÃO pode tratar como "não protegido".
fn protected(
    kv: &NativeKv,
    account: &str,
    hash: &str,
    protect_br: bool,
    now_ms: i64,
) -> Result<bool, String> {
    if alive(kv, &adhold_key(account, hash), now_ms)? {
        return Ok(true);
    }
    if protect_br && alive(kv, &adprot_key(account, hash), now_ms)? {
        return Ok(true);
    }
    Ok(false)
}

/// Registro vivo: existe e não é `null` (o `kvPeek != null` do Node).
fn alive(kv: &NativeKv, key: &str, now_ms: i64) -> Result<bool, String> {
    Ok(kv
        .get_json(key, now_ms)?
        .is_some_and(|value| !value.is_null()))
}

/// Porte de `heldHashesFor`. Conta `none` (chave vazia) ou lote vazio não
/// provam nada; hash vazio, sem KV ou leitura que falha derrubam a prova.
fn held_hashes(input: &FactsInput<'_>, account: &str) -> HoldAudit {
    let mut audit = HoldAudit {
        held: Vec::new(),
        evaluated: Vec::new(),
        complete: false,
    };
    let Some(kv) = input.kv else {
        // Sem KV não há como consultar o hold: a prova não existe.
        eprintln!("[alldebrid] KV nativo indisponível: holds não provados, limpeza read-only");
        return audit;
    };
    if account == "none" || input.hashes.is_empty() {
        return audit;
    }
    let mut complete = true;
    let mut seen_eval: HashSet<String> = HashSet::new();
    let mut seen_held: HashSet<String> = HashSet::new();
    for raw in input.hashes {
        let hash = raw.trim().to_lowercase();
        if hash.is_empty() {
            complete = false;
            continue;
        }
        if seen_eval.insert(hash.clone()) {
            audit.evaluated.push(hash.clone());
        }
        match protected(kv, account, &hash, input.protect_br, input.now_ms) {
            Ok(true) => {
                if seen_held.insert(hash.clone()) {
                    audit.held.push(hash);
                }
            }
            Ok(false) => {}
            Err(err) => {
                // Leitura falhou: o hash PODE estar protegido. Mantém a lista
                // parcial e derruba a prova — nunca "completo" por omissão.
                eprintln!(
                    "[alldebrid] leitura do hold falhou ({err}): limpeza da rodada read-only"
                );
                complete = false;
            }
        }
    }
    audit.complete = complete;
    audit
}

/// Fatos do lote, na régua do Node (`buildCleanupFacts`).
pub fn build_facts(input: &FactsInput<'_>) -> HoldsFacts {
    let drop_ready = Some(input.drop_ready);
    let drop_uncached = Some(input.drop_uncached);
    // Chave vazia não identifica conta nem inventário: nenhum fato é provável.
    if input.api_key.is_empty() {
        return HoldsFacts {
            drop_ready,
            drop_uncached,
            ..HoldsFacts::default()
        };
    }
    let account = account_scope(input.api_key);
    let (inventory_loaded, known) = match &input.inventory {
        Some(set) => {
            let mut sorted: Vec<String> = set.iter().cloned().collect();
            sorted.sort();
            (true, sorted)
        }
        None => (false, Vec::new()),
    };
    let audit = held_hashes(input, &account);
    HoldsFacts {
        account,
        inventory_loaded,
        known_before: known,
        held: audit.held,
        evaluated: audit.evaluated,
        holds_complete: audit.complete,
        drop_ready,
        drop_uncached,
    }
}

/// `held` do play (`alldebridLinkFacts`): `true` = NÃO apagar o magnet frio.
/// Sem chave, sem KV ou com leitura que falha, `true`.
pub fn play_held_with(
    kv: Option<&NativeKv>,
    api_key: &str,
    hash: &str,
    protect_br: bool,
    now_ms: i64,
) -> bool {
    if api_key.is_empty() {
        return true;
    }
    let Some(kv) = kv else {
        return true;
    };
    let account = account_scope(api_key);
    protected(kv, &account, hash, protect_br, now_ms).unwrap_or(true)
}

/// `held` do play com o KV de produção e as flags do ambiente.
pub fn play_held(api_key: &str, hash: &str) -> bool {
    play_held_with(
        production_kv(),
        api_key,
        hash,
        protect_br_enabled(),
        now_ms(),
    )
}

/// Feed de holds nativo (`HoldsFeed` do seam). Substitui a rota antiga do Node
/// (`/internal/debrid/holds`, já removida); montado só com `DEBRID_AL_HOLDS` ligado.
pub struct NativeHoldsFeed {
    ad: AllDebrid,
    durable: Arc<DurablePeek>,
}

impl NativeHoldsFeed {
    pub fn new(client: HttpClient) -> Self {
        Self {
            ad: AllDebrid::new(client),
            durable: Arc::new(DurablePeek::from_env()),
        }
    }
}

impl HoldsFeed for NativeHoldsFeed {
    fn facts(&self, api_key: &str, service: &str, hashes: &[String]) -> Result<HoldsFacts, String> {
        if service != "alldebrid" {
            return Err(format!(
                "feed nativo de holds só serve a alldebrid ({service})"
            ));
        }
        let mut inventory = None;
        if !api_key.is_empty() {
            let account = account_scope(api_key);
            inventory = known_before(&account);
            if inventory.is_none() {
                // Vencido ou ausente: o refresh roda em fundo (uma leitura em voo
                // por conta). Esta rodada segue sem o snapshot, fail-closed.
                refresh_known_before(&self.ad, api_key, &account, Some(self.durable.clone()));
            }
        }
        Ok(build_facts(&FactsInput {
            api_key,
            hashes,
            inventory,
            kv: production_kv(),
            protect_br: protect_br_enabled(),
            drop_ready: literal_true_env("DEBRID_DROP_READY"),
            drop_uncached: literal_true_env("DEBRID_DROP_UNCACHED"),
            now_ms: now_ms(),
        }))
    }
}

#[cfg(test)]
#[path = "al_cleanup_facts_tests.rs"]
mod tests;
