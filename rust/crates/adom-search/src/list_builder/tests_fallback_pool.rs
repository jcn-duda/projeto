//! Regressão da reserva 📦 no CAMINHO REAL do build: as flags precisam
//! atravessar `map_stream` → `RankingStream` → `ranking_to_pool` para
//! `fallback_blocked` e as vagas BR de `cachedOnly/showUncachedBr` verem a
//! reserva. Sem isso, uma reserva NÃO fetchable ocupa vaga uncached e uma
//! fetchable não é listada.

use adom_core::{br_dubbed_pool, PoolOptions, RankingStream};
use serde_json::Value;

use super::super::helpers::{map_stream, ranking_to_pool};
use super::test_common::*;

fn ctx_uncached_br() -> BuildContext {
    BuildContext {
        debrid_available: true,
        debrid_has_key: true,
        debrid_cache_check_honest: true,
        debrid_cached_only: true,
        show_uncached_br: true,
        ..base_ctx()
    }
}

fn opts() -> BuildOptions {
    BuildOptions {
        notice_stream: false,
        max_results: 10.0,
        br_reserved_slots: 1.0,
        br_reserved_per_quality: 0.0,
        ..BuildOptions::default()
    }
}

fn missing() -> StubDebrid {
    StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    }
}

fn fallback_item(title: &str, hash: &str, fetchable: bool) -> RawItem {
    let mut item = release(title, hash);
    item.is_br = true;
    item.seeders = Some(10.0);
    item.from_fallback = true;
    if fetchable {
        item.extra.insert("fallbackFetchable".into(), true.into());
    }
    item
}

/// Reserva do banco com `dubbed=1` do classificador e título SEM marca de
/// áudio — o caso do `_bankDub` (Locke & Key S01, 2026-10-08).
fn bank_dub_fallback_item(title: &str, hash: &str) -> RawItem {
    let mut item = fallback_item(title, hash, true);
    item.extra.insert("dubbed".into(), true.into());
    item
}

fn rank_of(item: &RawItem) -> RankingStream {
    map_stream(
        item,
        &StreamDisplayConfig::default(),
        &AudioAudit::default(),
    )
    .expect("item com hash mapeia")
}

fn flag(stream: &RankingStream, key: &str) -> bool {
    stream
        .extra
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[test]
fn propriedades_atravessam_map_stream_ranking_pool() {
    let item = fallback_item(
        "Filme Teste 2024 1080p DUBLADO",
        "f100000000000000000000000000000000000001",
        true,
    );
    let rank = rank_of(&item);
    assert!(flag(&rank, "_fromFallback"));
    assert!(flag(&rank, "_fallbackFetchable"));

    let pool = ranking_to_pool(&rank);
    assert!(
        pool.from_fallback,
        "Ranking → Pool precisa preservar a reserva"
    );
    assert!(
        pool.fallback_fetchable,
        "Ranking → Pool precisa preservar a autorização do Chupim"
    );

    // Compatibilidade: produtores antigos usam a chave sem underscore.
    let mut extra = serde_json::Map::new();
    extra.insert("fromFallback".into(), true.into());
    extra.insert("fallbackFetchable".into(), true.into());
    let legacy = RankingStream {
        extra,
        ..RankingStream::default()
    };
    let pool = ranking_to_pool(&legacy);
    assert!(pool.from_fallback);
    assert!(pool.fallback_fetchable);
}

#[test]
fn reserva_nao_fetchable_nao_ocupa_vaga_br_uncached() {
    let ctx = ctx_uncached_br();
    let out = build(
        vec![fallback_item(
            "Filme Teste 2024 1080p DUBLADO",
            "f200000000000000000000000000000000000002",
            false,
        )],
        &ctx,
        &opts(),
        &mut missing(),
    );
    assert!(
        out.streams.is_empty(),
        "reserva não-fetchable tem que ficar bloqueada, não virar P2P BR: {:?}",
        out.streams
    );
}

#[test]
fn reserva_fetchable_entra_na_vaga_br_uncached() {
    let ctx = ctx_uncached_br();
    let hash = "f300000000000000000000000000000000000003";
    let out = build(
        vec![fallback_item("Filme Teste 2024 1080p DUBLADO", hash, true)],
        &ctx,
        &opts(),
        &mut missing(),
    );
    assert_eq!(out.streams.len(), 1);
    assert_eq!(out.streams[0].item.info_hash.as_deref(), Some(hash));
    assert!(!out.streams[0].cached, "vaga uncached não leva ⚡");
}

#[test]
fn reserva_nao_fetchable_nao_consome_a_vaga_da_fetchable() {
    let ctx = ctx_uncached_br();
    let fetchable = "f400000000000000000000000000000000000004";
    let blocked = "f500000000000000000000000000000000000005";
    let out = build(
        vec![
            // Vem primeiro na ordem do lote: se contasse, consumiria o slot 1.
            fallback_item("Filme Teste 2024 1080p DUBLADO BLOCK", blocked, false),
            fallback_item("Filme Teste 2024 1080p DUBLADO OK", fetchable, true),
        ],
        &ctx,
        &opts(),
        &mut missing(),
    );
    assert_eq!(out.streams.len(), 1);
    assert_eq!(out.streams[0].item.info_hash.as_deref(), Some(fetchable));
}

#[test]
fn reserva_comum_nao_fetchable_continua_como_stream_normal() {
    // Controle: só `from_fallback` aciona o bloqueio; um stream vivo sem a marca
    // continua entrando na vaga uncached.
    let ctx = ctx_uncached_br();
    let hash = "f600000000000000000000000000000000000006";
    let mut item = release("Filme Teste 2024 1080p DUBLADO VIVO", hash);
    item.is_br = true;
    item.seeders = Some(10.0);
    let out = build(vec![item], &ctx, &opts(), &mut missing());
    assert_eq!(out.streams.len(), 1);
    assert_eq!(out.streams[0].item.info_hash.as_deref(), Some(hash));
}

#[test]
fn reserva_br_dubbed_do_banco_abre_vaga_e_pool_do_chupim() {
    let hash = "f700000000000000000000000000000000000007";
    let item = bank_dub_fallback_item("Filme Teste 2024 S01 [720p]", hash);
    let rank = rank_of(&item);
    assert!(
        flag(&rank, "bankDub"),
        "o build precisa gravar a marca que o pool lê"
    );
    let pool = ranking_to_pool(&rank);
    assert!(pool.is_bank_dub, "ranking → pool preserva a evidência");
    assert_eq!(
        br_dubbed_pool(
            &[pool],
            &PoolOptions {
                season: Some(1),
                ..PoolOptions::default()
            }
        ),
        vec![0],
        "o Chupim pode baixar o pack que só o banco sabe ser dublado"
    );
}

#[test]
fn reserva_br_dubbed_do_banco_entra_na_vaga_br_uncached() {
    let ctx = ctx_uncached_br();
    let hash = "f800000000000000000000000000000000000008";
    let out = build(
        vec![bank_dub_fallback_item(
            "Filme Teste 2024 1080p WEB-DL",
            hash,
        )],
        &ctx,
        &opts(),
        &mut missing(),
    );
    assert_eq!(
        out.streams.len(),
        1,
        "sem a marca, a reserva ficaria bloqueada mesmo com vaga livre"
    );
    assert_eq!(out.streams[0].item.info_hash.as_deref(), Some(hash));
}

#[test]
fn reserva_br_dubbed_vetada_nao_ocupa_vaga_nem_entra_no_pool() {
    let ctx = ctx_uncached_br();
    let hash = "f900000000000000000000000000000000000009";
    // LEGENDADO explícito no post contradiz o dubbed=1 gravado.
    let item = bank_dub_fallback_item("Filme Teste 2024 1080p WEB-DL LEGENDADO", hash);
    let rank = rank_of(&item);
    assert!(!flag(&rank, "bankDub"));
    let pool = ranking_to_pool(&rank);
    assert!(!pool.is_bank_dub);
    assert!(br_dubbed_pool(&[pool], &PoolOptions::default()).is_empty());
    let out = build(vec![item], &ctx, &opts(), &mut missing());
    assert!(
        out.streams.is_empty(),
        "reserva vetada não pode virar P2P BR: {:?}",
        out.streams
    );
}
