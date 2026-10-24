//! Testes do inventário NATIVO da conta (F3): sondas de áudio/origem, filtro
//! de relevância, shape do item, fast-path, memo e a integração com a janela
//! de coleta. A conta é SEMPRE nativa: não há modo nem tarefa Node.

use adom_core::RelevanceSettings;
use adom_debrid::account::InventoryItem;
use serde_json::json;

use super::{
    account_raw_items, br_origin_only, fast_path_decision, signals_of, try_native_account_source,
    FastPathDecision,
};
use crate::collection_window::BatchMeta;
use crate::orchestrator::config::OrchestratorConfig;
use crate::orchestrator::meta::SearchMeta;

#[path = "account_tests_part2.rs"]
mod part2;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn settings() -> RelevanceSettings {
    RelevanceSettings {
        now_ms: 1_700_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 48 * 3_600_000,
        title_precision_tail_cut: true,
    }
}

fn meta(names: &[&str], year: i64, season: Option<i64>, episode: Option<i64>) -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        names: names.iter().map(|name| name.to_string()).collect(),
        year: json!(year),
        query: "Matrix 1999".into(),
        season,
        episode,
        ..SearchMeta::default()
    }
}

fn items(rows: &[(&str, &str)]) -> Vec<InventoryItem> {
    rows.iter()
        .map(|(title, hash)| InventoryItem {
            title: (*title).to_string(),
            info_hash: (*hash).to_string(),
            size: 4_000_000_000.0,
            id: None,
        })
        .collect()
}

// ── Sondas e filtro ────────────────────────────────────────────────────────

#[test]
fn sondas_de_audio_e_origem() {
    let dublado = signals_of("Filme Dublado 1080p");
    assert!(dublado.pt_audio, "Dublado é PT explícito");
    assert!(!dublado.legendado);

    let legendado = signals_of("Filme Legendado 1080p");
    assert!(legendado.legendado);
    assert!(!legendado.pt_audio);

    let estrangeiro = signals_of("Filme FRENCH 1080p");
    assert!(estrangeiro.explicit_foreign);

    // Caso Zombieland: origem BR pelo nome (WWW.BLUDV.COM + acento), sem
    // prometer áudio dublado.
    let origem = signals_of("Zumbilândia 2009 [1080p] WWW.BLUDV.COM");
    assert!(origem.br_origin);
    assert!(!origem.pt_audio);
    assert!(br_origin_only(&origem));
    // Dublado + origem: NÃO é só-origem (o áudio já prova por si).
    let origem_dublada = signals_of("Zumbilândia 2009 Bluray 1080p Dublado");
    assert!(origem_dublada.pt_audio);
    assert!(!br_origin_only(&origem_dublada));
    // Estrangeiro explícito desmente a origem.
    let origem_estrangeira = signals_of("Zumbilândia 2009 FRENCH WWW.BLUDV.COM");
    assert!(origem_estrangeira.explicit_foreign);
    assert!(!br_origin_only(&origem_estrangeira));
}

#[test]
fn filtro_da_conta_casa_a_obra_e_marca_o_item() {
    let inventory = items(&[
        ("Matrix Dublado 1080p", HASH_A),
        ("Outro Filme Dublado 1080p", HASH_B),
    ]);
    let raws = account_raw_items(
        &inventory,
        &meta(&["Matrix"], 1999, None, None),
        settings(),
        "AllDebrid",
    );
    assert_eq!(raws.len(), 1, "só a obra pedida entra");
    let item = &raws[0];
    assert_eq!(item.title.as_deref(), Some("Matrix Dublado 1080p"));
    assert_eq!(item.info_hash.as_deref(), Some(HASH_A));
    assert!(item.from_account);
    assert_eq!(item.indexer.as_deref(), Some("debrid"));
    assert_eq!(item.tracker.as_deref(), Some("AllDebrid"));
    assert_eq!(item.seeders, Some(1.0), "conta não tem swarm: 1 é neutro");
    assert!(item.is_br);
}

#[test]
fn item_de_origem_br_fica_is_br_e_br_origin_only() {
    let inventory = items(&[("Zumbilândia 2009 [1080p] WWW.BLUDV.COM", HASH_A)]);
    let raws = account_raw_items(
        &inventory,
        &meta(&["Zumbilândia"], 2009, None, None),
        settings(),
        "AllDebrid",
    );
    assert_eq!(raws.len(), 1);
    assert!(raws[0].is_br, "_br da origem-forte dá vaga reservada");
    assert!(raws[0].br_origin_only, "não promete dublado");
}

#[test]
fn filtro_sem_nomes_ou_inventario_vazio_devolve_vazio() {
    assert!(account_raw_items(
        &items(&[("Matrix Dublado", HASH_A)]),
        &meta(&[], 1999, None, None),
        settings(),
        "AllDebrid"
    )
    .is_empty());
    assert!(account_raw_items(
        &[],
        &meta(&["Matrix"], 1999, None, None),
        settings(),
        "AllDebrid"
    )
    .is_empty());
}

#[test]
fn serie_corta_pelo_episodio_como_o_node() {
    let inventory = items(&[
        ("Matrix S01E02 Dublado 1080p", HASH_A),
        ("Matrix S01E03 Dublado 1080p", HASH_B),
    ]);
    let raws = account_raw_items(
        &inventory,
        &meta(&["Matrix"], 1999, Some(1), Some(2)),
        settings(),
        "AllDebrid",
    );
    assert_eq!(raws.len(), 1);
    assert_eq!(raws[0].info_hash.as_deref(), Some(HASH_A));
}

// ── Fast-path ──────────────────────────────────────────────────────────────

fn raw(title: &str, hash: &str, is_br: bool) -> crate::RawItem {
    crate::RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        seeders: Some(1.0),
        is_br,
        from_account: true,
        ..crate::RawItem::default()
    }
}

fn account_batch() -> BatchMeta {
    BatchMeta {
        priority: false,
        source: Some("account".into()),
    }
}

#[test]
fn fast_path_so_do_lote_da_conta() {
    let batch = vec![
        raw("Matrix Dublado 1080p", HASH_A, true),
        raw("Matrix Dublado 720p", HASH_B, true),
    ];
    let outro = BatchMeta {
        priority: false,
        source: Some("jackett".into()),
    };
    assert_eq!(
        fast_path_decision(&batch, &outro, 2, false, None, 0.0),
        FastPathDecision::NotAccount
    );
    assert_eq!(
        fast_path_decision(&batch, &account_batch(), 2, false, None, 0.0),
        FastPathDecision::Covered
    );
    assert_eq!(
        fast_path_decision(&batch, &account_batch(), 3, false, None, 0.0),
        FastPathDecision::TooFew
    );
}

#[test]
fn fast_path_com_prefer_dubbed_exige_cobertura() {
    let sem_dublado = vec![
        raw("Matrix 1080p", HASH_A, false),
        raw("Matrix 720p", HASH_B, false),
    ];
    assert_eq!(
        fast_path_decision(&sem_dublado, &account_batch(), 2, true, None, 0.0),
        FastPathDecision::NotCovered
    );
    let com_dublado = vec![
        raw("Matrix Dublado 1080p", HASH_A, true),
        raw("Matrix Dublado 720p", HASH_B, true),
    ];
    assert_eq!(
        fast_path_decision(&com_dublado, &account_batch(), 2, true, None, 0.0),
        FastPathDecision::Covered
    );
}

#[test]
fn fonte_nativa_e_sempre_montada() {
    let config = OrchestratorConfig::default();
    assert!(
        try_native_account_source(&config).is_some(),
        "a fonte nativa é a única; não há modo para desligar"
    );
}
