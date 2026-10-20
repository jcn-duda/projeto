//! Matriz BR/cotas do BUILD com itens no shape do BLUDV (C3): filme BR, série
//! BR com pack de temporada, dublado × legendado, cachedOnly on/off e brOnly.
//!
//! O item cru do BLUDV não tem `indexer`/`sources`: o `_indexer` do build nasce
//! do `tracker` ("BLUDV" → "bludv"), que é o que as cotas/prioridade usam.

use super::helpers::{map_stream, to_stream_item};
use super::tests::test_common::*;
use super::AudioAudit;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddd";

/// Item no shape do `raw_from_bludv`: tracker BLUDV, sem indexer/sources.
fn bludv(title: &str, hash: &str, audio: &str) -> RawItem {
    let mut extra = serde_json::Map::new();
    extra.insert("audio".into(), serde_json::json!(audio));
    RawItem {
        title: Some(title.into()),
        magnet: Some(format!("magnet:?xt=urn:btih:{hash}&dn=x")),
        seeders: Some(1.0),
        size_bytes: Some(3.0 * 1024.0 * 1024.0 * 1024.0),
        tracker: Some("BLUDV".into()),
        is_br: true,
        extra,
        ..RawItem::default()
    }
}

fn global(title: &str, hash: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        seeders: Some(120.0),
        size_bytes: Some(4.0 * 1024.0 * 1024.0 * 1024.0),
        indexer: Some("yts".into()),
        ..RawItem::default()
    }
}

fn movie_ctx() -> BuildContext {
    BuildContext {
        names: vec!["Filme Teste".into()],
        year: "2024".into(),
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    }
}

#[test]
fn indexer_e_tracker_do_bludv_como_o_node() {
    let raw = bludv("Filme Teste 2024 [1080p WEB-DL DUBLADO]", HASH_A, "dublado");
    let stream = map_stream(
        &raw,
        &adom_core::StreamDisplayConfig::default(),
        &AudioAudit::default(),
    )
    .expect("stream");
    assert_eq!(stream.indexer.as_deref(), Some("bludv"), "o id da cota");
    assert_eq!(stream.tracker.as_deref(), Some("BLUDV"), "o rótulo do ⚙️");
    assert_eq!(stream.br, Some(true));
    assert_eq!(stream.dub_claim, Some(true), "título DUBLADO faz o claim");
    assert_eq!(
        stream.dubbed,
        Some(false),
        "sem prova de arquivo o chip DUB não é 'dubbed'"
    );
    // `sources` do contrato é a lista FIXA de trackers do Node, nunca
    // `tracker:BLUDV` (o BLUDV não publica `sources` no cru).
    let item = to_stream_item(&stream);
    assert_eq!(
        item.info_hash.as_deref(),
        Some(HASH_A),
        "infoHash vem do magnet"
    );
    let sources = item.sources.expect("P2P leva sources");
    assert_eq!(sources.len(), 6);
    assert!(
        sources
            .iter()
            .any(|source| source == "tracker:udp://tracker.opentrackr.org:1337/announce"),
        "a lista é a DEFAULT_TRACKERS do Node: {sources:?}"
    );
    assert!(
        !sources.iter().any(|source| source == "tracker:BLUDV"),
        "o tracker BR não vira source do item"
    );
}

#[test]
fn legendado_nao_ganha_claim_de_dublado() {
    let raw = bludv(
        "Filme Teste 2024 [1080p WEB-DL LEGENDADO]",
        HASH_A,
        "legendado",
    );
    let stream = map_stream(
        &raw,
        &adom_core::StreamDisplayConfig::default(),
        &AudioAudit::default(),
    )
    .expect("stream");
    assert_eq!(stream.dub_claim, Some(false));
    assert_eq!(stream.br, Some(true), "origem BR independe do áudio");
}

#[test]
fn cota_por_indexador_usa_bludv() {
    // Duas releases BLUDV + teto de 1 por indexer e SEM vagas BR reservadas:
    // se o `_indexer` não fosse "bludv", as duas passariam.
    let opts = BuildOptions {
        br_reserved_slots: 0.0,
        br_reserved_per_quality: 0.0,
        max_per_indexer: 1.0,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::none();
    let ctx = movie_ctx();
    let out = build(
        vec![
            bludv("Filme Teste 2024 [1080p WEB-DL DUBLADO]", HASH_A, "dublado"),
            bludv("Filme Teste 2024 [720p WEB-DL DUBLADO]", HASH_B, "dublado"),
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1, "cota por indexer = bludv");
    assert!(out.streams[0].is_br);
}

#[test]
fn vaga_br_reservada_sobrevive_ao_corte_do_global() {
    // O global tem 120 seeders e 1080p; o BR entra por RESERVA mesmo com
    // maxResults=1 (é o `limitReservingBr` depois do pool ampliado).
    let opts = BuildOptions {
        max_results: 1.0,
        br_reserved_slots: 1.0,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            global("Filme Teste 2024 1080p BluRay x264", HASH_C),
            bludv("Filme Teste 2024 [720p WEB-DL DUBLADO]", HASH_A, "dublado"),
        ],
        &movie_ctx(),
        &opts,
        &mut debrid,
    );
    assert!(
        out.streams.iter().any(|stream| stream.is_br),
        "a vaga BR reservada não pode ser engolida pelo global: {:?}",
        out.streams
            .iter()
            .map(|s| s.item.title.clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn serie_br_pack_de_temporada_entra() {
    let mut ctx = BuildContext {
        names: vec!["Serie Teste".into()],
        year: "2024".into(),
        season: Some(1),
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    };
    ctx.debrid_available = true;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![bludv(
            "Serie Teste Temporada 1 Completa 2024 [1080p WEB-DL DUBLADO]",
            HASH_A,
            "dublado",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1, "pack de temporada BR fica na lista");
    assert!(out.streams[0].is_br);
    assert!(out.streams[0].dubbed || out.streams[0].item.title.as_deref().is_some());
}

#[test]
fn cached_only_on_e_off_com_bludv() {
    let mut ctx = movie_ctx();
    ctx.debrid_cache_check_honest = true;
    ctx.debrid_has_key = true;
    ctx.debrid_cached_only = true;
    let opts = BuildOptions::default();
    // Debrid conferiu e NÃO está em cache: cachedOnly corta o BR.
    let mut missing = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = build(
        vec![bludv(
            "Filme Teste 2024 [1080p WEB-DL DUBLADO]",
            HASH_A,
            "dublado",
        )],
        &ctx,
        &opts,
        &mut missing,
    );
    assert!(
        out.streams.iter().all(|stream| stream.notice),
        "cachedOnly + miss = só aviso (nada tocável): {:?}",
        out.streams
            .iter()
            .map(|stream| stream.item.title.clone())
            .collect::<Vec<_>>()
    );

    // cachedOnly off: o mesmo item volta como P2P.
    ctx.debrid_cached_only = false;
    let mut missing = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = build(
        vec![bludv(
            "Filme Teste 2024 [1080p WEB-DL DUBLADO]",
            HASH_A,
            "dublado",
        )],
        &ctx,
        &opts,
        &mut missing,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(out.streams[0].item.info_hash.is_some(), "P2P preserva hash");
}

#[test]
fn br_only_corta_o_global_e_mantem_o_bludv() {
    let opts = BuildOptions {
        br_only: true,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            global("Filme Teste 2024 1080p BluRay x264", HASH_D),
            bludv("Filme Teste 2024 [1080p WEB-DL DUBLADO]", HASH_A, "dublado"),
        ],
        &movie_ctx(),
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1, "brOnly mantém só a origem BR");
    assert!(out.streams[0].is_br);
}
