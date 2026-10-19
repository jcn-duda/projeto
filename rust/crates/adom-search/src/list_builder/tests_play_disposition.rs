//! Regressões do `playDisposition` no BUILD: o corte do `cachedOnly` não pode
//! apagar um lote degradado (`known:false`) e o pack multiobra admitido frio
//! sai da lista ANTES do corte final, não ocupando vaga de quem tocaria.

use super::test_common::*;

fn ctx_com_debrid(cache_check_honest: bool) -> BuildContext {
    BuildContext {
        debrid_available: true,
        debrid_has_key: true,
        debrid_cache_check_honest: cache_check_honest,
        ..base_ctx()
    }
}

fn one(raw: RawItem, ctx: &BuildContext, debrid: &mut dyn DebridCheck) -> BuiltList {
    build(vec![raw], ctx, &BuildOptions::default(), debrid)
}

#[test]
fn unknown_com_cached_only_fica_visivel_como_degradado() {
    let mut ctx = ctx_com_debrid(false); // Debrid-Link / RD sem store
    ctx.debrid_cached_only = true;
    // known:false → ninguém sabe o cache; o Node ignora o cachedOnly sem
    // inventário/ledger e manda tudo pelo `/resolve` (degradado).
    let out = one(
        release(
            "Filme Teste 2024 1080p",
            "aa05000000000000000000000000000000000005",
        ),
        &ctx,
        &mut StubDebrid::none(),
    );
    assert_eq!(out.streams.len(), 1, "unknown não pode ser cortado");
    assert!(!out.debrid_known);
    assert!(out.needs_debrid_refresh);
    assert!(
        out.streams[0].item.info_hash.is_some(),
        "o build não monta URL; o hash continua até o finish"
    );
}

#[test]
fn known_frio_sem_knob_continua_p2p() {
    let ctx = ctx_com_debrid(true);
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = one(
        release(
            "Filme Teste 2024 1080p",
            "aa06000000000000000000000000000000000006",
        ),
        &ctx,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(!out.streams[0].notice);
    assert!(
        out.streams[0].item.info_hash.is_some(),
        "conhecido frio é P2P"
    );
}

#[test]
fn resolve_uncached_marca_o_frio_conhecido() {
    let mut ctx = ctx_com_debrid(true);
    ctx.debrid_resolve_uncached = true;
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = one(
        release(
            "Filme Teste 2024 1080p",
            "aa07000000000000000000000000000000000007",
        ),
        &ctx,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(!out.streams[0].notice, "o knob mantém o frio na lista");
}

#[test]
fn multiobra_fria_admitida_sai_antes_do_corte_sem_knob() {
    let ctx = ctx_com_debrid(true);
    let mut item = release(
        "Filme Teste 2024 1080p",
        "aa08000000000000000000000000000000000008",
    );
    item.multi_work_admitted = true;
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = one(item, &ctx, &mut debrid);
    assert!(
        out.streams
            .iter()
            .all(|stream| stream.notice && stream.info_hash.is_none()),
        "pack multiobra frio sem knob não vai à lista: {:?}",
        out.streams
    );
}

#[test]
fn multiobra_fria_admitida_fica_com_knob() {
    let mut ctx = ctx_com_debrid(true);
    ctx.debrid_resolve_uncached = true;
    let mut item = release(
        "Filme Teste 2024 1080p",
        "aa09000000000000000000000000000000000009",
    );
    item.multi_work_admitted = true;
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = one(item, &ctx, &mut debrid);
    assert_eq!(out.streams.len(), 1);
    assert!(out.streams[0].item.info_hash.is_some());
}

#[test]
fn multiobra_cacheada_resolve_mesmo_sem_knob() {
    let ctx = ctx_com_debrid(true);
    let mut item = release(
        "Filme Teste 2024 1080p",
        "aa0a00000000000000000000000000000000000a",
    );
    item.multi_work_admitted = true;
    let mut debrid = StubDebrid::all();
    let out = one(item, &ctx, &mut debrid);
    assert_eq!(out.streams.len(), 1, "⚡ vence o ramo multiobra");
    assert!(out.streams[0].cached);
}

#[test]
fn sem_debrid_ativo_knob_nao_vira_resolve() {
    // Sem serviço/chave o Node nem chama o `applyDebrid`; o `Unknown` do
    // `NoDebridCheck` não é "frio conhecido", então o knob não age.
    let mut ctx = base_ctx();
    ctx.debrid_resolve_uncached = true;
    assert!(!ctx.debrid_available);
    let mut debrid = StubDebrid::none();
    let out = one(
        release(
            "Filme Teste 2024 1080p",
            "aa0b00000000000000000000000000000000000b",
        ),
        &ctx,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1, "o frio continua como P2P");
    assert!(!out.streams[0].notice);
    assert!(
        out.streams[0].item.info_hash.is_some(),
        "P2P mantém o hash para o cliente"
    );
    assert!(
        out.streams[0].item.url.is_none(),
        "sem debrid ativo não há /resolve"
    );
}

#[test]
fn unusable_com_knob_mantem_p2p() {
    // auth/quota: a conta não responde. O Node devolve a lista P2P mesmo com
    // `resolveUncached` ligado.
    let mut ctx = ctx_com_debrid(true);
    ctx.debrid_resolve_uncached = true;
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: true,
    };
    let out = one(
        release(
            "Filme Teste 2024 1080p",
            "aa0c00000000000000000000000000000000000c",
        ),
        &ctx,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(out.debrid_unusable, "o lote precisa carregar o veredito");
    assert!(
        !out.debrid_known,
        "Unusable é known:false no Node (TTL curto, sem autofetch)"
    );
    assert!(out.streams[0].item.info_hash.is_some());
    assert!(out.streams[0].item.url.is_none());
}

#[test]
fn unusable_com_knob_dropa_multiobra() {
    // Mesmo com o knob, a coleção fria não pode virar torrent inteiro; o Node
    // filtra `_multiWorkAdmitted` no ramo unusable.
    let mut ctx = ctx_com_debrid(true);
    ctx.debrid_resolve_uncached = true;
    let mut item = release(
        "Filme Teste 2024 1080p",
        "aa0d00000000000000000000000000000000000d",
    );
    item.multi_work_admitted = true;
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: true,
    };
    let out = one(item, &ctx, &mut debrid);
    assert!(out.debrid_unusable);
    assert!(!out.debrid_known, "Unusable não prova estado de cache");
    assert!(
        out.streams
            .iter()
            .all(|stream| stream.notice && stream.info_hash.is_none()),
        "multiobra em conta unusable não vai à lista: {:?}",
        out.streams
    );
}

#[test]
fn cacheado_normal_permanece_com_knob() {
    // O ramo do ⚡ não depende do knob nem de lote degradado.
    let mut ctx = ctx_com_debrid(true);
    ctx.debrid_resolve_uncached = true;
    let out = one(
        release(
            "Filme Teste 2024 1080p",
            "aa0e00000000000000000000000000000000000e",
        ),
        &ctx,
        &mut StubDebrid::all(),
    );
    assert_eq!(out.streams.len(), 1);
    assert!(out.streams[0].cached);
    assert!(!out.debrid_unusable);
}
