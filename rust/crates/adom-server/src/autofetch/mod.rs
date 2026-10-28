//! Worker NATIVO do Chupim no gateway — ciclo completo, LIGADO só por
//! `AUTOFETCH_WORKER=on`.
//!
//! O ciclo inteiro (cofre, enfileiramento, recheck e laço) existe desde a leva
//! anterior atrás de uma trava explícita: sem `AUTOFETCH_WORKER=on` **nada**
//! consome o canal, `phase` continua `"prepared"` e nenhuma fila é escrita. O
//! boot agora MONTA a fábrica de produção ([`build`]) quando a trava está
//! ligada; sem ela o caminho é o mesmo de antes (nenhum cliente HTTP é criado).
//!
//! # Peças e donos
//!
//! - [`vault`] — cofre em MEMÓRIA da chave por `adapter:conta`, alimentado pelo
//!   `encoded` da busca (TTL de ~6h, LRU, nunca em KV/disco/log/`Debug`);
//! - [`enqueue`] — lote `autofetch_batch` → cascata + portões + fila
//!   (`autofetch:v3:q:`), ESCRITOR ÚNICO da fila;
//! - [`recheck`] — lote em `autofetch:v3:lot:` (hashes, streaks, adapter,
//!   `createdAt`), passo de recheck, terminal → `dead:` + dreno do próximo,
//!   settle LRU e expiração com prova de posse;
//! - [`serve`] — laço da thread (`current_thread`) sobre canal `mpsc` + timers
//!   lidos dos lotes; o adaptador de debrid entra pela fábrica por conta;
//! - [`season_fill`] — lado do PACK: o release que ficou pronto invalida no
//!   cache de streams as buscas da temporada registradas por `season_key`;
//! - [`ports`] — adaptador do trait do crate sobre as portas do `adom-debrid` e
//!   a FÁBRICA (`scope` → adaptador, chave lida do cofre no momento do uso);
//! - [`build`] — fábrica de PRODUÇÃO (cinco serviços, gate RD único, fatos da
//!   AllDebrid do `cache.db`);
//! - [`rd_store`] — intent durável do RD (`rdq:v1:uncertain:`) e peek do ledger;
//! - [`boot`] — abertura do KV, trava do worker e o handle ÚNICO do boot;
//! - [`control`] — pausa/intervalo/contadores que o painel lê;
//! - [`worker`] — config/painel (`autofetch-worker:v1:config`) e o handler.
//!
//! # Credencial de usuário
//!
//! A chave do debrid (`dk`) **nunca** entra no KV nem em log. O contrato é o de
//! `docs/autofetch-worker-credential-gate.md`, opção (2): a fila
//! (`autofetch:v3:q:`), o marker (`autofetch:v3:m:`) e a blacklist
//! (`autofetch:v3:dead:`) não guardam credencial por desenho, e o que o gateway
//! persiste aqui é só `autofetch-worker:v1:config` (`paused` + `intervalMs`). A
//! chave vive no [`vault`] e morre com o processo (restart perde os lotes, como
//! no Node).
//!
//! Rotas (montadas na admin do store, `127.0.0.1:8711`, loopback + token):
//! `GET /autofetch`, `POST /autofetch/config|pause|drain|suppressed-drain`.

mod boot;
mod build;
mod control;
mod enqueue;
mod enqueue_drain;
mod enqueue_items;
mod index_record;
// Evicção F6: a régua pura (`evict_step`) é consumida pelo `evict_job` de
// `serve`, que lê os fatos do KV e chama a porta da AllDebrid. Kill-switch
// próprio (`DEBRID_AUTO_FETCH_EVICT_FALLBACK`, default OFF) e orçamento por
// passagem moram no executor. O `allow` cobre a PORTA ANTIGA (`plan`/`run`),
// que num alvo de bin só tem chamador no golden — ela é o oráculo do TS.
#[allow(dead_code)]
mod evict_step;
// O adaptador (`PortedDebrid`) e a fábrica já são usados no boot; `scope`,
// `service` e `capabilities` só têm chamador nos testes, e o alvo de bin os vê
// como mortos — o `allow` evita ruído de `dead_code`.
#[allow(dead_code)]
mod ports;
mod probe_job;
mod probe_step;
mod rd_store;
mod recheck;
mod recheck_expire;
mod recheck_poll;
mod routes;
mod season_fill;
mod season_step;
mod serve;
mod suppressed_step;
mod vault;
mod worker;

pub(crate) use routes::router as admin_router;
pub(crate) use vault::{shared as shared_vault, Vault};
pub(crate) use worker::{spawn, AutofetchHandle};
// O `Job` atravessa a fronteira do módulo pelo seam do tail (`NativeWorkQueue`).
pub(crate) use enqueue::Job;

/// Ponte de produção do canal: o seam do tail só conhece o kind, o escopo e o
/// payload, e quem monta o `Job` é o dono do tipo.
///
/// `br_probe` sem colhedor montado é RECUSADO aqui: o efeito não pode ser
/// marcado `Native` e morrer na fila do worker (o passo precisa do
/// `HarvestHandle` para enfileirar a obra). Recusar devolve o efeito ao Node,
/// que é quem sabe sondar enquanto não há colhedor.
impl crate::tail_effects::NativeWorkQueue for AutofetchHandle {
    fn enabled(&self) -> bool {
        self.status().enabled
    }

    fn submit(
        &self,
        kind: &str,
        scope: &str,
        payload: &serde_json::Map<String, serde_json::Value>,
    ) -> bool {
        if kind == crate::tail_effects::BR_PROBE && self.harvest().is_none() {
            return false;
        }
        AutofetchHandle::submit(
            self,
            Job {
                kind: kind.to_string(),
                scope: scope.to_string(),
                payload: payload.clone(),
            },
        )
    }
}

/// Prefixo da fila por busca (`autofetch:v3:q:<sha256(searchKey)>`), o mesmo do
/// `queueKey` do Node.
pub(crate) const QUEUE_PREFIX: &str = "autofetch:v3:q:";
/// Prefixo do lote de recheck persistido (`autofetch:v3:lot:<sha256>`).
pub(crate) const LOT_PREFIX: &str = "autofetch:v3:lot:";

/// Chave do lote de recheck. O sufixo é o digest da busca (mesma régua da fila)
/// para o lote nunca carregar texto livre do usuário.
pub(crate) fn lot_key(search_key: &str) -> String {
    format!("{LOT_PREFIX}{}", adom_autofetch::v3::sha256_hex(search_key))
}

/// `AUTOFETCH_WORKER=on` — o ÚNICO jeito de o ciclo consumir o canal. Vazio,
/// `off` ou qualquer outro valor mantém o worker em `prepared`.
pub(crate) fn worker_enabled() -> bool {
    std::env::var("AUTOFETCH_WORKER").map(|value| value == "on") == Ok(true)
}

/// Réguas do ciclo. Os defaults são os MESMOS do Node
/// (`src/config/debrid.ts`), para o flip não mudar comportamento às cegas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    /// `autoFetchMax` — torrents por busca.
    pub(crate) max_attempts: i64,
    /// Profundidade da fila v3 (o `depth` do `writeQueue`). `0` desliga a fila,
    /// como no `Math.min(12, Math.max(0, num(env, 6)))` de `config/debrid.ts`.
    pub(crate) queue_depth: usize,
    /// `autoFetchQueueTtl` — TTL da fila persistida.
    pub(crate) queue_ttl_seconds: i64,
    /// `autoFetchTtl` — TTL do lote de recheck e do marker.
    pub(crate) lot_ttl_seconds: i64,
    pub(crate) marker_ttl_seconds: i64,
    /// Janela da blacklist de mortas.
    pub(crate) dead_ttl_seconds: i64,
    /// `autoFetchRecheckMs` — intervalo entre passagens de um lote.
    pub(crate) recheck_interval_ms: i64,
    /// `autoFetchRecheckMax` — passagens antes de entrar em settle.
    pub(crate) recheck_max: i64,
    /// `autoFetchStallStreak` (`DEBRID_AUTO_FETCH_STALL_STREAK`, default `3`) —
    /// rechecks consecutivos "parado" antes de tratar o download como morto;
    /// `0` desliga a detecção. Régua copiada de `src/config/debrid.ts:236`:
    /// `Math.max(0, Math.trunc(num(env, 3)))`.
    ///
    /// Consumido em `recheck::poll` (`stall_threshold`) — `0` desliga a
    /// detecção, como no Node.
    pub(crate) stall_streak: i64,
    /// `autoFetchSettleMs` (`DEBRID_AUTO_FETCH_SETTLE_MS`, default `900_000`) —
    /// INTERVALO entre passagens de um lote JÁ em settle, o `armRecheck` do
    /// Node (`src/providers/autofetch-recheck.ts:38`).
    ///
    /// NÃO é o horizonte de expiração, e não pode virar um: no Node quem expira
    /// é `createdAt + autoFetchTtl * 1000`
    /// (`src/providers/autofetch-recheck.ts:347`). Com 900 s aqui, um lote em
    /// settle venceria aos 15 min e `recheck_expire` chamaria `remove(id)` numa
    /// transferência que ainda baixa — fora da AllDebrid
    /// `expired_removal_allowed` devolve `true`
    /// (`adom-core/src/autofetch_expired.rs:43`). Por isso o horizonte continua
    /// preso ao TTL do lote (ver `settle_horizon_ms`).
    ///
    /// Consumido em `recheck::due_at` (`lot.is_settle ? este : recheck`).
    pub(crate) settle_interval_ms: i64,
    /// Horizonte do settle (`autoFetchTtl * 1000`, o `createdAt + autoFetchTtl`
    /// do Node em `src/providers/autofetch-recheck.ts:347`).
    ///
    /// O TETO é o TTL do lote (`lot_ttl_seconds`) e ele VENCE: cada gravação do
    /// lote re-arma a chave por `lot_ttl_seconds` (`recheck::write`), e `NativeKv`
    /// apaga o que venceu (`adom-index/src/kv.rs:174`). Um horizonte MAIOR que o
    /// TTL só seria alcançado se nenhuma passagem atrasasse mais que o TTL —
    /// laço pausado, worker parado ou restart deixam a chave expirar e o lote
    /// some ANTES do horizonte, sem passar por `LotOutcome::Expired`
    /// (`adom-autofetch/src/v3/recheck.rs:148`): sem lote não há prova de posse e
    /// o hash fica órfão na conta. Por isso o horizonte nasce da MESMA variável do
    /// TTL em `from_env`, e não da env do settle: o que o operador controla é o
    /// TTL, e o horizonte nunca passa dele.
    pub(crate) settle_horizon_ms: i64,
    /// `autoFetchSettleMaxLots` — teto do LRU de lotes em settle.
    pub(crate) max_settle_lots: usize,
    /// TTL da chave no cofre (mesma régua do autofetch).
    pub(crate) key_ttl_ms: i64,
    /// Teto de contas no cofre (LRU).
    pub(crate) vault_cap: usize,
    /// `DEBRID_REMOVE_BY_ID` — freio de rollout da remoção de uma transferência
    /// identificada SÓ pelo id (`via === 'id'`). Nasce DESLIGADO no Node
    /// (`src/config/debrid.ts:243`) e não tem controle no painel: é variável de
    /// `.env`, lida no boot como as outras réguas do ciclo.
    ///
    /// Consumido em `recheck_expire` (`remove_by_id_enabled`): com ele OFF o
    /// hash identificado por id vai para a represa (`sup:`) em vez de virar
    /// `remove` — o mesmo `policyOk = via !== 'id' || removeById` do TS
    /// (`src/providers/autofetch-recheck.ts:340`). Hash visto por HASH remove
    /// sempre, com ou sem o knob.
    pub(crate) remove_by_id: bool,
}

impl Policy {
    pub(crate) fn from_env() -> Self {
        let ttl = env_num("DEBRID_AUTO_FETCH_TTL", 6 * 3_600).max(1);
        // UMA variável, dois usos que não podem divergir: o TTL gravado na chave
        // do lote e o horizonte que o expira. `saturating_mul` porque env absurda
        // não pode virar overflow (em debug, pânico).
        let lot_ttl_ms = ttl.saturating_mul(1_000);
        Self {
            max_attempts: env_num("DEBRID_AUTO_FETCH_MAX", 3).clamp(1, 12),
            queue_depth: env_num("DEBRID_AUTO_FETCH_QUEUE_DEPTH", 6).clamp(0, 12) as usize,
            queue_ttl_seconds: env_num("DEBRID_AUTO_FETCH_QUEUE_TTL", 86_400).max(1),
            lot_ttl_seconds: ttl,
            marker_ttl_seconds: ttl,
            // `autoFetchDeadTtl`: `num(env, 86400)`, sem piso no TS
            // (`src/config/debrid.ts:259`). O piso 1 aqui traduz a GUARDA do
            // consumidor do Node: TTL <= 0 desliga a blacklist por retorno
            // antecipado (`src/providers/autofetch.ts:120`), mas no KV nativo
            // `ttl <= 0` grava PERMANENTE (`adom-index/src/kv.rs:12`) — o `0` do
            // operador viraria `dead:` eterno. Com 1 s a marca some antes da
            // passagem seguinte: mesmo efeito observável de "desligado".
            dead_ttl_seconds: env_num("DEBRID_AUTO_FETCH_DEAD_TTL", 86_400).max(1),
            recheck_interval_ms: env_num("DEBRID_AUTO_FETCH_RECHECK_MS", 120_000).max(0),
            recheck_max: env_num("DEBRID_AUTO_FETCH_RECHECK_MAX", 3).max(0),
            // `Math.max(0, Math.trunc(num(env, 3)))` — `src/config/debrid.ts:236`.
            stall_streak: env_num("DEBRID_AUTO_FETCH_STALL_STREAK", 3).max(0),
            // `num(env, 900_000)`, sem piso/teto no TS
            // (`src/config/debrid.ts:260`). Negativo vira 0, como o `setTimeout`
            // do Node (intervalo negativo dispara na hora).
            settle_interval_ms: env_num("DEBRID_AUTO_FETCH_SETTLE_MS", 900_000).max(0),
            settle_horizon_ms: lot_ttl_ms,
            max_settle_lots: env_num("DEBRID_AUTO_FETCH_SETTLE_MAX_LOTS", 50).max(1) as usize,
            // Mesma régua do lote, e a MESMA variável: o cofre não pode vencer
            // antes nem depois do lote que ele serve (env absurda não estoura —
            // era `ttl * 1_000`, que virava pânico em debug).
            key_ttl_ms: lot_ttl_ms,
            vault_cap: env_num("DEBRID_AUTO_FETCH_VAULT_MAX", 64).clamp(1, 1_024) as usize,
            remove_by_id: env_flag("DEBRID_REMOVE_BY_ID"),
        }
    }

    /// Réguas fixas para teste: nenhuma env do processo entra na conta.
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self {
            max_attempts: 3,
            queue_depth: 6,
            queue_ttl_seconds: 86_400,
            lot_ttl_seconds: 21_600,
            marker_ttl_seconds: 21_600,
            dead_ttl_seconds: 86_400,
            recheck_interval_ms: 120_000,
            recheck_max: 3,
            stall_streak: 3,
            settle_interval_ms: 900_000,
            settle_horizon_ms: 21_600_000,
            max_settle_lots: 50,
            key_ttl_ms: 21_600_000,
            vault_cap: 4,
            remove_by_id: false,
        }
    }
}

fn env_num(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

/// Flag de env com a régua do NODE: só o literal `true` liga
/// (`String(env || 'false') === 'true'`, `src/config/debrid.ts:243`). Sem
/// `trim`: `" true"` continua desligado, como no operador do TS.
fn env_flag(key: &str) -> bool {
    std::env::var(key).map(|value| value == "true") == Ok(true)
}

#[cfg(test)]
mod fakes;
#[cfg(test)]
#[path = "policy_tests.rs"]
mod policy_tests;
#[cfg(test)]
mod tests;
