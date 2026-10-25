use super::write::hash_of;
use super::*;
use adom_search::RawItem;
use serde_json::json;

fn h(n: u8) -> String {
    format!("{:040x}", n)
}

fn movie() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

fn seed_magnet(
    store: &MagnetBankStore,
    hash: &str,
    title: &str,
    is_br: bool,
    seeders: i64,
    seen: i64,
) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet (hash, uri, title, size, is_br, dubbed, quality, seeders_max, seeders_last, first_seen, last_seen, lied) \
         VALUES ('{hash}', 'magnet:?xt=urn:btih:{hash}&dn={title}', '{title}', 100, {}, {}, '1080p', {seeders}, {seeders}, {seen}, {seen}, 0);",
        i64::from(is_br),
        i64::from(is_br),
    ));
}

fn seed_work(
    store: &MagnetBankStore,
    hash: &str,
    imdb: &str,
    season: i64,
    episode: i64,
    passed: i64,
    seen: i64,
) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter) \
         VALUES ('{hash}', '{imdb}', {season}, {episode}, {seen}, {seen}, {passed});"
    ));
}

fn seed_source(store: &MagnetBankStore, hash: &str, indexer: &str, tracker: &str, seen: i64) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet_source (hash, indexer, tracker, first_seen, last_seen, seeders_last) \
         VALUES ('{hash}', '{indexer}', '{tracker}', {seen}, {seen}, 1);"
    ));
}

#[test]
fn le_obras_na_ordem_do_node() {
    let store = MagnetBankStore::open_memory().expect("memória");
    let imdb = "tt1000001";
    seed_magnet(&store, &h(1), "Filme A 1080p", true, 5, 100);
    seed_magnet(&store, &h(2), "Filme B 720p", false, 9, 200);
    seed_work(&store, &h(1), imdb, -1, -1, 1, 100);
    seed_work(&store, &h(2), imdb, -1, -1, 0, 200);
    let works = store
        .works_for_obra_many(imdb, &[movie()], 100, 300, None)
        .expect("obras");
    // `passed_filter DESC` na frente do `last_seen`.
    assert_eq!(works.len(), 2);
    assert_eq!(works[0].hash, h(1));
    assert_eq!(works[0].passed_filter, 1);
    assert_eq!(works[1].hash, h(2));
    let magnet = works[0].magnet.as_ref().expect("magnet anexado");
    assert_eq!(magnet.title, "Filme A 1080p");
    assert!(magnet.is_br);
    assert_eq!(magnet.seeders_last, 5);
}

#[test]
fn filtro_por_indexer_acontece_antes_do_limite() {
    let store = MagnetBankStore::open_memory().expect("memória");
    let imdb = "tt1000002";
    for (n, indexer) in [(1u8, "global"), (2, "global"), (3, "bludv")] {
        seed_magnet(&store, &h(n), "Serie 1080p", true, 1, 100 + i64::from(n));
        seed_work(&store, &h(n), imdb, -1, -1, 0, 100 + i64::from(n));
        seed_source(&store, &h(n), indexer, "", 100 + i64::from(n));
    }
    let only = vec!["bludv".to_string()];
    let works = store
        .works_for_obra_many(imdb, &[movie()], 100, 300, Some(&only))
        .expect("obras");
    assert_eq!(works.len(), 1);
    assert_eq!(
        works[0].hash,
        h(3),
        "o BR é lido mesmo com globais mais novos"
    );
}

#[test]
fn fontes_agrupadas_por_hash() {
    let store = MagnetBankStore::open_memory().expect("memória");
    seed_source(&store, &h(1), "bludv", "BluDV", 10);
    seed_source(&store, &h(1), "nerdfilmes", "Nerd", 20);
    seed_source(&store, &h(2), "torrentio", "", 30);
    let sources = store.sources_for_many(&[h(1), h(2)]).expect("fontes");
    assert_eq!(sources.get(&h(1)).map(Vec::len), Some(2));
    assert_eq!(sources.get(&h(2)).map(Vec::len), Some(1));
    assert_eq!(sources[&h(2)][0].tracker, "");
    assert!(
        sources[&h(1)].iter().all(|source| source.allowed),
        "veredito é do pedido"
    );
}

#[test]
fn marca_passed_filter_so_em_linha_existente() {
    let store = MagnetBankStore::open_memory().expect("memória");
    let imdb = "tt1000003";
    seed_magnet(&store, &h(1), "Filme 1080p", false, 1, 100);
    seed_work(&store, &h(1), imdb, -1, -1, 0, 100);
    let ctx = WorkCtx {
        imdb_id: imdb.to_string(),
        season: None,
        episode: None,
    };
    let entered = vec![
        json!({"infoHash": h(1)}),
        json!({"infoHash": h(9)}), // sem linha: não cria órfão
    ];
    let survivors = vec![json!({"infoHash": h(1)})];
    assert!(store.mark_filter_outcome(&entered, &survivors, &ctx, 999));
    let works = store
        .works_for_obra_many(imdb, &[movie()], 100, 300, None)
        .expect("obras");
    assert_eq!(works.len(), 1, "hash sem linha não vira obra");
    assert_eq!(works[0].passed_filter, 1);
    assert_eq!(works[0].last_seen, 999);
    // Segundo lote: o hash que não sobreviveu volta para 0.
    assert!(store.mark_filter_outcome(&entered, &[], &ctx, 1000));
    let works = store
        .works_for_obra_many(imdb, &[movie()], 100, 300, None)
        .expect("obras");
    assert_eq!(works[0].passed_filter, 0);
}

#[test]
fn marca_atrasada_nao_regride_a_linha_mais_nova() {
    let store = MagnetBankStore::open_memory().expect("memória");
    let imdb = "tt1000006";
    seed_magnet(&store, &h(1), "Filme 1080p", false, 1, 100);
    seed_work(&store, &h(1), imdb, -1, -1, 0, 100);
    let ctx = WorkCtx {
        imdb_id: imdb.to_string(),
        season: None,
        episode: None,
    };
    let entered = vec![json!({"infoHash": h(1)})];
    assert!(store.mark_filter_outcome(&entered, &entered, &ctx, 500));
    // Lote com carimbo ANTERIOR ao da linha (o Node grava `Date.now()` do seu
    // próprio relógio depois de ler): não reescreve o veredito nem recua
    // `last_seen`. É o CAS que fecha o lost update da Fase 4.0.4.
    assert!(store.mark_filter_outcome(&entered, &[], &ctx, 400));
    let works = store
        .works_for_obra_many(imdb, &[movie()], 100, 300, None)
        .expect("obras");
    assert_eq!(
        works[0].passed_filter, 1,
        "observação antiga não derruba a marca nova"
    );
    assert_eq!(works[0].last_seen, 500, "last_seen só avança");
}

#[test]
fn marca_o_pack_da_temporada_quando_o_titulo_declara() {
    let store = MagnetBankStore::open_empty_memory();
    let imdb = "tt1000004";
    seed_magnet(&store, &h(1), "Serie 1ª Temporada 1080p", true, 1, 100);
    seed_work(&store, &h(1), imdb, 1, 2, 0, 100);
    seed_work(&store, &h(1), imdb, 1, -1, 0, 100);
    let ctx = WorkCtx {
        imdb_id: imdb.to_string(),
        season: Some(1),
        episode: Some(2),
    };
    let entered = vec![json!({"title": "Serie 1ª Temporada 1080p", "infoHash": h(1)})];
    assert!(store.mark_filter_outcome(&entered, &entered, &ctx, 500));
    let episode = store
        .works_for_obra_many(
            imdb,
            &[WorkTarget {
                season: Some(1),
                episode: Some(2),
            }],
            100,
            300,
            None,
        )
        .expect("ep");
    let season = store
        .works_for_obra_many(
            imdb,
            &[WorkTarget {
                season: Some(1),
                episode: None,
            }],
            100,
            300,
            None,
        )
        .expect("season");
    assert_eq!(episode[0].passed_filter, 1, "obra do pedido");
    assert_eq!(season[0].passed_filter, 1, "pack declarado no título");
}

#[test]
fn evidencia_br_do_acervo() {
    let store = MagnetBankStore::open_memory().expect("memória");
    let imdb = "tt1000005";
    seed_magnet(&store, &h(1), "Filme 1080p", false, 1, 100);
    seed_work(&store, &h(1), imdb, -1, -1, 0, 100);
    assert!(!store.has_br_row(imdb, &[movie()]));
    seed_magnet(&store, &h(2), "Filme Dublado 1080p", true, 1, 100);
    seed_work(&store, &h(2), imdb, -1, -1, 0, 100);
    assert!(store.has_br_row(imdb, &[movie()]));
}

#[test]
fn reabre_do_disco() {
    let dir = tempfile::tempdir().expect("tmp");
    let path = dir.path().join("magnets.db");
    {
        let store = MagnetBankStore::open(&path).expect("abre");
        seed_magnet(&store, &h(1), "Filme 1080p", true, 3, 100);
        seed_work(&store, &h(1), "tt1000006", -1, -1, 1, 100);
    }
    let reopened = MagnetBankStore::open(&path).expect("reabre");
    let works = reopened
        .works_for_obra_many("tt1000006", &[movie()], 100, 300, None)
        .expect("obras");
    assert_eq!(works.len(), 1, "restart não perde o acervo");
    assert_eq!(
        works[0].magnet.as_ref().map(|m| m.title.as_str()),
        Some("Filme 1080p")
    );
}

#[test]
fn hash_of_do_item() {
    assert_eq!(
        hash_of(&json!({"infoHash": "ABCDEF0123456789ABCDEF0123456789ABCDEF01"})),
        "abcdef0123456789abcdef0123456789abcdef01"
    );
    assert_eq!(
        hash_of(&json!({"magnet": format!("magnet:?xt=urn:btih:{}", h(1))})),
        h(1)
    );
    assert_eq!(
        hash_of(&json!({"Guid": format!("magnet:?xt=urn:btih:{}", h(2))})),
        h(2),
        "Guid entra como candidato, como no hashOf do Node"
    );
    assert_eq!(hash_of(&json!({"title": "nada"})), "");
}

// Helper: mesmo banco em memória, nome explícito para o teste do pack.
impl MagnetBankStore {
    fn open_empty_memory() -> Self {
        Self::open_memory().expect("memória")
    }
}

// ─── Captura (`captureItems`) ──────────────────────────────────────────────

/// Item cru mínimo da captura: hash + título + indexer (+ seeders opcional).
fn raw(hash: &str, title: &str, indexer: &str, seeders: Option<f64>) -> RawItem {
    RawItem {
        title: Some(title.to_string()),
        info_hash: Some(hash.to_string()),
        magnet: Some(format!("magnet:?xt=urn:btih:{hash}&dn={title}")),
        seeders,
        indexer: Some(indexer.to_string()),
        ..RawItem::default()
    }
}

fn ctx() -> WorkCtx {
    WorkCtx {
        imdb_id: "tt1".into(),
        season: None,
        episode: None,
    }
}

/// Dois itens do MESMO hash em indexers diferentes (hash repetido na leva).
fn dois_itens(hash: &str) -> Vec<RawItem> {
    vec![
        raw(hash, "Filme A 1080p", "indexer-a", Some(5.0)),
        raw(hash, "Filme A 1080p", "indexer-b", Some(9.0)),
    ]
}

#[test]
fn captura_grava_magnet_e_source_e_preserva_passed_filter_mais_novo() {
    let bank = MagnetBankStore::open_empty_memory();
    let hash = h(1);
    // Obra já marcada 1 num carimbo ANTERIOR: a captura (mais nova) grava o
    // magnet e a fonte, mas NÃO reabre o filtro da obra.
    seed_work(&bank, &hash, "tt1", -1, -1, 1, 500);
    let n = bank
        .capture_items(&dois_itens(&hash), "jackett", &ctx(), 1_000)
        .expect("captura");
    assert_eq!(n, 2, "os dois itens passam pelo guardrail");
    let rows = bank
        .works_for_obra_many("tt1", &[movie()], 100, 300, None)
        .expect("obras");
    assert_eq!(rows.len(), 1, "dois indexers do mesmo hash = UMA obra");
    assert_eq!(rows[0].passed_filter, 1, "captura não desmarca a obra");
    assert_eq!(rows[0].last_seen, 1_000, "last_seen avança para o carimbo");
    assert_eq!(rows[0].first_seen, 500, "first_seen é fixo");
    let magnet = rows[0].magnet.as_ref().expect("magnet anexado");
    assert_eq!(magnet.seeders_max, 9, "seeders_max é o máximo da leva");
    assert_eq!(magnet.seeders_last, 9, "seeders_last é a última leva");
    assert!(magnet.uri.contains("dn="), "uri do post preservada");
    // `source` explícito manda no grupo: uma fonte só, mesmo com 2 indexers.
    let sources = bank
        .sources_for_many(std::slice::from_ref(&hash))
        .expect("fontes");
    assert_eq!(sources[&hash].len(), 1);
    assert_eq!(sources[&hash][0].indexer, "jackett");
}

#[test]
fn captura_atrasada_nao_desmarca_passed_filter_nem_reduz_last_seen() {
    let bank = MagnetBankStore::open_empty_memory();
    let hash = h(2);
    seed_magnet(&bank, &hash, "Filme B 1080p", false, 7, 5_000);
    seed_work(&bank, &hash, "tt1", -1, -1, 1, 5_000);
    // Leva com carimbo ATRASADO (relógio para trás): nada pode regredir.
    let n = bank
        .capture_items(
            &[raw(&hash, "Filme B 1080p", "bludv", Some(2.0))],
            "",
            &ctx(),
            1_000,
        )
        .expect("captura");
    assert_eq!(n, 1);
    let rows = bank
        .works_for_obra_many("tt1", &[movie()], 100, 300, None)
        .expect("obras");
    assert_eq!(rows[0].passed_filter, 1, "carimbo antigo não desmarca");
    assert_eq!(rows[0].last_seen, 5_000, "last_seen é MAX");
    let magnet = rows[0].magnet.as_ref().expect("magnet anexado");
    assert_eq!(magnet.last_seen, 5_000, "magnet.last_seen também é MAX");
    assert_eq!(magnet.seeders_max, 7, "máximo preservado");
    // Seeders ausente preserva; presente (mesmo atrasado) é observação.
    assert_eq!(magnet.seeders_last, 2);
    // `source` vazio: o grupo sai do PRÓPRIO item (`indexer || tracker`).
    let sources = bank
        .sources_for_many(std::slice::from_ref(&hash))
        .expect("fontes");
    assert_eq!(sources[&hash][0].indexer, "bludv");
}
