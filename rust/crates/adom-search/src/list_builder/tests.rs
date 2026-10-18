//! Testes do BUILD da lista — a sequência feliz filme/série, pack multiobra,
//! parcial/tardio, aviso relativo, cotas/limitReservingBr, piso de seeders e
//! pré-air.

use std::collections::HashMap;

use adom_core::StreamDisplayConfig;

use super::*;

use crate::latest_writer::LatestWriter;

fn base_ctx() -> BuildContext {
    BuildContext {
        names: vec!["Filme Teste".to_string()],
        year: "2024".into(),
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    }
}

fn release(title: &str, hash: &str) -> RawItem {
    RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        seeders: Some(20.0),
        ..RawItem::default()
    }
}

/// Stub do debrid: hash no conjunto = ⚡; `known` controla known:false.
struct StubDebrid {
    cached: Vec<String>,
    known: bool,
    unusable: bool,
}

impl StubDebrid {
    fn none() -> Self {
        StubDebrid {
            cached: vec![],
            known: false,
            unusable: false,
        }
    }
    fn all() -> Self {
        StubDebrid {
            cached: vec!["*".into()],
            known: true,
            unusable: false,
        }
    }
}

impl DebridCheck for StubDebrid {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        if self.unusable {
            return DebridAnswer::Unusable;
        }
        let hash = stream.info_hash.clone().unwrap_or_default();
        let hit = self.cached.iter().any(|c| c == "*" || *c == hash);
        if hit {
            DebridAnswer::Cached {
                url: Some(format!("/resolve/{hash}?sig=1")),
            }
        } else if self.known {
            DebridAnswer::Missing
        } else {
            DebridAnswer::Unknown
        }
    }
}

fn build(
    raw: Vec<RawItem>,
    ctx: &BuildContext,
    opts: &BuildOptions,
    debrid: &mut dyn DebridCheck,
) -> BuiltList {
    build_stream_list(&raw, ctx, opts, debrid, &StreamDisplayConfig::default())
}

// ── Filme feliz ─────────────────────────────────────────────────────────────

#[test]
fn filme_happy_path_origem_br_primeiro_e_contrato_limpo() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            release(
                "Filme Teste 2024 1080p WEB-DL x264 GRINGO",
                "aa01000000000000000000000000000000000001",
            ),
            // Origem BR é CAMPO: sem marca de áudio, o provider diz que é BR.
            RawItem {
                is_br: true,
                ..release(
                    "Filme.Teste.2024.1080p.BluRay",
                    "bb02000000000000000000000000000000000002",
                )
            },
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert_eq!(out.streams.len(), 2);
    // BR reservado vem primeiro (brFirst) — e a origem é campo, não regex.
    assert!(out.streams[0].is_br, "a origem BR do provider liga o flag");
    assert_eq!(
        out.streams[0].item.info_hash.as_deref(),
        Some("bb02000000000000000000000000000000000002")
    );
    // Contrato: nenhum campo interno `_*` vaza; sem url (P2P puro).
    let item = &out.streams[0].item;
    assert!(item.url.is_none() && item.external_url.is_none());
    assert!(item.name.as_deref().unwrap_or_default().contains("1080p"));
    assert!(item.title.as_deref().unwrap_or_default().contains("👤 20"));
    assert_eq!(out.funnel.get("raw"), Some(&2));
    // known:false não é "nada em cache": precisa do passe tardio.
    assert!(!out.debrid_known);
    assert!(out.needs_debrid_refresh);
}

#[test]
fn titulo_em_portugues_sem_marcador_liga_br_pelo_looks_pt_br() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![release(
            "Filme Teste 2024 1080p DUBLADO NATAL",
            "cc03000000000000000000000000000000000003",
        )],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert!(out.streams[0].is_br, "looks_pt_br promove a origem");
}

#[test]
fn entidades_html_saem_antes_da_decisao() {
    // Contexto de série: "4ª Temporada" é pack, não "série em filme".
    let mut ctx = base_ctx();
    ctx.names = vec!["Dois Homens e Meio".into()];
    ctx.season = Some(4);
    ctx.episode = Some(1);
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let item = release(
        "Dois Homens e Meio 4&ordf; Temporada 1080p",
        "dd04000000000000000000000000000000000004",
    );
    let out = build(vec![item], &ctx, &opts, &mut debrid);
    assert!(
        !out.streams.is_empty(),
        "pack da temporada sobrevive ao filtro"
    );
    let title = out.streams[0].item.title.clone().unwrap_or_default();
    assert!(title.contains("4ª"), "entidade decodificada: {title}");
    assert!(!title.contains("&ordf;"));
}

// ── Release falsa ───────────────────────────────────────────────────────────

#[test]
fn executavel_e_irmao_do_mesmo_hash_cortados_antes_de_tudo() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            release(
                "Resident Evil 2026 1080p WEB-DL-FLUX.exe",
                "ee05000000000000000000000000000000000005",
            ),
            // O MESMO hash noutro indexer é o mesmo torrent falso.
            RawItem {
                indexer: Some("lime".into()),
                ..release(
                    "Resident Evil 2026 1080p WEB-DL-FLUX",
                    "ee05000000000000000000000000000000000005",
                )
            },
            // Irmão: mesma base normalizada de um executável do lote.
            release(
                "Resident Evil 2026 1080p WEB-DL FLUX",
                "ff06000000000000000000000000000000000006",
            ),
            release(
                "Filme Teste 2024 1080p",
                "ab07000000000000000000000000000000000007",
            ),
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    let hashes: Vec<&str> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    assert!(
        !hashes.contains(&"ee05000000000000000000000000000000000005"),
        "executável e hash gêmeo saem: {hashes:?}"
    );
    assert!(
        !hashes.contains(&"ff06000000000000000000000000000000000006"),
        "irmão da mesma base sai: {hashes:?}"
    );
    assert!(hashes.contains(&"ab07000000000000000000000000000000000007"));
    assert_eq!(out.funnel.get("fake-release"), Some(&3));
}

#[test]
fn item_da_conta_com_executavel_sai_mas_nao_semeia_irmao() {
    let mut ctx = base_ctx();
    ctx.names = vec!["Lanterns".into()];
    ctx.season = Some(1);
    ctx.episode = Some(8);
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            RawItem {
                from_account: true,
                ..release(
                    "Lanterns S01E08 1080p CAKES.exe",
                    "ee08000000000000000000000000000000000008",
                )
            },
            release(
                "Lanterns S01E08 1080p CAKES",
                "ee09000000000000000000000000000000000009",
            ),
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    let hashes: Vec<&str> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    // O executável da conta sai (prova do arquivo); o irmão FICA (a isenção da
    // conta vale para a heurística, não para a prova).
    assert_eq!(hashes, vec!["ee09000000000000000000000000000000000009"]);
}

// ── Série feliz ─────────────────────────────────────────────────────────────

#[test]
fn serie_filtra_episodio_errado_e_mantem_pack_da_temporada() {
    let mut ctx = base_ctx();
    ctx.names = vec!["Serie".into()];
    ctx.season = Some(1);
    ctx.episode = Some(2);
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            release(
                "Serie S01E03 1080p",
                "1111000000000000000000000000000000000011",
            ),
            release(
                "Serie S01E02 1080p",
                "2222000000000000000000000000000000000022",
            ),
            release(
                "Serie S01 2160p WEB-DL",
                "3333000000000000000000000000000000000033",
            ),
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    let hashes: Vec<&str> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    assert_eq!(
        hashes,
        vec![
            "2222000000000000000000000000000000000022",
            "3333000000000000000000000000000000000033"
        ],
        "E03 sai; E02 e pack ficam: {hashes:?}"
    );
    assert_eq!(out.funnel.get("episode-mismatch"), Some(&1));
}

#[test]
fn pack_da_temporada_ganha_media_de_episodio_no_disquete() {
    let mut ctx = base_ctx();
    ctx.names = vec!["Serie".into()];
    ctx.season = Some(1);
    ctx.episode = Some(2);
    ctx.episode_counts = vec![(1, 10)];
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let mut pack = release(
        "Serie S01 2160p WEB-DL",
        "4444000000000000000000000000000000000044",
    );
    pack.size_bytes = Some(10.0 * 1024.0 * 1024.0 * 1024.0);
    let out = build(vec![pack], &ctx, &opts, &mut debrid);
    let title = out.streams[0].item.title.clone().unwrap_or_default();
    assert!(
        title.contains("💾 1.00 GB 📦") && title.contains("(média)"),
        "💾 de episódio antes do debrid: {title}"
    );
}

#[test]
fn episodio_ainda_nao_exibido_pack_velho_sem_margem_nao_entra() {
    let mut ctx = base_ctx();
    ctx.names = vec!["Serie".into()];
    ctx.season = Some(1);
    ctx.episode = Some(8);
    // Estreia em 3 dias (mais que a margem de 24h de unaired). Épocas reais:
    // a guarda saneia datas anteriores a 2000.
    ctx.now_ms = 1_700_000_000_000;
    ctx.episode_aired_at_ms = Some(1_700_000_000_000 + 3 * 86_400_000);
    let opts = BuildOptions {
        unaired_margin_ms: 24 * 60 * 60 * 1000,
        ..BuildOptions::default()
    };
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            // Pack velho publicado 6 dias antes da estreia: não contém o E08.
            RawItem {
                published_at: Some(1_700_000_000_000.0 - 6.0 * 86_400_000.0),
                ..release(
                    "Serie S01 1080p pack",
                    "5555000000000000000000000000000000000055",
                )
            },
            // Publicado DEPOIS da estreia-margem e NOMEIA o episódio: fica.
            RawItem {
                published_at: Some(1_700_000_000_000.0 + 3.0 * 86_400_000.0 + 1000.0),
                ..release(
                    "Serie S01E08 1080p novo",
                    "6666000000000000000000000000000000000066",
                )
            },
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    let hashes: Vec<&str> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    assert!(
        !hashes.contains(&"5555000000000000000000000000000000000055"),
        "pré-air sai: {hashes:?}"
    );
    assert!(hashes.contains(&"6666000000000000000000000000000000000066"));
}

#[test]
fn pre_air_na_conta_usa_so_o_first_seen_injetado() {
    let mut ctx = base_ctx();
    ctx.names = vec!["Serie".into()];
    ctx.season = Some(1);
    ctx.episode = Some(8);
    ctx.now_ms = 1_700_000_000_000;
    ctx.episode_aired_at_ms = Some(1_700_000_000_000 + 48 * 60 * 60 * 1000);
    let mut seen = HashMap::new();
    // Visto 49h antes da estreia: fora da margem de 48h do pré-air.
    seen.insert(
        "7777000000000000000000000000000000000077".to_string(),
        1_700_000_000_000.0 - 49.0 * 3_600_000.0,
    );
    ctx.first_seen_ms = seen;
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![RawItem {
            from_account: true,
            ..release(
                "Serie S01E08 1080p",
                "7777000000000000000000000000000000000077",
            )
        }],
        &ctx,
        &opts,
        &mut debrid,
    );
    assert!(
        out.streams.iter().all(|s| s.notice),
        "first_seen anterior à estreia-margem corta mesmo na conta (só aviso)"
    );
}

// ── Pack multiobra ──────────────────────────────────────────────────────────

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
