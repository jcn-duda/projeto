//! Testes da seleção instantânea (dedupe por hash, elegibilidade, ordem e
//! tetos), extraídos de instant_bank.rs para caber na catraca de 400 linhas.

use super::*;

fn magnet(
    hash: &str,
    title: &str,
    is_br: bool,
    dubbed: bool,
    seeders: i64,
    seen: i64,
) -> InstantMagnet {
    InstantMagnet {
        hash: hash.to_string(),
        uri: format!("magnet:?xt=urn:btih:{hash}&dn={title}"),
        title: title.to_string(),
        size: 10,
        is_br,
        dubbed,
        quality: "1080p".to_string(),
        seeders_max: seeders,
        seeders_last: seeders,
        last_seen: seen,
        lied: false,
    }
}

fn work(hash: &str, passed: i64, seen: i64, magnet: Option<InstantMagnet>) -> InstantWork {
    InstantWork {
        hash: hash.to_string(),
        passed_filter: passed,
        last_seen: seen,
        first_seen: seen - 100,
        magnet,
    }
}

fn source(indexer: &str, allowed: bool) -> InstantSource {
    InstantSource {
        indexer: indexer.to_string(),
        tracker: String::new(),
        last_seen: 10,
        allowed,
    }
}

fn base(works: Vec<InstantWork>, sources: BTreeMap<String, Vec<InstantSource>>) -> InstantInput {
    InstantInput {
        works,
        sources,
        exclude_hashes: HashSet::new(),
        index_only_indexers: vec!["redetorrent".to_string()],
        prefer_dubbed: false,
        per_indexer_max: 40,
        global_max: 40,
    }
}

#[test]
fn so_passed_filter_ou_index_only_entra() {
    let mut sources = BTreeMap::new();
    sources.insert("aa".to_string(), vec![source("bludv", true)]);
    sources.insert("bb".to_string(), vec![source("bludv", true)]);
    sources.insert("cc".to_string(), vec![source("redetorrent", true)]);
    let works = vec![
        work("aa", 0, 5, Some(magnet("aa", "Dublado", true, true, 1, 5))),
        work("bb", 1, 6, Some(magnet("bb", "Film", false, false, 9, 6))),
        work(
            "cc",
            0,
            7,
            Some(magnet("cc", "Index only", false, false, 2, 7)),
        ),
    ];
    let out = select_instant(&base(works, sources));
    let hashes: Vec<&str> = out
        .items
        .iter()
        .map(|item| item.info_hash.as_str())
        .collect();
    assert_eq!(
        hashes,
        ["bb", "cc"],
        "0 sem index-only fora; os dois medidos entram"
    );
    assert!(
        out.items[0].fallback_fetchable,
        "passed_filter=1 é baixável"
    );
    assert!(
        out.items[1].fallback_fetchable,
        "index-only é a porta do colhedor"
    );
}

#[test]
fn fonte_fora_da_config_nao_entra() {
    let mut sources = BTreeMap::new();
    sources.insert("aa".to_string(), vec![source("torrentio", false)]);
    let works = vec![work(
        "aa",
        1,
        5,
        Some(magnet("aa", "Film", false, false, 9, 5)),
    )];
    let out = select_instant(&base(works, sources));
    assert!(out.items.is_empty());
}

#[test]
fn prefers_dubbed_antes_do_teto() {
    let mut sources = BTreeMap::new();
    sources.insert("en".to_string(), vec![source("a", true)]);
    sources.insert("br".to_string(), vec![source("b", true)]);
    let works = vec![
        work(
            "en",
            1,
            9,
            Some(magnet(
                "en",
                "Movie 2024 1080p BluRay",
                false,
                false,
                5000,
                9,
            )),
        ),
        work(
            "br",
            1,
            8,
            Some(magnet("br", "Filme Dublado 1080p", true, true, 1, 8)),
        ),
    ];
    let mut input = base(works, sources);
    input.global_max = 1;
    input.prefer_dubbed = true;
    let out = select_instant(&input);
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.items[0].info_hash, "br", "o dublado ocupa a vaga única");
}

#[test]
fn teto_por_indexer() {
    let mut sources = BTreeMap::new();
    let works: Vec<_> = (0..3)
        .map(|i| {
            let hash = format!("h{i}");
            sources.insert(hash.clone(), vec![source("bludv", true)]);
            work(
                &hash,
                1,
                10 + i,
                Some(magnet(&hash, "Dublado", true, true, 5, 10 + i)),
            )
        })
        .collect();
    let mut input = base(works, sources);
    input.per_indexer_max = 2;
    let out = select_instant(&input);
    assert_eq!(out.items.len(), 2);
}

#[test]
fn hash_do_indice_e_excluido() {
    let mut sources = BTreeMap::new();
    sources.insert("aa".to_string(), vec![source("bludv", true)]);
    let works = vec![work(
        "aa",
        1,
        5,
        Some(magnet("aa", "Film", false, false, 9, 5)),
    )];
    let mut input = base(works, sources);
    input.exclude_hashes.insert("aa".to_string());
    let out = select_instant(&input);
    assert!(out.items.is_empty());
    assert_eq!(out.idx_hash_skipped, 1);
}

#[test]
fn linha_medida_vence_no_mesmo_hash() {
    let mut sources = BTreeMap::new();
    sources.insert("aa".to_string(), vec![source("bludv", true)]);
    // A primeira linha (episódio) não passou; a segunda (temporada) passou.
    let works = vec![
        work("aa", 0, 9, Some(magnet("aa", "Pack", true, true, 1, 9))),
        work(
            "aa",
            1,
            5,
            Some(magnet("aa", "Pack repetido", true, true, 1, 5)),
        ),
    ];
    let out = select_instant(&base(works, sources));
    assert_eq!(out.items.len(), 1);
    assert_eq!(out.items[0].title, "Pack", "magnet da primeira linha");
    assert!(
        out.items[0].fallback_fetchable,
        "obra medida libera o download"
    );
}

#[test]
fn lied_e_sem_magnet_ficam_fora() {
    let mut sources = BTreeMap::new();
    sources.insert("aa".to_string(), vec![source("bludv", true)]);
    let mut lied = magnet("aa", "Mentiroso", true, true, 1, 5);
    lied.lied = true;
    let works = vec![work("aa", 1, 5, Some(lied)), work("bb", 1, 5, None)];
    let out = select_instant(&base(works, sources));
    assert!(out.items.is_empty());
}

#[test]
fn rotulo_br_velho_desmentido_por_idioma_estrangeiro() {
    let mut sources = BTreeMap::new();
    sources.insert(
        "aa".to_string(),
        vec![InstantSource {
            indexer: "rutracker".to_string(),
            tracker: String::new(),
            last_seen: 10,
            allowed: true,
        }],
    );
    let works = vec![work(
        "aa",
        1,
        5,
        Some(magnet(
            "aa",
            "Coyote Ugly [2000, USA, Drama] Dub",
            true,
            true,
            1,
            5,
        )),
    )];
    let out = select_instant(&base(works, sources));
    assert!(!out.items[0].is_br, "DUB russo sem sinal PT não é BR");
}

#[test]
fn legenda_pt_mantem_origem_br() {
    let mut sources = BTreeMap::new();
    sources.insert("aa".to_string(), vec![source("bludv", true)]);
    let works = vec![work(
        "aa",
        1,
        5,
        Some(magnet("aa", "Filme [1080p LEGENDADO]", true, false, 1, 5)),
    )];
    let out = select_instant(&base(works, sources));
    assert!(out.items[0].is_br);
}
