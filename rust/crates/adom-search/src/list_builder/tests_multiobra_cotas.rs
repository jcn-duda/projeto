use super::test_common::*;

// ── Pack multiobra ──────────────────────────────────────────────────────────

#[test]
fn marcador_generico_de_multiobra_vem_do_titulo_mesmo_sem_admissao() {
    // `_multiWork` do Node = `isMultiWorkCollection(title) || _multiWorkAdmitted`.
    // Sem opt-in TMDB (`multi_work_root = None`) nada é ADMITIDO, mas a coleção
    // detectada pelo título continua levando `p:1` ao `/resolve` — é o caso
    // "Matrix - Trilogia" do gate congelado.
    let mut ctx = base_ctx();
    ctx.names = vec!["The Matrix".into(), "Matrix".into()];
    ctx.year = "1999".into();
    ctx.debrid_available = true;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![release(
            "Matrix - Trilogia [720p DUAL]",
            "26fa43a4ccca61d8f7cf96a106d7fe1801aed9c2",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(
        out.streams[0].multi_work,
        "coleção pelo título é multiobra genérica"
    );
    assert!(
        !out.streams[0].multi_work_admitted,
        "sem opt-in TMDB não há admissão"
    );

    // Título comum não ganha a marca.
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![release(
            "The Matrix 1999 1080p BluRay x264",
            "8dc393c100ef0c0d010cfefdcebe572e26c4f775",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 1);
    assert!(!out.streams[0].multi_work);
}

#[test]
fn pack_multiobra_admitido_vai_no_caminho_critico_com_debrid_e_ano() {
    let mut ctx = base_ctx();
    // "Coleção Teste" cobre o ano? O núcleo exige coleção RECONHECIDA; usa a
    // forma canônica do TS ("Filme 1-3 Coleção Completa" estilo franquia).
    ctx.names = vec!["Missao".into()];
    ctx.year = "2016".into();
    ctx.multi_work_root = Some("missao".into());
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![release(
            "MISSAO IMPOSSIVEL COLECAO COMPLETA 1996-2016 1080p",
            "8888000000000000000000000000000000000088",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    // Aceito ou retido, o pack NUNCA fica silenciosamente P2P inteiro: sem
    // debrid ele é retido (guarda de coleção).
    assert_eq!(out.streams.len(), 0, "sem debrid disponível, pack retido");
    assert_eq!(out.funnel.get("multiwork-retained"), Some(&1));

    // Com debrid disponível e ano de catálogo, o pack entra como candidato.
    ctx.debrid_available = true;
    let out2 = build(
        vec![release(
            "MISSAO IMPOSSIVEL COLECAO COMPLETA 1996-2016 1080p",
            "8888000000000000000000000000000000000088",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out2.streams.len(), 1, "pack admitido segue ao debrid");
    assert_eq!(out2.work_hint.as_ref().and_then(|h| h.year), Some(2016));
}

// ── Piso de seeders × debrid (invariante 3) ─────────────────────────────────

#[test]
fn piso_de_seeders_nao_corta_antes_da_checagem_com_cached_only() {
    let mut ctx = base_ctx();
    ctx.debrid_cache_check_honest = true;
    ctx.debrid_has_key = true;
    ctx.debrid_cached_only = true;
    let opts = BuildOptions {
        min_seeders: 5.0,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::all();
    // BR com 0 seeders (placeholder das fontes BR): o piso sai da frente e o ⚡ decide.
    let mut br = RawItem {
        is_br: true,
        size_bytes: Some(1024.0 * 1024.0 * 1024.0),
        ..release(
            "Filme Teste 2024 1080p DUBLADO",
            "9999000000000000000000000000000000000099",
        )
    };
    br.seeders = Some(1.0);
    let out = build(vec![br.clone()], &ctx, &opts, &mut debrid);
    assert_eq!(out.streams.len(), 1);
    assert!(out.streams[0].cached);
    assert_eq!(
        out.streams[0].item.url.as_deref(),
        Some("/resolve/9999000000000000000000000000000000000099?sig=1"),
        "url relativa, sem host"
    );
    // Item resolvido perde infoHash/sources e leva url.
    assert!(out.streams[0].item.info_hash.is_none());
    assert!(out.debrid_known);

    // Sem cachedOnly, o piso de 5 corta o item fraco antes do debrid — global
    // com seeders reais baixos (o BR dublado tem waiver próprio no núcleo).
    ctx.debrid_cached_only = false;
    let mut fraco = release(
        "Filme Teste 2024 1080p x264 GRP",
        "9800000000000000000000000000000000000001",
    );
    fraco.seeders = Some(1.0);
    let out2 = build(vec![fraco], &ctx, &opts, &mut debrid);
    assert!(out2.streams.is_empty());
}

// ── Cotas / limitReservingBr ────────────────────────────────────────────────

#[test]
fn reserva_br_por_faixa_garante_vagas_depois_do_pool_ampliado() {
    let mut ctx = base_ctx();
    ctx.debrid_has_key = true;
    let opts = BuildOptions {
        max_results: 2.0,
        br_reserved_per_quality: 1.0,
        candidate_pool_factor: 1.0,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::none();
    let mut globais: Vec<RawItem> = (0..3)
        .map(|i| {
            release(
                &format!("Filme Teste 2024 1080p x264 GROUP{i}"),
                &format!("a{:039}", i),
            )
        })
        .collect();
    globais.push(RawItem {
        is_br: true,
        // Seeders publicados (não-placeholder): o pool ampliado mantém o BR.
        seeders: Some(30.0),
        ..release(
            "Filme Teste 2024 1080p DUBLADO BR",
            "b101000000000000000000000000000000000001",
        )
    });
    let out = build(globais, &ctx, &opts, &mut debrid);
    let hashes: Vec<&str> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    assert!(
        hashes.contains(&"b101000000000000000000000000000000000001"),
        "a reserva BR por faixa fura a ordem dos globais: {hashes:?}"
    );
    assert_eq!(hashes.len(), 2, "maxResults se aplica no fim");
}

#[test]
fn teto_por_indexer_limita_o_pool_final() {
    let ctx = base_ctx();
    let opts = BuildOptions {
        max_per_indexer: 1.0,
        max_results: 10.0,
        candidate_pool_factor: 1.0,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::none();
    let raw: Vec<RawItem> = (0..3)
        .map(|i| RawItem {
            indexer: Some("bludv".into()),
            ..release("Filme Teste 2024 1080p", &format!("b{:039}", i))
        })
        .collect();
    let out = build(raw, &ctx, &opts, &mut debrid);
    assert_eq!(out.streams.len(), 1, "teto por indexer no corte final");
}

#[test]
fn lista_ampliada_corta_com_cotas_node_like_e_reserva_br() {
    // ~20 globais 1080p + 6 BR dublados → Node-like: cota 2/faixa + até 6 BR
    // reservados (não consomem a cota) → bem abaixo de maxResults=40.
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let mut raw: Vec<RawItem> = (0..20)
        .map(|i| {
            release(
                &format!("Filme Teste 2024 1080p WEB-DL x264 G{i}"),
                &format!("a{:039x}", i),
            )
        })
        .collect();
    for i in 0..6 {
        raw.push(RawItem {
            is_br: true,
            seeders: Some(30.0),
            ..release(
                &format!("Filme Teste 2024 1080p DUBLADO BR {i}"),
                &format!("b{:039x}", i),
            )
        });
    }
    let out = build(raw, &ctx, &opts, &mut debrid);
    let tocaveis: Vec<_> = out.streams.iter().filter(|s| !s.notice).collect();
    assert!(
        tocaveis.len() <= 12,
        "cotas Node-like (2/faixa + reserva BR) ≤ ~12, veio {}",
        tocaveis.len()
    );
    assert!(tocaveis.len() >= 6, "reserva BR entra: {}", tocaveis.len());
    let br = tocaveis.iter().filter(|s| s.is_br).count();
    assert!(br >= 6, "6 BR reservados sobrevivem: {br}");
}

#[test]
fn show_uncached_br_mantem_vagas_br_sob_cached_only() {
    let mut ctx = base_ctx();
    ctx.debrid_cached_only = true;
    ctx.debrid_cache_check_honest = true;
    ctx.debrid_has_key = true;
    ctx.show_uncached_br = true;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid {
        cached: vec![],
        known: true,
        unusable: false,
    };
    let mut raw: Vec<RawItem> = (0..4)
        .map(|i| {
            release(
                &format!("Filme Teste 2024 1080p WEB-DL G{i}"),
                &format!("c{:039x}", i),
            )
        })
        .collect();
    for i in 0..6 {
        raw.push(RawItem {
            is_br: true,
            seeders: Some(25.0),
            ..release(
                &format!("Filme Teste 2024 1080p DUBLADO {i}"),
                &format!("d{:039x}", i),
            )
        });
    }
    let out = build(raw, &ctx, &opts, &mut debrid);
    let tocaveis: Vec<_> = out.streams.iter().filter(|s| !s.notice).collect();
    assert!(
        !tocaveis.is_empty(),
        "com showUncachedBr não pode virar só aviso"
    );
    assert!(
        tocaveis.iter().all(|s| s.is_br && !s.cached),
        "só BR P2P frio (globais cortados pelo cachedOnly): {:?}",
        tocaveis
            .iter()
            .map(|s| (s.is_br, s.cached))
            .collect::<Vec<_>>()
    );
    assert!(
        tocaveis.len() <= opts.br_reserved_slots as usize,
        "no máximo brReservedSlots: {}",
        tocaveis.len()
    );
}
