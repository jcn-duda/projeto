//! Provas do `MagnetStateStore`: `bad` apaga o `alive` do mesmo hash na mesma
//! transação, precedência `bad > lie > alive`, recusa de `alive` com `bad` vivo,
//! TTL (0 = janela desligada: nada grava) e a contagem de chaves nascidas.
//!
//! Fixtures usam a forma VÁLIDA da chave (`40 hex` minúsculos): desde a T2-L5b
//! hash fora disso é ignorado pela guarda, e `"aaaa"` não nasceria.

use adom_core::prefix;
use serde_json::Value;

use super::{magnet_key, MagnetMark, MagnetState, MagnetStateStore};

const ADAPTER: &str = "premiumize";
const API_KEY: &str = "k1";
const ALIVE_TTL: i64 = 7 * 24 * 3_600;
const BAD_TTL: i64 = 24 * 3_600;
const LIE_TTL: i64 = 30 * 24 * 3_600;

/// Hash de teste na forma que o `mag:v1` aceita: 40 hex minúsculos.
fn h(n: u8) -> String {
    format!("{n:040x}")
}

fn mark_alive(store: &MagnetStateStore, values: &[String], ttl_seconds: i64, now_ms: i64) -> usize {
    store
        .mark_alive(ADAPTER, API_KEY, values, ttl_seconds, now_ms)
        .unwrap()
}

fn state_of(store: &MagnetStateStore, hash: &str, now_ms: i64) -> Option<MagnetState> {
    store.state(ADAPTER, API_KEY, hash, now_ms).unwrap()
}

#[test]
fn mark_bad_apaga_o_alive_do_mesmo_hash_na_mesma_transacao() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xaa)], ALIVE_TTL, 1_000), 1);
    assert_eq!(state_of(&store, &h(0xaa), 1_001), Some(MagnetState::Alive));

    assert!(
        store
            .mark_bad(ADAPTER, API_KEY, &h(0xaa), BAD_TTL, 1_002)
            .unwrap(),
        "primeira marca bad nasce"
    );
    assert_eq!(state_of(&store, &h(0xaa), 1_003), Some(MagnetState::Bad));

    // O `alive` foi apagado na MESMA transação: esquecer o `bad` não pode
    // ressuscitar o hash como vivo.
    assert!(store.forget_bad(ADAPTER, API_KEY, &h(0xaa)).unwrap());
    assert_eq!(state_of(&store, &h(0xaa), 1_004), None);
}

#[test]
fn lie_e_bad_sao_exclusivos_na_leitura() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xbb)], ALIVE_TTL, 1_000), 1);
    assert!(store
        .mark_lie(ADAPTER, API_KEY, &h(0xbb), LIE_TTL, 1_001)
        .unwrap());
    assert_eq!(
        state_of(&store, &h(0xbb), 1_002),
        Some(MagnetState::Lie),
        "lie vence alive (o TS não apaga o alive)"
    );

    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xbb), BAD_TTL, 1_003)
        .unwrap());
    assert_eq!(
        state_of(&store, &h(0xbb), 1_004),
        Some(MagnetState::Bad),
        "bad vence lie"
    );
}

#[test]
fn mark_alive_recusa_hash_com_bad_vivo() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xcc), BAD_TTL, 1_000)
        .unwrap());

    assert_eq!(
        mark_alive(&store, &[h(0xcc)], ALIVE_TTL, 1_001),
        0,
        "hash com bad vivo não nasce alive"
    );
    assert_eq!(state_of(&store, &h(0xcc), 1_002), Some(MagnetState::Bad));
}

#[test]
fn mark_alive_no_lote_pula_o_hash_com_bad() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xbb), BAD_TTL, 1_000)
        .unwrap());

    assert_eq!(
        mark_alive(&store, &[h(0xaa), h(0xbb), h(0xcc)], ALIVE_TTL, 1_001),
        2,
        "só os dois sem bad nascem"
    );
    assert_eq!(state_of(&store, &h(0xaa), 1_002), Some(MagnetState::Alive));
    assert_eq!(
        state_of(&store, &h(0xbb), 1_002),
        Some(MagnetState::Bad),
        "o hash barrado continua bad"
    );
    assert_eq!(state_of(&store, &h(0xcc), 1_002), Some(MagnetState::Alive));
}

#[test]
fn bad_vencido_libera_mark_alive() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xaa), 60, 1_000)
        .unwrap());
    assert_eq!(
        mark_alive(&store, &[h(0xaa)], ALIVE_TTL, 60_999),
        0,
        "dentro da janela o bad ainda barra"
    );

    // expires_at = 1_000 + 60_000; vencido, o bad não barra mais e a evidência
    // nova volta a nascer (a linha vencida fica para o sweep contabilizar).
    assert_eq!(
        mark_alive(&store, &[h(0xaa)], ALIVE_TTL, 61_000),
        1,
        "bad vencido não barra mais"
    );
    assert_eq!(state_of(&store, &h(0xaa), 61_001), Some(MagnetState::Alive));
}

#[test]
fn forget_bad_devolve_ao_alive() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xdd), BAD_TTL, 1_000)
        .unwrap());
    assert_eq!(
        mark_alive(&store, &[h(0xdd)], ALIVE_TTL, 1_001),
        0,
        "o alive é recusado enquanto o bad está vivo"
    );

    assert!(store.forget_bad(ADAPTER, API_KEY, &h(0xdd)).unwrap());
    assert_eq!(
        state_of(&store, &h(0xdd), 1_002),
        None,
        "o alive recusado não existe: sem evidência viva"
    );
    assert!(
        !store.forget_bad(ADAPTER, API_KEY, &h(0xdd)).unwrap(),
        "idempotente"
    );
}

#[test]
fn conta_diferente_nao_ve_o_mark() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xee)], ALIVE_TTL, 1_000), 1);
    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xff), BAD_TTL, 1_000)
        .unwrap());

    assert_eq!(store.state(ADAPTER, "k2", &h(0xee), 1_001).unwrap(), None);
    assert_eq!(
        store.state("torbox", API_KEY, &h(0xee), 1_001).unwrap(),
        None
    );
    assert_eq!(store.state(ADAPTER, "k2", &h(0xff), 1_001).unwrap(), None);
    assert_eq!(
        state_of(&store, &h(0xee), 1_001),
        Some(MagnetState::Alive),
        "a conta dona continua vendo"
    );
}

#[test]
fn ttl_zero_nao_grava_e_ttl_curto_expira() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(
        mark_alive(&store, &[h(0xaa)], 0, 1_000),
        0,
        "janela desligada: nada nasce"
    );
    assert_eq!(mark_alive(&store, &[h(0xbb)], 60, 1_000), 1);
    assert!(
        !store
            .mark_lie(ADAPTER, API_KEY, &h(0xbb), 0, 1_001)
            .unwrap(),
        "lie com ttl 0 também não grava"
    );

    assert_eq!(
        state_of(&store, &h(0xaa), 9_999_999),
        None,
        "ttl 0 não grava: não há o que expirar"
    );
    assert_eq!(
        state_of(&store, &h(0xbb), 1_002),
        Some(MagnetState::Alive),
        "a escrita desligada não mexeu no alive"
    );
    // expires_at = 1_000 + 60_000.
    assert_eq!(state_of(&store, &h(0xbb), 60_999), Some(MagnetState::Alive));
    assert_eq!(
        state_of(&store, &h(0xbb), 61_000),
        None,
        "venceu na leitura"
    );
    assert_eq!(
        state_of(&store, &h(0xbb), 1_500),
        Some(MagnetState::Alive),
        "sem poda a linha vencida continua na tabela: só o sweep torna a \
         expiração durável (quem apaga fora dele some sem baixa no agregado)"
    );
    assert_eq!(
        store.sweep(0, 61_000).unwrap().expired,
        1,
        "a vencida estava fisicamente lá para a poda contabilizar"
    );
    assert_eq!(
        state_of(&store, &h(0xbb), 1_500),
        None,
        "depois do sweep não volta nem com o relógio recuado"
    );
}

#[test]
fn mark_bad_com_ttl_zero_preserva_o_alive() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xaa)], ALIVE_TTL, 1_000), 1);

    assert!(
        !store
            .mark_bad(ADAPTER, API_KEY, &h(0xaa), 0, 1_001)
            .unwrap(),
        "janela desligada: nada nasce"
    );
    assert_eq!(
        state_of(&store, &h(0xaa), 1_002),
        Some(MagnetState::Alive),
        "com ttl 0 o bad nem tenta apagar o alive"
    );
}

#[test]
fn snapshot_devolve_uma_entrada_por_hash_pedido() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xaa)], ALIVE_TTL, 1_000), 1);
    assert!(store
        .mark_bad(ADAPTER, API_KEY, &h(0xbb), BAD_TTL, 1_000)
        .unwrap());

    let pedidos = vec![h(0xbb), h(0xcc), h(0xaa)];
    let foto = store
        .state_snapshot(ADAPTER, API_KEY, &pedidos, 1_001)
        .unwrap();
    assert_eq!(
        foto,
        vec![
            MagnetMark {
                hash: h(0xbb),
                state: Some(MagnetState::Bad),
            },
            MagnetMark {
                hash: h(0xcc),
                state: None,
            },
            MagnetMark {
                hash: h(0xaa),
                state: Some(MagnetState::Alive),
            },
        ],
        "ordem preservada e None no desconhecido"
    );
}

#[test]
fn state_snapshot_devolve_hash_normalizado_e_recusa_forma_invalida() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xaa)], ALIVE_TTL, 1_000), 1);

    let maiusculo = h(0xaa).to_uppercase();
    let foto = store
        .state_snapshot(ADAPTER, API_KEY, &[maiusculo.clone(), h(0xbb)], 1_001)
        .unwrap();
    assert_eq!(
        foto,
        vec![
            MagnetMark {
                hash: maiusculo.to_ascii_lowercase(),
                state: None,
            },
            MagnetMark {
                hash: h(0xbb),
                state: None,
            },
        ],
        "a foto volta na forma da chave; maiúsculas não têm marca (nunca nasceram)"
    );
}

#[test]
fn contagem_de_nascidas_nao_conta_renovacao() {
    let store = MagnetStateStore::open_memory().unwrap();
    assert_eq!(mark_alive(&store, &[h(0xaa), h(0xbb)], ALIVE_TTL, 1_000), 2);
    assert_eq!(
        mark_alive(&store, &[h(0xaa), h(0xbb)], ALIVE_TTL, 2_000),
        0,
        "renovação de chave existente não nasce"
    );
    assert_eq!(
        mark_alive(&store, &[h(0xaa), h(0xcc)], ALIVE_TTL, 3_000),
        1,
        "só a chave nova conta"
    );
}

#[test]
fn magnet_key_bate_com_o_contrato() {
    let escopo = adom_core::account_scope(&Value::String(API_KEY.to_string()));
    let maiusculo = h(0xab).to_uppercase();
    assert_eq!(
        magnet_key("alive", ADAPTER, API_KEY, &maiusculo),
        format!("{}alive:{ADAPTER}:{escopo}:{}", prefix("mag"), h(0xab))
    );
    assert!(magnet_key("bad", ADAPTER, API_KEY, &h(0x01)).starts_with(prefix("mag")));
    assert!(
        magnet_key("lie", ADAPTER, API_KEY, &h(0xab)).ends_with(&format!(":{}", h(0xab))),
        "hash em minúsculas"
    );
}

#[test]
fn guarda_de_escopo_vazio_nao_grava_nem_le() {
    let store = MagnetStateStore::open_memory().unwrap();
    let lote = vec![h(0xaa)];

    assert_eq!(
        store
            .mark_alive("", API_KEY, &lote, ALIVE_TTL, 1_000)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .mark_alive(ADAPTER, "", &lote, ALIVE_TTL, 1_000)
            .unwrap(),
        0
    );
    assert!(!store
        .mark_bad("", API_KEY, &h(0xaa), BAD_TTL, 1_000)
        .unwrap());
    assert!(!store
        .mark_lie(ADAPTER, "", &h(0xaa), LIE_TTL, 1_000)
        .unwrap());
    assert!(!store.forget_bad("", API_KEY, &h(0xaa)).unwrap());

    assert_eq!(store.state("", API_KEY, &h(0xaa), 1_000).unwrap(), None);
    assert_eq!(store.state(ADAPTER, API_KEY, "", 1_000).unwrap(), None);
    assert!(store
        .state_snapshot("", API_KEY, &lote, 1_000)
        .unwrap()
        .is_empty());
    assert_eq!(state_of(&store, &h(0xaa), 1_000), None);
}

#[test]
fn valor_true_ou_1_cru_conta_como_marca() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);",
        )
        .unwrap();
        for (campo, hash, valor) in [
            ("alive", h(0xaa), "true"),
            ("bad", h(0xbb), "1"),
            ("lie", h(0xcc), "0"),
        ] {
            conn.execute(
                "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, 0)",
                rusqlite::params![magnet_key(campo, ADAPTER, API_KEY, &hash), valor],
            )
            .unwrap();
        }
    }

    let store = MagnetStateStore::open(&path).unwrap();
    assert_eq!(state_of(&store, &h(0xaa), 1_000), Some(MagnetState::Alive));
    assert_eq!(state_of(&store, &h(0xbb), 1_000), Some(MagnetState::Bad));
    assert_eq!(state_of(&store, &h(0xcc), 1_000), None, "\"0\" não é marca");
}
