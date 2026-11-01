//! Invariante da remoção: todo caminho que APAGA linha do `mag:v1` sem delta
//! compensante (`forget_bad`, `forget_bad_of`, `clear`, `sweep`) deixa o
//! agregado `mag_meta:v1:counts` STALE — a linha some e a próxima leitura
//! reconta o físico. Os casos provam os dois lados: remoção com vítima
//! invalida; remoção vazia (e o `mark_bad`, cuja remoção do `alive` TEM o delta
//! do chamador como compensação) não paga reconto à toa.

use adom_core::mag_meta_counts_key;
use serde_json::Value;

use crate::magnet_state::{read_row, MagnetStateStore};

use super::{MagMetaSums, MagMetaTotals};

/// 7 dias: o TTL nominal das marcas e do agregado nestes casos.
const TTL: i64 = 7 * 24 * 3_600;
const NOW: i64 = 1_760_000_000_000;

fn totals(alive: u32, bad: u32, lie: u32, ttl: (i64, i64, i64)) -> MagMetaTotals {
    MagMetaTotals {
        alive,
        bad,
        lie,
        ttl_remaining_sums: MagMetaSums {
            alive: ttl.0,
            bad: ttl.1,
            lie: ttl.2,
        },
    }
}

/// Delta do bump: contagem e soma de TTL por lado (mesma forma dos casos do
/// `magnet_meta_tests`).
fn delta(alive: i64, bad: i64, lie: i64, ttl: (i64, i64, i64)) -> (MagMetaSums, MagMetaSums) {
    (
        MagMetaSums { alive, bad, lie },
        MagMetaSums {
            alive: ttl.0,
            bad: ttl.1,
            lie: ttl.2,
        },
    )
}

/// Linha crua do agregado como está no `cache.db`: `None` = invalidada.
fn counts_row(store: &MagnetStateStore) -> Option<(Value, Option<i64>)> {
    let conn = store.lock();
    read_row(&conn, &mag_meta_counts_key())
        .unwrap()
        .map(|(raw, expires_at)| (serde_json::from_str(&raw).unwrap(), expires_at))
}

#[test]
fn forget_bad_invalida_o_agregado_e_o_proximo_bump_reconta() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hash = "ab".repeat(20);
    // O play condena e o chamador aplica o delta: agregado bad=1, coerente.
    store
        .mark_bad("premiumize", "chave", &hash, TTL, NOW)
        .unwrap();
    let (c, s) = delta(0, 1, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();
    assert_eq!(
        store
            .counts(NOW)
            .unwrap()
            .unwrap()
            .adapters
            .get("premiumize")
            .unwrap()
            .bad,
        1
    );

    // O reparo apaga o bad sem delta que o compense: o agregado tem que virar
    // stale (a linha some do disco), não ficar com bad fantasma.
    assert!(store.forget_bad("premiumize", "chave", &hash).unwrap());
    assert!(store.counts(NOW).unwrap().is_none(), "agregado invalidado");
    assert!(counts_row(&store).is_none(), "linha apagada do disco");

    // O próximo bump reconta o físico: o bad removido não sobra no reconto.
    let hash2 = "cd".repeat(20);
    store
        .mark_alive(
            "premiumize",
            "chave",
            std::slice::from_ref(&hash2),
            TTL,
            NOW + 1_000,
        )
        .unwrap();
    let (c, s) = delta(1, 0, 0, (0, 0, 0));
    store
        .bump_counts("premiumize", c, s, TTL, NOW + 1_000)
        .unwrap();
    let read = store.counts(NOW + 2_000).unwrap().expect("recontado");
    assert_eq!(
        read.adapters.get("premiumize"),
        Some(&totals(1, 0, 0, (TTL, 0, 0))),
        "só o alive novo conta; o bad apagado sumiu do agregado"
    );
}

#[test]
fn forget_bad_sem_vitima_preserva_o_agregado() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hash = "ab".repeat(20);
    store
        .mark_bad("premiumize", "chave", &hash, TTL, NOW)
        .unwrap();
    let (c, s) = delta(0, 1, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();

    // Hash sem marca: nada sai, nada é invalidado — remoção vazia não paga
    // reconto.
    assert!(!store
        .forget_bad("premiumize", "chave", &"ef".repeat(20))
        .unwrap());
    let read = store.counts(NOW).unwrap().expect("agregado preservado");
    assert_eq!(read.adapters.get("premiumize").unwrap().bad, 1);
}

#[test]
fn forget_bad_of_invalida_o_agregado_pelas_contas_apagadas() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hash = "ab".repeat(20);
    // O mesmo hash condenado em duas contas: bad=2 no agregado.
    for chave in ["conta-a", "conta-b"] {
        store
            .mark_bad("premiumize", chave, &hash, TTL, NOW)
            .unwrap();
    }
    let (c, s) = delta(0, 2, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();
    assert_eq!(
        store
            .counts(NOW)
            .unwrap()
            .unwrap()
            .adapters
            .get("premiumize")
            .unwrap()
            .bad,
        2
    );

    // O reparo por adapter (sem apiKey) leva as duas linhas: invalida.
    assert_eq!(store.forget_bad_of("premiumize", &hash).unwrap(), 2);
    assert!(store.counts(NOW).unwrap().is_none(), "agregado invalidado");

    // Depois do reconto, hash sem vítima: nada sai, o agregado fica.
    store
        .bump_counts("premiumize", c, s, TTL, NOW + 1_000)
        .unwrap();
    assert_eq!(
        store.forget_bad_of("premiumize", &"cd".repeat(20)).unwrap(),
        0
    );
    assert!(
        store.counts(NOW + 1_000).unwrap().is_some(),
        "sem remoção, preservado"
    );
}

#[test]
fn clear_invalida_o_agregado_so_quando_apaga_linha() {
    let store = MagnetStateStore::open_memory().unwrap();
    // Agregado sem acervo: o apagão não leva ninguém e não invalida.
    let (c, s) = delta(1, 0, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();
    assert_eq!(store.clear().unwrap(), 0);
    assert!(
        store.counts(NOW).unwrap().is_some(),
        "apagão sem vítima preserva o agregado"
    );

    // Com acervo: o namespace inteiro sai e o agregado vai junto.
    let hash = "ab".repeat(20);
    store
        .mark_alive(
            "premiumize",
            "chave",
            std::slice::from_ref(&hash),
            TTL,
            NOW + 1_000,
        )
        .unwrap();
    store
        .bump_counts("premiumize", c, s, TTL, NOW + 1_000)
        .unwrap();
    assert!(store.counts(NOW + 1_000).unwrap().is_some());
    assert_eq!(store.clear().unwrap(), 1);
    assert!(
        store.counts(NOW + 1_000).unwrap().is_none(),
        "apagão invalida"
    );
}

#[test]
fn sweep_de_vencidas_invalida_o_agregado_na_mesma_transacao() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hash = "ab".repeat(20);
    // Marca com janela curta: vence e a poda a leva.
    store
        .mark_alive("premiumize", "chave", std::slice::from_ref(&hash), 60, NOW)
        .unwrap();
    let (c, s) = delta(1, 0, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();
    assert!(store.counts(NOW).unwrap().is_some());

    let depois = NOW + 61_000;
    let podada = store.sweep(0, depois).unwrap();
    assert_eq!(podada.expired, 1);
    assert!(
        store.counts(depois).unwrap().is_none(),
        "poda que remove invalida o agregado"
    );
    assert!(
        counts_row(&store).is_none(),
        "linha apagada na transação da poda"
    );

    // O reconto seguinte sobe limpo: a vencida não conta mais.
    let hash2 = "cd".repeat(20);
    store
        .mark_alive(
            "premiumize",
            "chave",
            std::slice::from_ref(&hash2),
            TTL,
            depois,
        )
        .unwrap();
    let (c, s) = delta(1, 0, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, depois).unwrap();
    let read = store.counts(depois).unwrap().expect("recontado");
    assert_eq!(
        read.adapters.get("premiumize"),
        Some(&totals(1, 0, 0, (TTL, 0, 0))),
        "a vencida saiu; só a marca nova conta"
    );
}

#[test]
fn sweep_sem_remocao_preserva_o_agregado() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hash = "ab".repeat(20);
    store
        .mark_alive("premiumize", "chave", std::slice::from_ref(&hash), TTL, NOW)
        .unwrap();
    let (c, s) = delta(1, 0, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();

    // Nada vencido e teto desligado: a poda sai vazia e NÃO invalida.
    let podada = store.sweep(0, NOW).unwrap();
    assert_eq!(podada.expired, 0);
    assert_eq!(podada.evicted, 0);
    let read = store.counts(NOW).unwrap().expect("agregado preservado");
    assert_eq!(
        read.adapters.get("premiumize"),
        Some(&totals(1, 0, 0, (TTL, 0, 0))),
        "poda sem remoção não paga um reconto à toa"
    );
}

#[test]
fn sweep_com_evicao_por_teto_invalida_o_agregado() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hashes: Vec<String> = (1..=3).map(|n| format!("{:02x}", n).repeat(20)).collect();
    store
        .mark_alive("premiumize", "chave", &hashes, TTL, NOW)
        .unwrap();
    let (c, s) = delta(3, 0, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();

    // Teto 1: duas linhas VIVAS saem por evicção — o agregado vai com elas.
    let podada = store.sweep(1, NOW).unwrap();
    assert_eq!(podada.evicted, 2);
    assert!(
        store.counts(NOW).unwrap().is_none(),
        "evicção também invalida o agregado"
    );
}

#[test]
fn mark_bad_nao_invalida_o_agregado_o_delta_do_chamador_compensa() {
    let store = MagnetStateStore::open_memory().unwrap();
    let hash = "ab".repeat(20);
    store
        .mark_alive("premiumize", "chave", std::slice::from_ref(&hash), TTL, NOW)
        .unwrap();
    let (c, s) = delta(1, 0, 0, (0, 0, 0));
    store.bump_counts("premiumize", c, s, TTL, NOW).unwrap();

    // O `mark_bad` apaga o alive na mesma transação, mas ESSA remoção tem delta
    // compensante (-1 alive, +1 bad no bump do chamador): invalidar aqui seria
    // pagar um reconto a cada condenação do caminho quente.
    store
        .mark_bad("premiumize", "chave", &hash, TTL, NOW + 1_000)
        .unwrap();
    let read = store
        .counts(NOW + 1_000)
        .unwrap()
        .expect("agregado preservado");
    assert_eq!(
        read.adapters.get("premiumize"),
        Some(&totals(1, 0, 0, (TTL, 0, 0))),
        "o alive condenado só sai com o delta do chamador"
    );

    // E o delta do chamador fecha a conta sem nenhum reconto.
    let (c, s) = delta(-1, 1, 0, (-TTL, 0, 0));
    store
        .bump_counts("premiumize", c, s, TTL, NOW + 2_000)
        .unwrap();
    let read = store.counts(NOW + 2_000).unwrap().unwrap();
    assert_eq!(
        read.adapters.get("premiumize"),
        Some(&totals(0, 1, 0, (0, 0, 0)))
    );
}
