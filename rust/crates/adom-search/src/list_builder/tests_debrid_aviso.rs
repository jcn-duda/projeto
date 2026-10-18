use super::test_common::*;
use crate::latest_writer::LatestWriter;

// ── Debrid: estados ──────────────────────────────────────────────────────────

#[test]
fn cached_only_corta_o_frio_e_deixa_o_aviso_honesto() {
    let mut ctx = base_ctx();
    ctx.debrid_cached_only = true;
    ctx.debrid_cache_check_honest = true;
    ctx.debrid_has_key = true;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = build(
        vec![release(
            "Filme Teste 2024 1080p",
            "aa02000000000000000000000000000000000002",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    // O corte do cachedOnly esvazia a lista de TOCÁVEIS → o aviso fica com a
    // contagem ANTES do debrid.
    assert!(
        out.streams.iter().all(|s| s.notice),
        "só aviso: {:?}",
        out.streams
    );
    assert!(out.debrid_known);
}

#[test]
fn show_uncached_br_mantem_frio_br_dublado_no_cached_only() {
    let mut ctx = base_ctx();
    ctx.debrid_cached_only = true;
    ctx.show_uncached_br = true;
    ctx.debrid_cache_check_honest = true;
    ctx.debrid_has_key = true;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let out = build(
        vec![RawItem {
            // Título casa com base_ctx ("Filme Teste" 2024) + claim dublado.
            title: Some("Filme Teste 2024 [1080p BLU-RAY DUBLADO]".into()),
            info_hash: Some("aa04000000000000000000000000000000000004".into()),
            seeders: Some(1.0),
            is_br: true,
            indexer: Some("bludv".into()),
            ..RawItem::default()
        }],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert!(
        out.streams.iter().any(|s| !s.notice && s.is_br),
        "BR dublado frio deve sobreviver com showUncachedBr: {:?}",
        out.streams
    );
}

#[test]
fn debrid_unusavel_volta_como_p2p_sem_mentir() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: true,
    };
    let out = build(
        vec![release(
            "Filme Teste 2024 1080p",
            "aa03000000000000000000000000000000000003",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(out.debrid_unusable);
    assert!(out.streams[0].item.info_hash.is_some(), "P2P mantém o hash");
}

// ── Aviso de lista vazia (relativo, sem host) ────────────────────────────────

#[test]
fn lista_vazia_de_serie_gera_aviso_relativo_sem_host() {
    let mut ctx = base_ctx();
    ctx.season = Some(1);
    ctx.episode = Some(1);
    ctx.names = vec!["Serie".into()];
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(vec![], &ctx, &opts, &mut debrid);
    assert_eq!(out.streams.len(), 1);
    let item = &out.streams[0].item;
    assert!(out.streams[0].notice);
    let name = item.name.as_deref().unwrap_or_default();
    assert!(name.contains("reabra"), "{name}");
    // SEM base ainda: nada de host na lista (o cache não pode carregar host).
    assert!(item.external_url.is_none());
    assert!(!name.contains("http"));

    // Na resposta, o host é montado com o origin de quem pergunta AGORA.
    let itens = types::apply_notice_origin(&out.streams, Some("http://127.0.0.1:7000"), "/seg");
    assert_eq!(itens.len(), 1);
    assert_eq!(
        itens[0].external_url.as_deref(),
        Some("http://127.0.0.1:7000/seg/configure")
    );
    // Sem base o aviso é descartado (link quebrado não ocupa a tela).
    assert!(types::apply_notice_origin(&out.streams, None, "/seg").is_empty());
}

#[test]
fn filme_sem_candidato_nao_promete_reabrir() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(vec![], &ctx, &opts, &mut debrid);
    assert!(out.streams.is_empty(), "filme vazio sem promessa de série");
}

// ── Parcial → tardio (latest-writer + rebuild) ──────────────────────────────

#[test]
fn parcial_vai_na_resposta_e_tardio_reconstrói_e_regrava() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let writer = LatestWriter::new();

    // Fase 0: coleta parcial (janela fechou) → lista parcial commitada.
    let mut debrid0 = StubDebrid::none();
    let raw0 = vec![release(
        "Filme Teste 2024 1080p antigo",
        "0001000000000000000000000000000000000001",
    )];
    let (parcial, kind) = writer.run(
        0,
        || build(raw0.clone(), &ctx, &opts, &mut debrid0),
        |v: &BuiltList| !v.streams.is_empty(),
        |_| {},
    );
    assert_eq!(kind, crate::latest_writer::CommitKind::Current);
    assert_eq!(parcial.streams.len(), 1, "a parcial é a resposta");

    // Fase avança (fallback de pack começa) e o TARDIO reconstrói do completo.
    writer.advance();
    let mut debrid1 = StubDebrid::none();
    let raw1 = vec![
        release(
            "Filme Teste 2024 1080p antigo",
            "0001000000000000000000000000000000000001",
        ),
        release(
            "Filme Teste 2024 1080p BR DUBLADO",
            "0002000000000000000000000000000000000002",
        ),
    ];
    let (tardio, kind2) = writer.run(
        1,
        || build(raw1.clone(), &ctx, &opts, &mut debrid1),
        |v: &BuiltList| !v.streams.is_empty(),
        |_| {},
    );
    assert_eq!(kind2, crate::latest_writer::CommitKind::Current);
    assert!(
        tardio.streams.len() > parcial.streams.len(),
        "o tardio mescla: a coleta completa traz mais streams (rebuild, não concat)"
    );
    assert!(
        tardio.streams[0].is_br,
        "a regra do BR vale na reconstrução"
    );
}
