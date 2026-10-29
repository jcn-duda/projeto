//! Posse durável (`adsub:v1`): a MESMA régua do Node para
//! `ALLDEBRID_SUBMITTED_TTL_MS` (`persistedSubmitted`/`hasDurableOwnership`,
//! `src/debrid/alldebrid-inventory.ts:117-132`). TTL <= 0 nega a posse — e a
//! evicção cai junto. Kill-switch que só vale de um lado é pior que nenhum:
//! o operador acha que desligou e o nativo apaga na conta do usuário.

use super::super::{
    ownership_enabled, ownership_enabled_from, submitted_ttl_ms_from, SUBMITTED_TTL_ENV,
};
use super::*;

/// A régua caso a caso, sem env global (a env só prova que ela é chamada).
#[test]
fn ownership_respeita_a_regua_do_node() {
    assert!(
        ownership_enabled_from(None),
        "default do Node: 7 dias de prova"
    );
    assert_eq!(submitted_ttl_ms_from(None), 604_800_000.0);
    assert!(
        !ownership_enabled_from(Some("0")),
        "TTL 0 = prova desligada"
    );
    assert!(!ownership_enabled_from(Some("")), "vazio = Number('') = 0");
    assert!(!ownership_enabled_from(Some("-1")));
    assert!(ownership_enabled_from(Some("86400000")));
    // Valor não numérico cai no default do `num()`, nunca em 0.
    assert_eq!(submitted_ttl_ms_from(Some("abc")), 604_800_000.0);
    assert!(ownership_enabled_from(Some("abc")));
}

/// A env REAL do processo (a mesma do `.env` que o Node lê): `0` desliga a
/// prova, TTL positivo devolve. Sem isso a régua acima seria código morto.
#[test]
fn ownership_enabled_le_alldebrid_submitted_ttl_ms() {
    let _lock = crate::test_env::lock();
    let previous = std::env::var(SUBMITTED_TTL_ENV).ok();
    unsafe { std::env::set_var(SUBMITTED_TTL_ENV, "0") };
    assert!(
        !ownership_enabled(),
        "ALLDEBRID_SUBMITTED_TTL_MS=0 nega a posse"
    );
    unsafe { std::env::set_var(SUBMITTED_TTL_ENV, "604800000") };
    assert!(ownership_enabled(), "TTL > 0 abre o gate");
    match previous {
        Some(value) => unsafe { std::env::set_var(SUBMITTED_TTL_ENV, value) },
        None => unsafe { std::env::remove_var(SUBMITTED_TTL_ENV) },
    }
}

/// `adsub` VIVO no banco e posse desligada: conjunto vazio, sem abrir o banco
/// (o path inexistente prova o curto-circuito). Ligada, o mesmo banco devolve o
/// hash — é daqui que o inventário e a porta tiram "é nosso".
#[test]
fn owned_hashes_com_ttl_zero_nao_concede_posse() {
    let account = account_scope("ad-sub-ttl");
    let now = crate::error::now_ms() as i64;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{\"at\":123}', ?2)",
            rusqlite::params![adsub_key(&account, &hash_of('a')), now + 60_000],
        )
        .unwrap();
    }
    let peek = DurablePeek::new(path);
    assert_eq!(
        peek.owned_hashes_when(&account, now, true),
        HashSet::from([hash_of('a')]),
        "ligado: adsub vivo é prova de posse"
    );
    assert_eq!(
        peek.owned_hashes_when(&account, now, false),
        HashSet::new(),
        "TTL 0: o mesmo adsub NÃO concede posse"
    );
    let sem_banco = DurablePeek::new(dir.path().join("nao-existe.db"));
    assert_eq!(
        sem_banco.owned_hashes_when(&account, now, false),
        HashSet::new(),
        "desligado não abre o banco"
    );
}

/// Leitura COM prova (`alive_checked`/`is_held_checked`): `Some(false)` é
/// ausência PROVADA; `None` é banco ilegível — quem apaga ou poda não pode
/// tratá-lo como "não protegido"/"sem hold".
#[test]
fn guarda_duravel_checked_distingue_ilegivel_de_ausente() {
    let account = account_scope("ad-durable-checked");
    let now = crate::error::now_ms() as i64;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
        )
        .unwrap();
        for (key, expires) in [
            (adprot_key(&account, &hash_of('a')), now + 60_000),
            (adhold_key(&account, &hash_of('b')), now + 60_000),
            (adhold_key(&account, &hash_of('c')), now - 1_000),
        ] {
            conn.execute(
                "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
                rusqlite::params![key, expires],
            )
            .unwrap();
        }
    }
    let peek = DurablePeek::new(&path);
    assert!(
        peek.is_protected(&account, &hash_of('a'), now),
        "adprot vivo é retenção (leitura simples, fail-open)"
    );
    assert_eq!(
        peek.alive_checked(&adprot_key(&account, &hash_of('z')), now),
        Some(false),
        "hash sem registro: ausência PROVADA"
    );
    assert_eq!(
        peek.is_held_checked(&account, &hash_of('b'), now),
        Some(true),
        "adhold vivo é hold provado"
    );
    assert_eq!(
        peek.is_held_checked(&account, &hash_of('c'), now),
        Some(false),
        "adhold expirado não é hold — e a ausência veio com prova"
    );
    // Ilegível: arquivo ausente e banco sem a tabela `cache`.
    assert_eq!(
        DurablePeek::new(dir.path().join("ausente.db")).is_held_checked(
            &account,
            &hash_of('a'),
            now
        ),
        None,
        "banco ausente não é ausência de hold"
    );
    let sem_tabela = dir.path().join("outra.db");
    rusqlite::Connection::open(&sem_tabela)
        .unwrap()
        .execute_batch("CREATE TABLE outra (id INTEGER);")
        .unwrap();
    assert_eq!(
        DurablePeek::new(&sem_tabela).is_held_checked(&account, &hash_of('a'), now),
        None,
        "schema ilegível não vira 'sem hold'"
    );
    assert!(
        !DurablePeek::new(dir.path().join("ausente.db")).readable(),
        "a sonda de legibilidade enxerga a mesma falha que o planejador usa"
    );
}
