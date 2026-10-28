//! Testes do overlay `cfg:v1:autofetch` → `Policy`.
//!
//! `std::env` é GLOBAL e os testes rodam em threads: todo caso que mexe nela
//! segura o `build::test_lock` (o MESMO `Mutex` de `policy_tests`/`build_tests`)
//! e devolve o ambiente no `Drop`. Os casos puros (overlay x `Policy` fixture)
//! não tocam env.
//!
//! O contrato provado aqui é o do painel: **live > `.env`**, com o `.env`
//! contradizendo o KV em todos os campos de tempo.

use adom_index::NativeKv;
use serde_json::json;

use super::{LiveOverlay, LIVE_KEY};
use crate::autofetch::build::test_lock;
use crate::autofetch::worker::AutofetchHandle;
use crate::autofetch::Policy;

/// Chaves do `Policy::from_env` que estes testes controlam.
const KEYS: [&str; 6] = [
    "DEBRID_AUTO_FETCH_TTL",
    "DEBRID_AUTO_FETCH_RECHECK_MS",
    "DEBRID_AUTO_FETCH_RECHECK_MAX",
    "DEBRID_AUTO_FETCH_STALL_STREAK",
    "DEBRID_AUTO_FETCH_SETTLE_MS",
    "DEBRID_AUTO_FETCH_DEAD_TTL",
];

/// Lock + env limpo, com restauração no fim do escopo.
struct EnvScope {
    /// Só existe para manter o guard vivo; o nome com `_` cala o `dead_code`.
    _lock: std::sync::MutexGuard<'static, ()>,
    saved: Vec<(&'static str, Option<String>)>,
}

impl EnvScope {
    fn new() -> Self {
        let lock = test_lock();
        let saved = KEYS
            .iter()
            .map(|key| (*key, std::env::var(key).ok()))
            .collect();
        for key in KEYS {
            std::env::remove_var(key);
        }
        Self { _lock: lock, saved }
    }

    fn set(&self, key: &str, value: &str) {
        std::env::set_var(key, value);
    }
}

impl Drop for EnvScope {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(raw) => std::env::set_var(key, raw),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// Sem linha no KV o overlay é vazio: o `.env` fica intacto, campo por campo.
#[test]
fn sem_override_vale_o_env_inteiro() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_TTL", "600");
    env.set("DEBRID_AUTO_FETCH_RECHECK_MS", "1000");
    env.set("DEBRID_AUTO_FETCH_DEAD_TTL", "7200");

    let base = Policy::from_env();
    assert_eq!(base.lot_ttl_seconds, 600);

    let empty = LiveOverlay::from_value(&json!({}));
    assert_eq!(empty.apply(&base), base);
    assert!(!empty.paused);
}

/// O caso do painel: o KV contradiz o `.env` e VENCE em todos os campos.
///
/// Cada asserção é um campo do `SCHEMA` que o worker nativo lia só da env antes
/// desta ponte (`mod.rs::Policy::from_env`, uma vez no boot).
#[test]
fn live_vence_o_env_nos_campos_de_tempo() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_TTL", "21600");
    env.set("DEBRID_AUTO_FETCH_RECHECK_MS", "120000");
    env.set("DEBRID_AUTO_FETCH_RECHECK_MAX", "3");
    env.set("DEBRID_AUTO_FETCH_STALL_STREAK", "3");
    env.set("DEBRID_AUTO_FETCH_SETTLE_MS", "900000");
    env.set("DEBRID_AUTO_FETCH_DEAD_TTL", "86400");

    let base = Policy::from_env();
    // Sanidade: o `.env` é o contraditório de verdade.
    assert_eq!(base.recheck_interval_ms, 120_000);
    assert_eq!(base.settle_interval_ms, 900_000);
    assert_eq!(base.dead_ttl_seconds, 86_400);
    assert_eq!(base.lot_ttl_seconds, 21_600);

    let overlay = LiveOverlay::from_value(&json!({
        "autoFetchTtl": 600,
        "autoFetchRecheckMs": 5000,
        "autoFetchRecheckMax": 1,
        "autoFetchStallStreak": 0,
        "autoFetchSettleMs": 60000,
        "autoFetchDeadTtl": 120,
    }));
    let policy = overlay.apply(&base);

    assert_eq!(policy.recheck_interval_ms, 5_000);
    assert_eq!(policy.recheck_max, 1);
    assert_eq!(policy.stall_streak, 0);
    assert_eq!(policy.settle_interval_ms, 60_000);
    assert_eq!(policy.dead_ttl_seconds, 120);
    // O TTL ao vivo move as QUATRO pontas (lote, marker, cofre, horizonte).
    assert_eq!(policy.lot_ttl_seconds, 600);
    assert_eq!(policy.marker_ttl_seconds, 600);
    assert_eq!(policy.key_ttl_ms, 600_000);
    assert_eq!(policy.settle_horizon_ms, 600_000);
    // O horizonte segue o TTL, nunca o `autoFetchSettleMs` do mesmo boletim.
    assert!(policy.settle_horizon_ms > policy.settle_interval_ms);
}

/// O clamp do painel é o do TS (`clampValue`), não o do KV do disco: um `99`
/// escrito à mão não vira teto de 99 torrents por busca.
#[test]
fn clamp_do_live_iguala_o_ts() {
    let base = Policy::fixture();
    let overlay = LiveOverlay::from_value(&json!({
        "autoFetchMax": 99,
        "autoFetchQueueDepth": 99,
        "autoFetchRecheckMax": -3,
        "autoFetchSettleMs": -1,
        "autoFetchStallStreak": 4.9,
    }));
    let policy = overlay.apply(&base);
    assert_eq!(policy.max_attempts, 12);
    assert_eq!(policy.queue_depth, 12);
    // `Math.max(0, ...)` — negativo no disco vira 0 (desligado), nunca pânico.
    assert_eq!(policy.recheck_max, 0);
    assert_eq!(policy.settle_interval_ms, 0);
    // `Math.trunc`: fração é truncada, não rejeitada.
    assert_eq!(policy.stall_streak, 4);
    // Campo fora do boletim continua no `.env`.
    assert_eq!(policy.max_settle_lots, base.max_settle_lots);
}

/// `dead_ttl` ao vivo com `0` NÃO pode virar permanente no KV nativo: o piso de
/// 1 s traduz o "desligado" do Node (mesma régua do `from_env`).
#[test]
fn dead_ttl_zero_do_painel_nao_vira_permanente() {
    let base = Policy::fixture();
    let policy = LiveOverlay::from_value(&json!({ "autoFetchDeadTtl": 0 })).apply(&base);
    assert_eq!(policy.dead_ttl_seconds, 1);
}

/// Valor torto no disco cai no `.env` — o boletim ilegível não derruba o ciclo.
#[test]
fn valor_torto_cai_no_env() {
    let base = Policy::fixture();
    let overlay = LiveOverlay::from_value(&json!({
        "autoFetchTtl": "muitas horas",
        "autoFetchRecheckMs": null,
        "autoFetchStallStreak": true,
        "paused": "sim",
    }));
    assert_eq!(overlay.apply(&base), base);
    assert!(!overlay.paused);
}

/// A linha é a que o NODE grava (`prefix('cfg')autofetch`), lida do `cache.db`.
#[test]
fn le_a_linha_que_o_node_grava() {
    let kv = NativeKv::open_memory().expect("kv");
    let now = 1_800_000_000_000;
    assert!(LiveOverlay::load(&kv, now).is_none());
    kv.put_json(
        LIVE_KEY,
        &json!({ "autoFetchRecheckMs": 7000, "paused": true }),
        600,
        now,
    )
    .expect("grava");
    let overlay = LiveOverlay::load(&kv, now).expect("overlay");
    assert!(overlay.paused);
    assert_eq!(overlay.apply(&Policy::fixture()).recheck_interval_ms, 7_000);
}

/// End-to-end do `build`: a MESMA sequência do `AutofetchHandle::build`
/// (`load_effective` + `apply`) lê a linha do `cache.db` com o `.env`
/// contradizendo. Se o nativo voltar a preferir a env, este caso quebra.
#[test]
fn kv_vence_o_env_no_caminho_do_build() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_TTL", "21600");
    env.set("DEBRID_AUTO_FETCH_RECHECK_MS", "120000");

    let kv = NativeKv::open_memory().expect("kv");
    let now = 1_800_000_000_000;
    kv.put_json(
        LIVE_KEY,
        &json!({ "autoFetchTtl": 600, "autoFetchRecheckMs": 5000 }),
        0,
        now,
    )
    .expect("grava");

    let (_, overlay) = crate::autofetch::worker::load_effective(&kv);
    let policy = overlay.expect("overlay").apply(&Policy::from_env());

    assert_eq!(policy.lot_ttl_seconds, 600, "live > env no ttl");
    assert_eq!(policy.recheck_interval_ms, 5_000, "live > env no recheck");
    // O `.env` ainda manda no que o boletim não trouxe.
    assert_eq!(policy.recheck_max, Policy::from_env().recheck_max);
}

/// Fiação do boot: o worker nasce PAUSADO quando o painel está pausado, mesmo
/// sem nada em `autofetch-worker:v1:config` (o botão grava as duas chaves, mas
/// um restart com só a do Node não pode religar o Chupim).
#[test]
fn worker_nasce_pausado_com_o_painel() {
    let _lock = test_lock();
    let kv = NativeKv::open_memory().expect("kv");
    let now = 1_800_000_000_000;
    kv.put_json(LIVE_KEY, &json!({ "paused": true }), 600, now)
        .expect("grava");

    let handle = AutofetchHandle::with_store(kv.into());
    assert!(handle.status().paused);
    assert!(handle.config().paused);
}

/// A pausa do painel FORÇA, nunca retira: `paused:false` no boletim não mexe na
/// admin do gateway (senão o `POST /autofetch/pause` não retomaria sozinho).
#[test]
fn pausa_do_painel_so_soma() {
    let _lock = test_lock();
    let kv = NativeKv::open_memory().expect("kv");
    let now = 1_800_000_000_000;
    kv.put_json(LIVE_KEY, &json!({ "paused": false }), 600, now)
        .expect("grava");

    let handle = AutofetchHandle::with_store(kv.into());
    assert!(!handle.status().paused);
}
