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
//!    inventário lido + posse provada + nada protegido.
//! 4. **Posse com CARIMBO.** A posse vem do memo desta instância
//!    (`alldebrid_owned.rs`) ou do `adsub:v1` durável, que traz `{at}` em ms —
//!    é a idade da posse. `adrm:v1` (hash que a limpeza apagou DE PROPÓSITO)
//!    **nega** a posse: registro de remoção intencional nunca autoriza remover
//!    de novo.
//! 5. **Idade mínima nas DUAS medidas.** `DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS`
//!    (default 30 min) precisa ser cumprido pelo `uploadDate` da conta E pelo
//!    carimbo da posse; upload POSTERIOR à posse + `DEBRID_RECONCILE_AGE_MARGIN_MS`
//!    (default 10 min) é re-add do usuário — o acervo mudou de dono, nunca sai.
//!    Sem `uploadDate` legível não há prova de que é o MESMO magnet: não sai.
//! 6. **Proteção em duas camadas.** Hold do Node (`adhold:v1`, lido do
//!    `cache.db` — o `Holds` DESTE processo não é preenchido em produção), hold
//!    em processo (`cleanup_holds`), retenção BR `adprot:v1` e nome com marca BR
//!    (`br_origin_mark`, a blindagem destrutiva do invariante 2). Nome ausente
//!    conta como protegido.
//! 7. **Fail-closed em cada ausência.** Sem `cache.db` — ou com ele ILEGÍVEL —
//!    não há `adsub`/`adprot`/`adrm`/`adhold` legível, e "não protegido" sai
//!    igual a "não possuído": a chamada recusa (`inventory_missing`) em vez de
//!    apagar às cegas.
//! 8. **Kill-switch próprio + teto.** `DEBRID_AUTO_FETCH_EVICT_FALLBACK` é a
//!    MESMA env do Node (default OFF) e `DEBRID_AL_CLEANUP_KILL` desliga por
//!    cima; `DEBRID_EVICT_MAX_PER_CALL` (default 25) limita os deletes de rede
//!    de UMA chamada. Hash vetado pela guarda não gasta o teto.
//! 9. **Quem apaga não marca.** O `cache.db` é do Node e este crate só LÊ: o
//!    `adrm` do hash removido e a purga do `adsub` são do chamador, com o que
//!    voltar em `Ok` (o TS faz isso em `alldebrid-fallback-evict.ts:132-133`).

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
/// Idade mínima do hash na conta e da posse (`acceptedAt` do TS).
pub(super) const EVICT_MIN_AGE_ENV: &str = "DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS";
/// Margem do anti-re-add (env do reconcile, `600_000` no TS).
pub(super) const EVICT_MARGIN_ENV: &str = "DEBRID_RECONCILE_AGE_MARGIN_MS";
/// Default do teto (o mesmo `HARVEST_EVICT_MAX_PER_SEARCH` do Node, 25).
const DEFAULT_MAX_PER_CALL: usize = 25;
/// Default da idade mínima (`config/debrid-evict.ts:16`).
const DEFAULT_MIN_AGE_MS: i64 = 1_800_000;
/// Default da margem anti-re-add (`config/debrid-reconcile.ts:25`).
const DEFAULT_MARGIN_MS: i64 = 600_000;

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

fn min_age() -> i64 {
    min_age_from(std::env::var(EVICT_MIN_AGE_ENV).ok().as_deref())
}

/// Idade mínima (ms) medida na conta e na posse. Ausente/ilegível cai no
/// default; `0` explícito é opt-out do operador (paridade com o `Math.max(0, …)`
/// do TS, que aceita zero).
pub(super) fn min_age_from(raw: Option<&str>) -> i64 {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(DEFAULT_MIN_AGE_MS)
}

fn margin() -> i64 {
    margin_from(std::env::var(EVICT_MARGIN_ENV).ok().as_deref())
}

/// Margem do anti-re-add: `uploadDate > posse + margem` = re-add do usuário.
pub(super) fn margin_from(raw: Option<&str>) -> i64 {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(DEFAULT_MARGIN_MS)
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
        // Banco presente mas ILEGÍVEL (ausente no disco, WAL travado, schema
        // estranho) responde "não protegido" igual a "não possuído": a guarda
        // não prova nada. Zero deletes — `inventory_missing`, explícito.
        let peek = DurablePeek::new(db_path);
        if !peek.readable() {
            return Err(PortError::Debrid(DebridError::other(
                "evict sem inventário legível (cache.db): guarda durável adsub/adprot/adrm/adhold indisponível",
            )));
        }
        // Falha aqui é `Err`: a listagem vazia só significa "conta vazia" quando
        // a conta respondeu com uma lista.
        let rows = service.magnet_index(&self.api_key).await?;
        let account = account_of(&self.scope);
        let now = now_ms() as i64;
        let (min_age_ms, margin_ms) = (min_age(), margin());
        let mut by_hash: HashMap<&str, &SweepMagnet> = HashMap::new();
        for row in &rows {
            by_hash.entry(row.hash.as_str()).or_insert(row);
        }
        let cap = max_per_call();
        let mut removed: Vec<String> = Vec::new();
        let mut deleted: HashSet<&str> = HashSet::new();
        let mut vetoed: HashMap<&'static str, usize> = HashMap::new();
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
            if deleted.contains(id) {
                continue;
            }
            match evict_gate(proof_for(&peek, account, row, now, min_age_ms, margin_ms)) {
                Ok(()) => {}
                // Vetado não gasta teto e não é retornado; o motivo é contado
                // uma vez no fim (nunca um log por hash).
                Err(reason) => {
                    *vetoed.entry(reason.as_str()).or_default() += 1;
                    continue;
                }
            }
            if calls >= cap {
                break;
            }
            calls += 1;
            deleted.insert(id);
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
        if !vetoed.is_empty() {
            let total: usize = vetoed.values().sum();
            eprintln!("[debrid] evict: {total} hash(es) vetado(s) pela guarda {vetoed:?}");
        }
        Ok(removed)
    }
}

/// Fatos MEDIDOS que a guarda exige. Nenhum é inventado: `stamp`/`held`/
/// `protected`/`blocked` saem do `cache.db` do Node (e do memo desta instância)
/// e `upload_date_ms` sai da linha da conta.
#[derive(Clone, Copy)]
pub(super) struct EvictProof {
    /// `uploadDate` da linha, em ms (0.0 = a API não mandou).
    pub(super) upload_date_ms: f64,
    /// `at` do `adsub` vivo; `None` = sem carimbo de posse.
    pub(super) stamp: Option<i64>,
    /// Posse pelo memo desta instância (`alldebrid_owned.rs`).
    pub(super) in_process_owned: bool,
    /// Hold volátil: do Node (`adhold`) ou desta instância.
    pub(super) held: bool,
    /// Retenção `adprot` ou nome com marca BR/ausente.
    pub(super) protected: bool,
    /// `adrm` vivo: hash que a limpeza apagou DE PROPÓSITO.
    pub(super) blocked: bool,
    pub(super) now: i64,
    pub(super) min_age_ms: i64,
    pub(super) margin_ms: i64,
}

/// Por que um hash NÃO foi apagado. Puro e testável: cada regra tem um motivo
/// próprio, então um teste que doa sabe exatamente qual guarda barrou.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EvictSkip {
    ReuploadBlocked,
    Protected,
    NoOwnership,
    NoStamp,
    NoUploadDate,
    Readded,
    TooYoung,
}

impl EvictSkip {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::ReuploadBlocked => "adrm",
            Self::Protected => "protected",
            Self::NoOwnership => "no-ownership",
            Self::NoStamp => "no-stamp",
            Self::NoUploadDate => "no-upload-date",
            Self::Readded => "readded",
            Self::TooYoung => "too-young",
        }
    }
}

/// Fatos da linha + banco para um hash. `inventory_loaded` NÃO entra aqui: a
/// chamada só chega neste ponto com o banco legível (regra 7), então ela
/// carrega `true` — dizer `false` no gate seria mentira em dobro.
fn proof_for(
    peek: &DurablePeek,
    account: &str,
    row: &SweepMagnet,
    now: i64,
    min_age_ms: i64,
    margin_ms: i64,
) -> EvictProof {
    let hash = row.hash.as_str();
    EvictProof {
        upload_date_ms: row.upload_date_ms,
        stamp: peek.owned_at(account, hash, now),
        in_process_owned: crate::alldebrid::owns(account, hash),
        held: is_held(account, hash) || peek.is_held(account, hash, now),
        protected: row.filename.trim().is_empty()
            || br_origin_mark(&row.filename)
            || peek.is_protected(account, hash, now),
        blocked: peek.is_reupload_blocked(account, hash, now),
        now,
        min_age_ms,
        margin_ms,
    }
}

/// A guarda única. Ordem: prova de remoção (o `may_delete` do núcleo), depois
/// as duas idades. Fail-closed em toda ausência — sem carimbo, sem `uploadDate`
/// ou com idade curta, ninguém sai.
pub(super) fn evict_gate(proof: EvictProof) -> Result<(), EvictSkip> {
    // `adrm` NEGA a posse: quem apagou de propósito não é dono do que sobrou.
    let owned = (proof.stamp.is_some() || proof.in_process_owned) && !proof.blocked;
    let protected = proof.held || proof.protected;
    if !may_delete(DeleteFacts {
        inventory_loaded: true,
        known_before: !owned,
        protected,
    }) {
        return Err(if proof.blocked {
            EvictSkip::ReuploadBlocked
        } else if protected {
            EvictSkip::Protected
        } else {
            EvictSkip::NoOwnership
        });
    }
    // Posse SÓ no memo desta instância não tem carimbo: sem idade provada, não
    // há como descartar re-add do usuário. `adsub` com `{at}` é a prova.
    let Some(stamp) = proof.stamp else {
        return Err(EvictSkip::NoStamp);
    };
    if !proof.upload_date_ms.is_finite() || proof.upload_date_ms <= 0.0 {
        return Err(EvictSkip::NoUploadDate);
    }
    let upload = proof.upload_date_ms as i64;
    // Anti-re-add (mesma regra do `alldebrid-fallback-evict.ts:114`): upload
    // posterior à etiqueta + margem é acervo do usuário de novo.
    if upload > stamp.saturating_add(proof.margin_ms) {
        return Err(EvictSkip::Readded);
    }
    // Idade mínima nas DUAS medidas: a conta e a posse precisam ser velhas.
    if proof.now.saturating_sub(upload) < proof.min_age_ms
        || proof.now.saturating_sub(stamp) < proof.min_age_ms
    {
        return Err(EvictSkip::TooYoung);
    }
    Ok(())
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
