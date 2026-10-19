//! `fallback` da entrada é lido da lista FINAL (`fallbackInList` do TS),
//! depois do drop do `playDisposition` e do corte: uma reserva descartada não
//! pode marcar a entrada como parcial nem encurtar o TTL.

use super::test_common::*;

fn ctx_com_debrid() -> BuildContext {
    BuildContext {
        debrid_available: true,
        debrid_has_key: true,
        debrid_cache_check_honest: true,
        ..base_ctx()
    }
}

fn known_cold() -> StubDebrid {
    StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    }
}

#[test]
fn reserva_dropada_por_play_disposition_nao_marca_fallback() {
    let ctx = ctx_com_debrid();
    let opts = BuildOptions {
        notice_stream: false,
        ..BuildOptions::default()
    };
    let mut item = release(
        "Filme Teste 2024 1080p",
        "ab10000000000000000000000000000000000010",
    );
    item.from_fallback = true;
    item.multi_work_admitted = true;

    let out = build(vec![item], &ctx, &opts, &mut known_cold());

    assert!(
        out.streams.is_empty(),
        "multiobra admitido frio sai no finalize: {:?}",
        out.streams
    );
    assert!(
        !out.fallback,
        "reserva dropada não pode marcar a entrada (TTL curto/parcial)"
    );
}

#[test]
fn reserva_que_chega_na_lista_marca_fallback() {
    let ctx = ctx_com_debrid();
    let opts = BuildOptions {
        notice_stream: false,
        ..BuildOptions::default()
    };
    let mut item = release(
        "Filme Teste 2024 1080p",
        "ab11000000000000000000000000000000000011",
    );
    item.from_fallback = true;

    let out = build(vec![item], &ctx, &opts, &mut known_cold());

    assert_eq!(out.streams.len(), 1);
    assert!(out.fallback, "reserva na lista final marca a entrada");
}
