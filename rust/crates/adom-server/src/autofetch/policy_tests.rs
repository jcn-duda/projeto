//! Testes da cadeia `env → Policy` (`from_env`), com a régua do Node.
//!
//! `std::env` é GLOBAL e os testes rodam em threads: todo teste daqui segura o
//! `build::test_lock` (o MESMO `Mutex` dos testes de gate e de boot) e devolve o
//! ambiente ao estado anterior no `Drop`, mesmo quando a asserção falha.
//!
//! Cada caso cobre as três pernas da cadeia pedida: env ausente = default do TS;
//! env válida muda o comportamento observável; env inválida cai no default sem
//! pânico.

use adom_autofetch::v3::QueueV3;
use adom_index::NativeKv;

use super::Policy;
use crate::autofetch::build::test_lock;

/// Chaves que estes testes tocam. `DEBRID_AUTO_FETCH_TTL` entra porque é dele
/// que nasce o horizonte do settle.
const KEYS: [&str; 4] = [
    "DEBRID_AUTO_FETCH_SETTLE_MS",
    "DEBRID_AUTO_FETCH_DEAD_TTL",
    "DEBRID_AUTO_FETCH_STALL_STREAK",
    "DEBRID_AUTO_FETCH_TTL",
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

    fn unset(&self, key: &str) {
        std::env::remove_var(key);
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

/// Env ausente = os defaults de `src/config/debrid.ts`.
#[test]
fn env_ausente_usa_os_defaults_do_ts() {
    let env = EnvScope::new();

    let policy = Policy::from_env();
    // `num(env, 900_000)` — config/debrid.ts:260.
    assert_eq!(policy.settle_interval_ms, 900_000);
    // `num(env, 86400)` — config/debrid.ts:259.
    assert_eq!(policy.dead_ttl_seconds, 86_400);
    // `Math.max(0, Math.trunc(num(env, 3)))` — config/debrid.ts:236.
    assert_eq!(policy.stall_streak, 3);
    // Horizonte = TTL do lote (6 h), o `createdAt + autoFetchTtl * 1000`.
    assert_eq!(policy.lot_ttl_seconds, 21_600);
    assert_eq!(policy.settle_horizon_ms, 21_600_000);

    // Divergência CONHECIDA e mantida: string vazia aqui é "não configurado" e
    // cai no default; no Node o `num` faz `Number('') === 0`, que é finito e
    // viraria 0. O helper `env_num` é anterior a esta leva e vale para todas as
    // réguas do ciclo — trocar isso mudaria todos os knobs de uma vez.
    env.set("DEBRID_AUTO_FETCH_SETTLE_MS", "");
    assert_eq!(Policy::from_env().settle_interval_ms, 900_000);
}

/// Env válida muda o campo (e, no caso do `dead_ttl`, o efeito no KV).
#[test]
fn env_valida_muda_o_valor_da_politica() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_SETTLE_MS", "45000");
    env.set("DEBRID_AUTO_FETCH_DEAD_TTL", "3600");
    env.set("DEBRID_AUTO_FETCH_STALL_STREAK", "7");

    let policy = Policy::from_env();
    assert_eq!(policy.settle_interval_ms, 45_000);
    assert_eq!(policy.dead_ttl_seconds, 3_600);
    assert_eq!(policy.stall_streak, 7);
    // O horizonte do settle NÃO segue o knob do settle: segue o TTL do lote.
    assert_eq!(policy.settle_horizon_ms, 21_600_000);
}

/// O `dead_ttl` da env chega ao KV: a marca `dead:` vence no prazo configurado.
///
/// Este é o consumidor REAL do campo hoje (`recheck.rs:298` passa
/// `policy.dead_ttl_seconds` para `mark_dead`), então o teste prova o efeito
/// observável, não só o campo.
#[test]
fn dead_ttl_da_env_define_a_validade_da_blacklist() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_DEAD_TTL", "7200");

    let policy = Policy::from_env();
    let kv = NativeKv::open_memory().unwrap();
    let queue = QueueV3::new(&kv);
    let now = adom_sources::now_ms();
    let hash = "a".repeat(40);

    queue
        .mark_dead("alldebrid", "conta", &hash, policy.dead_ttl_seconds, now)
        .unwrap();
    assert!(queue.is_dead("alldebrid", "conta", &hash, now + 1).unwrap());
    // 2 h - 1 s: ainda vivo.
    assert!(queue
        .is_dead("alldebrid", "conta", &hash, now + 7_199_000)
        .unwrap());
    // Vencido: a marca sumiu (era 24 h fixas antes deste knob ser lido).
    assert!(!queue
        .is_dead("alldebrid", "conta", &hash, now + 7_200_000)
        .unwrap());
}

/// `DEBRID_AUTO_FETCH_DEAD_TTL=0` no Node DESLIGA a blacklist; no KV nativo
/// `ttl <= 0` grava permanente. O piso de 1 s é a tradução de "desligado" para
/// um seam que não sabe "não gravar".
#[test]
fn dead_ttl_zero_nao_vira_permanente() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_DEAD_TTL", "0");

    let policy = Policy::from_env();
    assert_eq!(policy.dead_ttl_seconds, 1);

    let kv = NativeKv::open_memory().unwrap();
    let queue = QueueV3::new(&kv);
    let now = adom_sources::now_ms();
    let hash = "b".repeat(40);
    queue
        .mark_dead("alldebrid", "conta", &hash, policy.dead_ttl_seconds, now)
        .unwrap();
    assert!(!queue
        .is_dead("alldebrid", "conta", &hash, now + 60_000)
        .unwrap());
}

/// Env inválida (texto, fração, sinal solto) cai no default do TS — nunca pânico.
#[test]
fn env_invalida_cai_no_default_sem_panico() {
    let env = EnvScope::new();
    for raw in ["abc", "1.5", "12,5", "0x10", "--3", "900000ms"] {
        env.set("DEBRID_AUTO_FETCH_SETTLE_MS", raw);
        env.set("DEBRID_AUTO_FETCH_DEAD_TTL", raw);
        env.set("DEBRID_AUTO_FETCH_STALL_STREAK", raw);

        let policy = Policy::from_env();
        assert_eq!(policy.settle_interval_ms, 900_000, "settle: {raw}");
        assert_eq!(policy.dead_ttl_seconds, 86_400, "dead: {raw}");
        assert_eq!(policy.stall_streak, 3, "stall: {raw}");
    }
}

/// Piso do stall: negativo vira 0 (`Math.max(0, ...)`), e 0 é "desligado".
#[test]
fn stall_streak_negativo_vira_zero() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_STALL_STREAK", "-2");
    assert_eq!(Policy::from_env().stall_streak, 0);
}

/// O horizonte acompanha o TTL do lote — e o TTL é o TETO.
///
/// `LotOutcome::Expired` só roda se a chave do lote ainda estiver no KV
/// (`adom-index/src/kv.rs:174`), por isso o horizonte não pode passar do TTL:
/// um valor maior nunca seria alcançado.
#[test]
fn horizonte_do_settle_nunca_passa_do_ttl_do_lote() {
    let env = EnvScope::new();
    env.set("DEBRID_AUTO_FETCH_TTL", "600");
    let policy = Policy::from_env();
    assert_eq!(policy.lot_ttl_seconds, 600);
    assert_eq!(policy.settle_horizon_ms, 600_000);
    assert!(policy.settle_horizon_ms <= policy.lot_ttl_seconds * 1_000);

    // TTL absurdo não estoura (saturating): a env não pode virar pânico.
    env.set("DEBRID_AUTO_FETCH_TTL", "9223372036854775807");
    let policy = Policy::from_env();
    assert_eq!(policy.settle_horizon_ms, i64::MAX);

    env.unset("DEBRID_AUTO_FETCH_TTL");
    assert_eq!(Policy::from_env().settle_horizon_ms, 21_600_000);
}
