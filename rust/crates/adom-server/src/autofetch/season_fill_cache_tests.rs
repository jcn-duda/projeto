//! Veredito do `cacheCheck` no Season Pack Fill: prova viva preenche, falta de
//! prova NÃO preenche (`known: false` nunca vira "não há cache").
//!
//! Era a divergência (a) do worker nativo, onde o RD respondia `false` estático
//! enquanto o TS consultava o `cacheCheck` dinâmico (ledger `rdc:v2` + oráculo).

use super::super::{fill, CacheProof};
use super::*;

/// REAL-DEBRID com a prova viva do adaptador (ledger `rdc:v2` + oráculo): o
/// pack PREENCHE. Era a divergência (a): o estático dizia `false` e o lote de
/// RD nunca invalidava a temporada.
#[test]
fn realdebrid_com_prova_dinamica_preenche() {
    let kv = kv();
    let keys = vec![cached_key("s2-dublado")];
    register_as(&kv, "realdebrid", 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        "realdebrid",
        ACCOUNT,
        CacheProof::Proven,
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 1);
    assert_eq!(report.invalidated, 1);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(
        !cached(&store, &keys[0]),
        "a busca da temporada tinha de sair"
    );
    assert!(
        !index_alive_as(&kv, "realdebrid", 2),
        "o índice é consumido pelo pack"
    );
}

/// REAL-DEBRID SEM prova (ledger/oráculo desligados): `known: false` não é
/// "nada em cache". O pack NÃO preenche e o MOTIVO vai ao relatório do passo.
#[test]
fn realdebrid_sem_prova_nao_preenche_e_diz_por_que() {
    let kv = kv();
    let keys = vec![cached_key("s2-dublado")];
    register_as(&kv, "realdebrid", 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        "realdebrid",
        ACCOUNT,
        CacheProof::Unproven("adapter"),
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 0, "sem veredito não se preenche");
    assert_eq!(report.invalidated, 0);
    assert_eq!(
        report.skips.get("season-cache-unknown-adapter"),
        Some(&1),
        "o motivo tem de aparecer: {:?}",
        report.skips
    );
    assert!(
        !report.skips.contains_key("not-pack"),
        "faltar prova não é ser 'não-pack'"
    );
    assert!(cached(&store, &keys[0]), "nada sai do cache de streams");
    assert!(
        index_alive_as(&kv, "realdebrid", 2),
        "o índice fica para a próxima passagem"
    );
}

/// Serviço com `cacheCheck: true` ESTÁTICO e sem prova viva continua
/// preenchendo: a prova só é exigida onde o flag é dinâmico.
#[test]
fn servico_estatico_sem_prova_continua_preenchendo() {
    let kv = kv();
    let keys = vec![cached_key("s2-1080p")];
    register(&kv, 2, &keys);
    let (store, sink) = streams(&keys);

    let report = fill(
        &kv,
        &config(),
        Some(&sink),
        ADAPTER,
        ACCOUNT,
        CacheProof::Unproven("adapter"),
        &[hint(Some(2), PACK_S2)],
        NOW,
    );

    assert_eq!(report.filled, 1, "{:?}", report.skips);
    assert_eq!(report.invalidated, 1);
    assert!(!cached(&store, &keys[0]));
    assert!(!index_alive(&kv, 2));
}
