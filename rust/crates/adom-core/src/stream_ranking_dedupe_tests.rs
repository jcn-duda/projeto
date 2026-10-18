use super::*;
use serde_json::json;

fn stream(hash: &str, name: &str, seeders: f64) -> RankingStream {
    serde_json::from_value(json!({
        "infoHash": hash, "name": name, "_seeders": seeders,
    }))
    .expect("stream de teste")
}

#[test]
fn generic_dub_token_delimitado() {
    assert!(is_generic_dub_token("Coyote_Vs_Acme_2026_1080p_WEBRip_Dub"));
    assert!(is_generic_dub_token("Movie.2026.1080p.Dubbed-GRP"));
    assert!(is_generic_dub_token("dub"));
    assert!(is_generic_dub_token("[Dub]"));
    assert!(!is_generic_dub_token("Adubbed"));
    assert!(!is_generic_dub_token("Dublin.1080p"));
    // "Latino Dub" BATE no GENERIC_DUB do TS (token delimitado); quem
    // bloqueia a herança é a guarda `foreignDub`, não esta régua.
    assert!(is_generic_dub_token("Latino Dub"));
}

#[test]
fn primeiro_hash_vence_sem_conflito_e_ordem_e_de_insercao() {
    let input = DedupeInput {
        streams: vec![
            stream(&"b".repeat(40), "B", 1.0),
            stream(&"a".repeat(40), "A", 2.0),
        ],
        indexer_priority: vec![],
    };
    let out = dedupe_by_hash(&input);
    assert_eq!(out.streams.len(), 2);
    assert_eq!(out.drops.len(), 0);
    assert_eq!(out.streams[0].name.as_deref(), Some("B"));
}

#[test]
fn seeders_maior_vence_e_perdedor_vai_ao_trace() {
    let hash = "c".repeat(40);
    let input = DedupeInput {
        streams: vec![
            stream(&hash, "Fraco\n👤 1", 1.0),
            stream(&hash, "Forte\n👤 9", 9.0),
        ],
        indexer_priority: vec![],
    };
    let out = dedupe_by_hash(&input);
    assert_eq!(out.streams.len(), 1);
    assert_eq!(out.streams[0].seeders, Some(9.0));
    assert_eq!(out.drops.len(), 1);
    assert_eq!(out.drops[0].reason, "dedupe");
    assert_eq!(out.drops[0].label, "Fraco");
}

#[test]
fn mentiroso_nao_vence_o_limpo_mesmo_com_mais_seeders() {
    let hash = "d".repeat(40);
    let mut lied = stream(&hash, "Lied DUAL\n👤 500", 500.0);
    lied.lied = Some(true);
    lied.dubbed = Some(true);
    lied.dub_claim = Some(true);
    let clean = stream(&hash, "Honest EN\n👤 50", 50.0);
    for pair in [
        vec![lied.clone(), clean.clone()],
        vec![clean.clone(), lied.clone()],
    ] {
        let out = dedupe_by_hash(&DedupeInput {
            streams: pair,
            indexer_priority: vec![],
        });
        assert_eq!(out.streams.len(), 1);
        assert_eq!(out.streams[0].name.as_deref(), Some("Honest EN\n👤 50"));
        assert_eq!(out.streams[0].seeders, Some(500.0));
        assert_eq!(out.streams[0].lied, Some(true));
        assert_eq!(out.streams[0].dubbed, Some(false));
        assert_eq!(out.streams[0].dub_claim, Some(false));
    }
}

#[test]
fn qualidade_rica_do_perdedor_e_herdada() {
    let hash = "e".repeat(40);
    let mut thin = stream(&hash, "Thin", 9.0);
    thin.quality = Some("sem resolução".into());
    let mut rich = stream(&hash, "Rich", 1.0);
    rich.quality = Some("1080p".into());
    rich.size = Some(2_800_000_000.0);
    let out = dedupe_by_hash(&DedupeInput {
        streams: vec![thin, rich],
        indexer_priority: vec![],
    });
    assert_eq!(out.streams[0].quality.as_deref(), Some("1080p"));
    assert_eq!(out.streams[0].size, Some(2_800_000_000.0));
}
