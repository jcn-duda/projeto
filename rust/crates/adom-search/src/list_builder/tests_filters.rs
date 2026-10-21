use super::test_common::*;
use std::collections::HashMap;

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

/// Foto do índice e reserva do banco exibem 📦 e seeders `~N` (o `stored` do
/// `toStremioStream`); item vivo segue com `👤 N` puro.
#[test]
fn foto_do_indice_e_reserva_exibem_selo_de_dado_salvo() {
    use crate::list_builder::helpers::stats_line;
    use crate::raw_item::RawItem;
    let vivo = RawItem {
        seeders: Some(12.0),
        ..RawItem::default()
    };
    let foto = RawItem {
        seeders: Some(12.0),
        from_snapshot: true,
        ..RawItem::default()
    };
    let reserva = RawItem {
        from_fallback: true,
        ..RawItem::default()
    };
    assert_eq!(stats_line(&vivo), "👤 12");
    assert_eq!(stats_line(&foto), "📦 👤 ~12");
    assert_eq!(stats_line(&reserva), "📦 👤 ~");
}

/// Rótulo do tracker e fonte pelo `dn=`, como o `toStremioStream`.
#[test]
fn tracker_do_jackett_e_fonte_pelo_dn_do_magnet() {
    use crate::list_builder::helpers::{display_source, display_tracker, stats_line};
    use crate::raw_item::RawItem;
    let item = RawItem {
        indexer: Some("redetorrent".into()),
        tracker: Some("Rede Torrent".into()),
        magnet: Some("magnet:?xt=urn:btih:abc&dn=Filme.2024.1080p.WEB-DL.x264".into()),
        seeders: Some(3.0),
        ..RawItem::default()
    };
    assert_eq!(display_tracker(&item), Some("Rede Torrent"));
    assert_eq!(stats_line(&item), "👤 3 ⚙️ Rede Torrent");
    assert_eq!(display_source(&item, "Filme 2024 [1080p]"), "WEB-DL");

    let cam = RawItem {
        magnet: Some("magnet:?xt=urn:btih:abc&dn=Filme.2026.CAMRip.x264".into()),
        ..RawItem::default()
    };
    assert_eq!(
        display_source(&cam, "Filme 2026 1080p WEB-DL"),
        "CAM",
        "CAM no magnet vence"
    );

    let so_id = RawItem {
        indexer: Some("yts".into()),
        ..RawItem::default()
    };
    assert_eq!(display_tracker(&so_id), Some("yts"));
    let indexado = RawItem {
        media_source: Some("BluRay".into()),
        ..RawItem::default()
    };
    assert_eq!(display_source(&indexado, "Filme 2024"), "BluRay");
}

/// O banco de magnets da CONTA já provou o hash quebrado (bad/lie/dead/miss):
/// o Node o corta antes da checagem (`pruneKnownBroken`) e o nativo também —
/// medido em Cidade de Deus, onde o Rust exibia release com `lie` na conta.
#[test]
fn hash_quebrado_na_conta_sai_antes_da_checagem() {
    let ctx = base_ctx();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let quebrado = "cc03000000000000000000000000000000000003";
    let bom = "dd04000000000000000000000000000000000004";
    let out = build(
        vec![
            RawItem {
                broken: true,
                is_br: true,
                ..release("Filme.Teste.2024.1080p.BluRay.DUBLADO", quebrado)
            },
            RawItem {
                is_br: true,
                ..release("Filme.Teste.2024.720p.BluRay.DUBLADO", bom)
            },
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    let hashes: Vec<_> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    assert_eq!(
        hashes,
        [bom],
        "o hash quebrado não pode ocupar vaga nem ir ao debrid"
    );
}

/// F4.4a — a MESMA poda, agora com a evidência lida do `cache.db` pela fonte
/// injetada (`STREAM_BAD_RUST`): com coleta/índice nativos o item não passa
/// pela rota de evidência do Node, então o `broken` não vem no item.
#[test]
fn broken_hashes_da_conta_cortam_mesmo_sem_marca_no_item() {
    let mut ctx = base_ctx();
    let quebrado = "cc03000000000000000000000000000000000003";
    let bom = "dd04000000000000000000000000000000000004";
    ctx.broken_hashes = [quebrado.to_string()].into_iter().collect();
    let opts = BuildOptions::default();
    let mut debrid = StubDebrid::none();
    let out = build(
        vec![
            RawItem {
                is_br: true,
                ..release("Filme.Teste.2024.1080p.BluRay.DUBLADO", quebrado)
            },
            RawItem {
                is_br: true,
                ..release("Filme.Teste.2024.720p.BluRay.DUBLADO", bom)
            },
        ],
        &ctx,
        &opts,
        &mut debrid,
    );
    let hashes: Vec<_> = out
        .streams
        .iter()
        .filter_map(|s| s.item.info_hash.as_deref())
        .collect();
    assert_eq!(hashes, [bom], "bad/lie da conta cortam antes da checagem");

    // Conjunto vazio (sem fonte) não poda nada: a régua antiga continua.
    let mut sem_fonte = base_ctx();
    sem_fonte.broken_hashes.clear();
    let out = build(
        vec![RawItem {
            is_br: true,
            ..release("Filme.Teste.2024.1080p.BluRay.DUBLADO", quebrado)
        }],
        &sem_fonte,
        &opts,
        &mut StubDebrid::none(),
    );
    assert_eq!(out.streams.len(), 1, "sem fonte o hash não é cortado");
}
