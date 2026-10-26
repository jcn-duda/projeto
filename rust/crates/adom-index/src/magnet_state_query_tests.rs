//! Provas da enumeração/manutenção do `mag:v1`: filtros e teto da página, TTL
//! restante, agregado por adapter × lado, lie global, janela de `remaining`,
//! `forget_bad_of` sem apiKey, `clear` e a poda (`sweep`: vencidas + teto por
//! ordem de escrita). Fecha com a guarda de hash, que é o que torna a
//! enumeração confiável: só nasce chave que ela lê de volta.

use super::{MagCount, MagnetState, MagnetStateStore};

const ADAPTER: &str = "premiumize";
const OTHER: &str = "torbox";
const API_KEY: &str = "k1";
const ALIVE_TTL: i64 = 7 * 24 * 3_600;
const BAD_TTL: i64 = 24 * 3_600;
const LIE_TTL: i64 = 30 * 24 * 3_600;

/// Hash de teste na forma que o `mag:v1` aceita: 40 hex minúsculos.
fn h(n: u8) -> String {
    format!("{n:040x}")
}

fn store() -> MagnetStateStore {
    MagnetStateStore::open_memory().expect("store em memória")
}

/// Contagem esperada de um adapter × lado (`ttl_remaining_sum` só no `summary`).
fn mag_count(adapter: &str, side: &str, count: u32, ttl: i64) -> MagCount {
    MagCount {
        adapter: adapter.into(),
        side: side.into(),
        count,
        ttl_remaining_sum: ttl,
    }
}

/// Quatro marcas vivas em `now = 2_000`: duas `alive` do premiumize (600 s),
/// uma `bad` do premiumize (24 h) e uma `alive` do torbox (600 s). A quinta
/// (`h(0x05)`, 60 s, ainda viva em 2_000) vence em 61 s e serve de vencida.
fn fixture(store: &MagnetStateStore) {
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x01), h(0x02)], 600, 1_000)
        .unwrap();
    store
        .mark_bad(ADAPTER, API_KEY, &h(0x03), BAD_TTL, 1_000)
        .unwrap();
    store
        .mark_alive(OTHER, API_KEY, &[h(0x04)], 600, 1_000)
        .unwrap();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x05)], 60, 1_000)
        .unwrap();
}

#[test]
fn entries_filtra_por_adapter_side_e_hash_com_teto_e_ttl() {
    let store = store();
    fixture(&store);

    // Só o adapter: 4 vivas, teto de 1 linha, TTL restante em segundos.
    let page = store.entries(Some(ADAPTER), None, None, 1, 2_000).unwrap();
    assert_eq!(page.matched, 4);
    assert_eq!(page.items.len(), 1);
    assert!(page.truncated);
    assert_eq!(page.items[0].hash, h(0x01), "ordem de escrita");
    assert_eq!(page.items[0].ttl_remaining_seconds, Some(599));

    // Lado + hash (o filtro compara em minúsculas) e teto desligado.
    let page = store
        .entries(None, Some("alive"), Some(&h(0x04).to_uppercase()), 0, 2_000)
        .unwrap();
    assert_eq!(page.matched, 1);
    assert_eq!(page.items.len(), 1);
    assert!(!page.truncated);
    assert_eq!(page.items[0].adapter, OTHER);
    assert_eq!(page.items[0].ttl_remaining_seconds, Some(599));

    let page = store
        .entries(Some(ADAPTER), Some("bad"), None, 0, 2_000)
        .unwrap();
    assert_eq!(page.items[0].hash, h(0x03));
    // 24 h menos 1 s.
    assert_eq!(page.items[0].ttl_remaining_seconds, Some(86_399));

    // Vencida NÃO entra e NÃO é apagada: com o relógio recuado ela reaparece.
    assert_eq!(
        store.entries(None, None, None, 0, 61_000).unwrap().matched,
        4
    );
    assert_eq!(
        store.entries(None, None, None, 0, 1_500).unwrap().matched,
        5,
        "a vencida continua na tabela; quem apaga é o sweep"
    );
    let page = store.entries(None, None, Some(&h(0xff)), 0, 2_000).unwrap();
    assert_eq!(page.matched, 0);
}

#[test]
fn entries_com_limit_zero_devolve_todos() {
    let store = store();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x01), h(0x02), h(0x03)], 600, 1_000)
        .unwrap();

    let page = store.entries(None, None, None, 0, 2_000).unwrap();
    assert_eq!(page.items.len(), 3);
    assert_eq!(page.matched, 3);
    assert!(!page.truncated, "sem limite a página é completa");
}

#[test]
fn summary_agrega_por_adapter_e_side_com_soma_de_ttl() {
    let store = store();
    fixture(&store);
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x06)], 1, 1_000)
        .unwrap();

    assert_eq!(
        store.summary(2_000).unwrap(),
        vec![
            mag_count(ADAPTER, "alive", 3, 1_257),
            mag_count(ADAPTER, "bad", 1, 86_399),
            mag_count(OTHER, "alive", 1, 599),
        ],
        "ordenado por adapter/side; vencida fora da conta e do TTL"
    );
}

#[test]
fn live_count_ignora_vencida() {
    let store = store();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x01), h(0x02)], 600, 1_000)
        .unwrap();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x03)], 1, 1_000)
        .unwrap();

    assert_eq!(store.live_count(2_000).unwrap(), 2);
    assert_eq!(
        store.live_count(1_500).unwrap(),
        3,
        "contar não é podar: a vencida continua lá"
    );
}

#[test]
fn live_lies_so_hash_com_lie_vivo_em_qualquer_conta() {
    let store = store();
    store
        .mark_lie(ADAPTER, API_KEY, &h(0x01), LIE_TTL, 1_000)
        .unwrap();
    store
        .mark_lie(ADAPTER, "k2", &h(0x02), LIE_TTL, 1_000)
        .unwrap();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x03)], ALIVE_TTL, 1_000)
        .unwrap();
    store
        .mark_lie(ADAPTER, API_KEY, &h(0x04), 1, 1_000)
        .unwrap();

    let leva = vec![
        h(0x02),
        h(0x03),
        h(0x01),
        h(0x04),
        h(0x01).to_uppercase(),
        h(0x05),
    ];
    assert_eq!(
        store.live_lies(&leva, 2_000).unwrap(),
        vec![h(0x02), h(0x01)],
        "ordem da leva, sem repetição; lie vencido, alive e conta sem lie ficam de fora"
    );
}

#[test]
fn remaining_devolve_janela_e_none_apos_vencer_sem_apagar() {
    let store = store();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0xaa)], 600, 1_000)
        .unwrap();

    assert_eq!(
        store
            .remaining(ADAPTER, API_KEY, "alive", &h(0xaa), 2_000)
            .unwrap(),
        Some(599)
    );
    assert_eq!(
        store
            .remaining(ADAPTER, API_KEY, "bad", &h(0xaa), 2_000)
            .unwrap(),
        None,
        "não há bad deste hash"
    );
    assert_eq!(
        store
            .remaining(ADAPTER, API_KEY, "lado", &h(0xaa), 2_000)
            .unwrap(),
        None,
        "lado desconhecido não é campo"
    );
    assert_eq!(
        store
            .remaining(ADAPTER, API_KEY, "alive", &h(0xaa).to_uppercase(), 2_000)
            .unwrap(),
        None,
        "hash em maiúsculas não tem marca"
    );

    // Vencida: `None`, mas a linha CONTINUA na tabela — quem apaga e contabiliza é o `sweep`.
    let vencida = store.remaining(ADAPTER, API_KEY, "alive", &h(0xaa), 601_000);
    assert_eq!(vencida.unwrap(), None, "vencida não é lida como viva");
    assert_eq!(store.live_count(601_000).unwrap(), 0, "vencida não conta");
    let poda = store.sweep(0, 601_000);
    assert_eq!(poda.unwrap().expired, 1, "a vencida estava fisicamente lá");
    assert_eq!(store.live_count(1_500).unwrap(), 0, "poda: não ressuscita");
}

#[test]
fn forget_bad_of_apaga_todas_as_contas_e_respeita_alive_lie() {
    let store = store();
    store
        .mark_bad(ADAPTER, API_KEY, &h(0x01), BAD_TTL, 1_000)
        .unwrap();
    store
        .mark_bad(ADAPTER, "k2", &h(0x01), BAD_TTL, 1_000)
        .unwrap();
    store
        .mark_lie(ADAPTER, "k2", &h(0x01), LIE_TTL, 1_000)
        .unwrap();
    store
        .mark_bad(ADAPTER, API_KEY, &h(0x02), BAD_TTL, 1_000)
        .unwrap();

    // Duas linhas saíram (uma por conta) — é esse número que o agregado do Node
    // baixa; o `lie` da conta 2 fica.
    assert_eq!(store.forget_bad_of(ADAPTER, &h(0x01)).unwrap(), 2);
    assert_eq!(
        store.state(ADAPTER, API_KEY, &h(0x01), 1_001).unwrap(),
        None,
        "bad da conta 1 saiu"
    );
    assert_eq!(
        store.state(ADAPTER, "k2", &h(0x01), 1_001).unwrap(),
        Some(MagnetState::Lie),
        "o bad da conta 2 saiu e o lie dela ficou"
    );
    assert_eq!(
        store.state(ADAPTER, API_KEY, &h(0x02), 1_001).unwrap(),
        Some(MagnetState::Bad),
        "outro hash não é tocado"
    );
    assert_eq!(
        store.forget_bad_of(ADAPTER, &h(0x01)).unwrap(),
        0,
        "idempotente"
    );
    // Os dois lados entram LITERAIS no padrão: forma inválida não monta `LIKE`.
    assert_eq!(store.forget_bad_of("", &h(0x01)).unwrap(), 0);
    assert_eq!(store.forget_bad_of("prem%", &h(0x01)).unwrap(), 0);
    assert_eq!(store.forget_bad_of(ADAPTER, "aa").unwrap(), 0);
}

#[test]
fn clear_esvazia_o_namespace() {
    let store = store();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x01)], ALIVE_TTL, 1_000)
        .unwrap();
    store
        .mark_bad(ADAPTER, API_KEY, &h(0x02), BAD_TTL, 1_000)
        .unwrap();
    {
        // Linha do `davail` na MESMA tabela: o `clear` é do namespace `mag`.
        let conn = store.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, 0)",
            rusqlite::params![crate::davail_key(ADAPTER, API_KEY, "pos-hit"), "1"],
        )
        .unwrap();
    }

    assert_eq!(store.live_count(1_000).unwrap(), 2);
    assert_eq!(store.clear().unwrap(), 2);
    assert_eq!(store.live_count(1_000).unwrap(), 0);
    let left: i64 = store
        .lock()
        .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
        .unwrap();
    assert_eq!(left, 1, "o davail sobrevive ao clear do mag");
}

#[test]
fn sweep_apaga_vencida_e_conta_por_lado() {
    let store = store();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x01)], 600, 1_000)
        .unwrap();
    store
        .mark_bad(ADAPTER, API_KEY, &h(0x02), BAD_TTL, 1_000)
        .unwrap();
    store
        .mark_alive(ADAPTER, API_KEY, &[h(0x03)], 1, 1_000)
        .unwrap();
    store.mark_lie(OTHER, API_KEY, &h(0x04), 1, 1_000).unwrap();

    let sweep = store.sweep(0, 2_000).unwrap();
    assert_eq!((sweep.expired, sweep.evicted), (2, 0), "teto 0 = sem teto");
    assert_eq!(
        sweep.counts,
        vec![
            mag_count(ADAPTER, "alive", 1, 0),
            mag_count(OTHER, "lie", 1, 0),
        ],
        "contagem das removidas por adapter × lado"
    );
    assert_eq!(store.live_count(2_000).unwrap(), 2);
    assert_eq!(
        store.live_count(1_500).unwrap(),
        2,
        "as vencidas foram apagadas de verdade"
    );
}

#[test]
fn sweep_aplica_teto_por_ordem_de_escrita() {
    let store = store();
    for n in 1..=4u8 {
        store
            .mark_alive(ADAPTER, API_KEY, &[h(n)], 600, 1_000)
            .unwrap();
    }

    let sweep = store.sweep(2, 2_000).unwrap();
    assert_eq!((sweep.expired, sweep.evicted), (0, 2));
    assert_eq!(sweep.counts, vec![mag_count(ADAPTER, "alive", 2, 0)]);
    let page = store.entries(None, None, None, 0, 2_000).unwrap();
    let restantes: Vec<String> = page.items.into_iter().map(|item| item.hash).collect();
    assert_eq!(restantes, vec![h(0x03), h(0x04)], "as mais antigas saíram");
}

#[test]
fn hash_fora_de_40_hex_nao_grava_nem_le() {
    let store = store();
    let invalidos = vec![
        String::new(),
        "aa".to_string(),
        "pos-hit".to_string(),
        h(0xaa).to_uppercase(),
        format!("{}0", h(0xaa)),
        format!("g{}", &h(0xaa)[1..]),
    ];

    for hash in &invalidos {
        let lote = std::slice::from_ref(hash);
        assert_eq!(
            store
                .mark_alive(ADAPTER, API_KEY, lote, ALIVE_TTL, 1_000)
                .unwrap(),
            0,
            "{hash}"
        );
        assert!(!store
            .mark_bad(ADAPTER, API_KEY, hash, BAD_TTL, 1_000)
            .unwrap());
        assert!(!store
            .mark_lie(ADAPTER, API_KEY, hash, LIE_TTL, 1_000)
            .unwrap());
        assert!(!store.forget_bad(ADAPTER, API_KEY, hash).unwrap());
        assert_eq!(store.state(ADAPTER, API_KEY, hash, 1_000).unwrap(), None);
        assert_eq!(
            store
                .remaining(ADAPTER, API_KEY, "alive", hash, 1_000)
                .unwrap(),
            None
        );
    }
    assert_eq!(store.live_count(1_000).unwrap(), 0, "nada nasceu");

    // O mesmo chamador com a forma certa continua funcionando.
    assert_eq!(
        store
            .mark_alive(ADAPTER, API_KEY, &[h(0xaa)], ALIVE_TTL, 1_000)
            .unwrap(),
        1
    );
    assert_eq!(
        store.state(ADAPTER, API_KEY, &h(0xaa), 1_001).unwrap(),
        Some(MagnetState::Alive)
    );
}
