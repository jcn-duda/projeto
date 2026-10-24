use super::super::test_common::*;

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
/// injetada: com coleta/índice nativos o item não passa pela rota de evidência
/// do Node, então o `broken` não vem no item.
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
