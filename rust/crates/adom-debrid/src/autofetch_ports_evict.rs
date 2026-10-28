//! Evicção POR HASH das portas do autofetch (`evict`).
//!
//! Só a AllDebrid tem PROVA para isso: `/magnet/status` devolve `{id, hash}` e
//! o delete é por id (`/magnet/delete`). Os outros quatro continuam com
//! [`PortError::Unsupported`] — nenhum deles apaga por hash, e lista vazia
//! nunca pode ser lida como "nada a apagar".
//!
//! Regras que não podem regredir:
//!
//! 1. **Devolve só o que saiu.** Hash ausente da listagem não tem id, não é
//!    apagado e não entra no retorno; hash cujo delete falhou também não.
//! 2. **Falha de listagem PROPAGA.** Uma leitura que não aconteceu jamais vira
//!    lista vazia (o chamador concluiria "nada a apagar" e o lixo ficaria).
//! 3. **Guarda reutilizada, não reimplementada.** Cada hash passa pelo
//!    [`may_delete`] do núcleo (`adom_core::debrid_may_delete`) — o MESMO gate
//!    do `apply_plan` das varreduras (`alldebrid_sweeps_apply.rs:150`):
//!    inventário lido + posse provada + nada protegido. A posse vem do memo da
//!    instância (`alldebrid_owned.rs`) e do `adsub:v1` durável; a proteção, do
//!    hold volátil (`cleanup_holds`), da retenção BR `adprot:v1` e do nome com
//!    marca BR (`br_origin_mark`, a blindagem destrutiva do invariante 2).
//! 4. **Fail-closed em cada ausência.** Sem `cache.db` não há `adsub`/`adprot`
//!    legível: a chamada recusa em vez de apagar às cegas. Nome de arquivo
//!    ausente conta como protegido.
//! 5. **Kill-switch próprio.** `DEBRID_AUTO_FETCH_EVICT_FALLBACK` é a MESMA env
//!    do Node (`config.debrid.autoFetchEvictFallback`, default OFF): um
//!    rollback de uma linha desliga os dois lados. O kill-switch global da
//!    limpeza (`DEBRID_AL_CLEANUP_KILL`) desliga por cima.
//! 6. **Teto por chamada.** `DEBRID_EVICT_MAX_PER_CALL` (default 25) limita os
//!    deletes de rede de UMA chamada; hash vetado pela guarda não gasta o teto.

use std::collections::{HashMap, HashSet};

use adom_core::{br_origin_mark, may_delete, DeleteFacts};

use super::{safe_id, wanted_hashes, AutofetchPorts, Backend, PortError};
use crate::alldebrid::SweepMagnet;
use crate::alldebrid_cleanup::{is_held, kill_switch_on, DurablePeek};
use crate::error::{now_ms, DebridError};

/// Env da evicção de fallbacks — a MESMA do Node.
pub(super) const EVICT_ENV: &str = "DEBRID_AUTO_FETCH_EVICT_FALLBACK";
/// Teto de deletes de rede por chamada.
pub(super) const EVICT_MAX_ENV: &str = "DEBRID_EVICT_MAX_PER_CALL";
/// Default do teto (o mesmo `HARVEST_EVICT_MAX_PER_SEARCH` do Node, 25).
const DEFAULT_MAX_PER_CALL: usize = 25;

/// A evicção nasce OFF: destrutiva, com a env do Node como kill-switch e o
/// kill-switch global da limpeza por cima.
pub(super) fn evict_enabled() -> bool {
    evict_enabled_from(std::env::var(EVICT_ENV).ok().as_deref(), kill_switch_on())
}

/// Regra pura (sem env global): quem desliga uma das duas desliga a evicção.
pub(super) fn evict_enabled_from(flag: Option<&str>, killed: bool) -> bool {
    !killed
        && flag.is_some_and(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "on" | "1" | "true" | "yes"
            )
        })
}

fn max_per_call() -> usize {
    max_per_call_from(std::env::var(EVICT_MAX_ENV).ok().as_deref())
}

/// Teto da chamada: ausente/ilegível/zero caem no default, e o valor nunca
/// passa do default (a env só aperta, não solta).
pub(super) fn max_per_call_from(raw: Option<&str>) -> usize {
    raw.and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_PER_CALL)
        .min(DEFAULT_MAX_PER_CALL)
}

impl AutofetchPorts {
    /// Evicção por hash. `Ok` traz APENAS os hashes que o serviço confirmou
    /// removidos; tudo o que não saiu (fora da lista, vetado, falha de delete,
    /// acima do teto) fica de fora — e a falha de listagem é `Err`.
    pub(super) async fn evict_inner(&self, hashes: &[String]) -> Result<Vec<String>, PortError> {
        // Os outros quatro não apagam por hash: capacidade desligada, não
        // "sucesso vazio".
        let Backend::AllDebrid { service, facts } = &self.backend else {
            return Err(PortError::Unsupported("evict"));
        };
        if !evict_enabled() {
            return Err(PortError::Unsupported("evict"));
        }
        let wanted = wanted_hashes(hashes);
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        // Sem o banco do Node não há como provar `adsub` (posse) nem `adprot`
        // (retenção BR): a guarda fecharia com "proteção desconhecida = livre".
        let Some(db_path) = facts.db_path.as_deref() else {
            return Err(PortError::Debrid(DebridError::other(
                "evict sem cache.db: guarda durável (adsub/adprot) indisponível",
            )));
        };
        if self.api_key.trim().is_empty() {
            return Err(PortError::Debrid(DebridError::Auth(
                "evict sem chave de API".to_string(),
            )));
        }
        // Falha aqui é `Err`: a listagem vazia só significa "conta vazia" quando
        // a conta respondeu com uma lista.
        let rows = service.magnet_index(&self.api_key).await?;
        let account = account_of(&self.scope);
        let now = now_ms() as i64;
        let peek = DurablePeek::new(db_path);
        let mut by_hash: HashMap<&str, &SweepMagnet> = HashMap::new();
        for row in &rows {
            by_hash.entry(row.hash.as_str()).or_insert(row);
        }
        let cap = max_per_call();
        let mut removed: Vec<String> = Vec::new();
        let mut deleted: HashSet<&str> = HashSet::new();
        let mut calls = 0usize;
        for hash in &wanted {
            // Hash sem linha na listagem: sem id, sem delete, sem retorno.
            let Some(row) = by_hash.get(hash.as_str()).copied() else {
                continue;
            };
            let id = row.id.trim();
            // A porta não deixa um id de terceiro mudar o caminho HTTP.
            if !safe_id(id) {
                continue;
            }
            // Dois hashes do MESMO id (linhas repetidas da conta): uma remoção.
            if !deleted.insert(id) {
                continue;
            }
            if !may_evict(&peek, account, row, now) {
                continue;
            }
            if calls >= cap {
                break;
            }
            calls += 1;
            match service.remove_torrent(&self.api_key, id).await {
                Ok(()) => removed.push(hash.clone()),
                // Chave recusada, teto da conta ou rate limit: insistir só gasta
                // a conta — a taxonomia sobe no `Err`.
                Err(error) if terminal(&error) => return Err(PortError::Debrid(error)),
                // Falha de UM id não derruba o lote: o magnet continua na conta.
                Err(error) => eprintln!(
                    "[debrid] evict do magnet {id} falhou ({}): segue o lote",
                    error.kind()
                ),
            }
        }
        Ok(removed)
    }
}

/// A guarda REUTILIZADA do núcleo. `inventory_loaded` é a listagem que a
/// chamada acabou de ler; `known_before` recebe "sem prova de posse" — para a
/// evicção, hash que o addon não subiu é acervo (ou proveniência desconhecida)
/// e nenhum dos dois autoriza remoção.
fn may_evict(peek: &DurablePeek, account: &str, row: &SweepMagnet, now: i64) -> bool {
    let hash = row.hash.as_str();
    let owned = crate::alldebrid::owns(account, hash) || peek.is_owned(account, hash, now);
    let protected = row.filename.trim().is_empty()
        || br_origin_mark(&row.filename)
        || is_held(account, hash)
        || peek.is_protected(account, hash, now);
    may_delete(DeleteFacts {
        inventory_loaded: true,
        known_before: !owned,
        protected,
    })
}

/// Estado da conta: para a chamada inteira, com a taxonomia intacta.
fn terminal(error: &DebridError) -> bool {
    matches!(error.kind(), "auth" | "quota" | "rate_limit" | "blocked")
}

/// `adapter:account` → `account` (a mesma conta de `adsub`/`adprot`/hold).
fn account_of(scope: &str) -> &str {
    scope
        .split_once(':')
        .map(|(_, account)| account)
        .unwrap_or("")
}
