//! Testes da régua pura da semente (filtros, cap, dedupe, data, painel). Os
//! helpers aqui são compartilhados com `seed_net_tests.rs` (ciclo contra servidor).

use serde_json::{json, Value};

use super::regra::*;
use super::*;

pub(super) const NOW: i64 = 1_700_000_000_000; // 2023-11-14 UTC
const HOJE: &str = "2023-11-14";
pub(super) const CHAVE: &str = "chave-secreta-de-teste-123";
pub(super) const HOST: &str = "api.teste.local";

pub(super) fn filme(id: &str, votes: i64, data: &str) -> Value {
    json!({ "id": id, "type": "movie", "numVotes": votes, "releaseDate": data })
}

pub(super) fn serie(id: &str, votes: i64, data: &str) -> Value {
    json!({ "id": id, "type": "tvSeries", "numVotes": votes, "releaseDate": data })
}

pub(super) fn ajustes(base: &str) -> SeedSettings {
    SeedSettings {
        enabled: true,
        release_index: true,
        api_key: CHAVE.to_string(),
        host: HOST.to_string(),
        base: base.to_string(),
        max_per_cycle: 20,
        min_votes: 1000.0,
        interval_h: 24,
        timeout: Duration::from_secs(5),
        top_per_type: 100,
    }
}

// ── régua pura ──────────────────────────────────────────────────────────────

#[test]
fn filtra_tipo_id_votos_e_data() {
    assert!(aproveitavel(
        &filme("tt0000001", 1000, "2023-01-01"),
        HOJE,
        1000.0
    ));
    // tvMovie conta como filme e tvMiniSeries como série; o resto é ruído.
    assert!(aproveitavel(
        &json!({"id":"tt0000002","type":"tvMovie","numVotes":5000,"releaseDate":"2020-01-01"}),
        HOJE,
        1000.0
    ));
    assert!(aproveitavel(
        &json!({"id":"tt0000003","type":"tvMiniSeries","numVotes":5000,"releaseDate":"2020-01-01"}),
        HOJE,
        1000.0
    ));
    assert!(!aproveitavel(
        &json!({"id":"tt0000004","type":"short","numVotes":5000,"releaseDate":"2020-01-01"}),
        HOJE,
        1000.0
    ));
    // id fora do formato tt\d+.
    assert!(!aproveitavel(
        &filme("nm0000001", 5000, "2020-01-01"),
        HOJE,
        1000.0
    ));
    assert!(!aproveitavel(
        &filme("tt", 5000, "2020-01-01"),
        HOJE,
        1000.0
    ));
    assert!(!aproveitavel(
        &filme("tt12a", 5000, "2020-01-01"),
        HOJE,
        1000.0
    ));
    // Piso de votos.
    assert!(!aproveitavel(
        &filme("tt0000005", 999, "2020-01-01"),
        HOJE,
        1000.0
    ));
    // Estreia futura não tem release para colher.
    assert!(!aproveitavel(
        &filme("tt0000006", 5000, "2030-01-01"),
        HOJE,
        1000.0
    ));
    assert!(aproveitavel(
        &filme("tt0000007", 5000, "2023-11-14"),
        HOJE,
        1000.0
    ));
}

#[test]
fn sem_data_vale_o_ano_de_inicio() {
    let sem = |ano: Value| json!({"id":"tt0000008","type":"movie","numVotes":5000,"startYear":ano});
    assert!(aproveitavel(&sem(json!(2023)), HOJE, 1000.0));
    assert!(aproveitavel(&sem(json!(2010)), HOJE, 1000.0));
    assert!(!aproveitavel(&sem(json!(2024)), HOJE, 1000.0));
    assert!(!aproveitavel(&sem(json!(0)), HOJE, 1000.0));
    assert!(!aproveitavel(
        &json!({"id":"tt0000008","type":"movie","numVotes":5000}),
        HOJE,
        1000.0
    ));
}

#[test]
fn ids_aprovados_respeitam_ordem_dedupe_teto_e_tipo() {
    let itens = vec![
        filme("tt0000010", 5000, "2020-01-01"),
        serie("tt0000011", 5000, "2020-01-01"), // tipo errado para a lista de filmes
        filme("tt0000010", 5000, "2020-01-01"), // duplicata
        filme("ruim", 5000, "2020-01-01"),
        filme("tt0000012", 5000, "2020-01-01"),
        filme("tt0000013", 5000, "2020-01-01"),
    ];
    let out = ids_aprovados(&itens, HOJE, 1000.0, 2, HarvestMediaType::Movie);
    assert_eq!(out, vec!["tt0000010".to_string(), "tt0000012".to_string()]);
}

#[test]
fn sanitize_ids_so_aceita_tt_sem_duplicata_e_com_teto() {
    let lista = json!(["tt1", "lixo", "tt1", 42, "tt22", "tt333"]);
    assert_eq!(
        sanitize_ids(Some(&lista), 2),
        vec!["tt1".to_string(), "tt22".to_string()]
    );
    assert!(sanitize_ids(Some(&json!("tt1")), 5).is_empty());
    assert!(sanitize_ids(None, 5).is_empty());
}

#[test]
fn data_utc_bate_com_o_calendario() {
    assert_eq!(data_utc(0), "1970-01-01");
    assert_eq!(data_utc(NOW), "2023-11-14");
    // 2024-02-29 00:00 UTC (ano bissexto).
    assert_eq!(data_utc(1_709_164_800_000), "2024-02-29");
    // Último instante de 2023 em UTC.
    assert_eq!(data_utc(1_704_067_199_999), "2023-12-31");
}

#[test]
fn escolha_corta_no_teto_e_marca_as_conhecidas() {
    let s = SeedSettings {
        max_per_cycle: 2,
        ..ajustes("http://x")
    };
    let itens = vec![
        filme("tt0000020", 5000, "2020-01-01"),
        filme("tt0000021", 5000, "2020-01-01"),
        filme("tt0000022", 5000, "2020-01-01"),
    ];
    let mut escolha = Escolha::default();
    escolha.absorver(&itens, HarvestMediaType::Movie, &s, HOJE, &|_| false);
    assert_eq!(escolha.picks.len(), 2);
    assert_eq!(escolha.vistos, 2, "o teto corta antes de contar o terceiro");

    let mut escolha = Escolha::default();
    escolha.absorver(&itens, HarvestMediaType::Movie, &s, HOJE, &|id| {
        id == "tt0000020"
    });
    assert_eq!(escolha.conhecidas, 1);
    assert_eq!(escolha.picks[0].imdb_id, "tt0000021");
    assert_eq!(escolha.picks[0].media, HarvestMediaType::Movie);
}

#[test]
fn painel_sobrepoe_o_env_com_clamp() {
    let live = SeedLive::from_value(&json!({
        "seedEnabled": false,
        "seedMaxPerCycle": 9999,
        "seedMinVotes": -4,
        "seedIntervalH": 0,
    }));
    let s = ajustes("http://x").com_painel(&live);
    assert!(!s.enabled);
    assert_eq!(s.max_per_cycle, 100);
    assert_eq!(s.min_votes, 0.0);
    assert_eq!(s.interval_h, 1);

    let vazio = SeedSettings {
        min_votes: 7.0,
        ..ajustes("http://x")
    }
    .com_painel(&SeedLive::from_value(&json!({"seedMaxPerCycle": "muitos"})));
    assert_eq!(vazio.min_votes, 7.0, "sem override vale o env");
    assert_eq!(vazio.max_per_cycle, 20);
}
