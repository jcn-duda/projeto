//! Equivalência do recompute NATIVO com a régua do TS (`src/utils/trace-recompute.ts`,
//! apagado neste corte): moldura `raw:v1`, notas `no-names`/`no-material`,
//! campos do outcome (`basis/built/builtAt/note/items`), sanitização do rótulo,
//! dedupe por hash, teto de 300, estados atuais (`bad/lie/dead/idx-miss`, com e
//! sem conta) e os gates do `recompute_for_hit`. Os testes de ROTA estão em
//! `trace_recompute_route_tests.rs`.

use serde_json::{json, Value};

use adom_autofetch::QueueV3;
use adom_core::WorkTarget;
use adom_index::RecordOptions;

use super::core::{recompute_for_hit, recompute_offline};
use super::raw_key::raw_key_for;
use super::{boot_mem, test_install, TEST_NOW};

#[test]
fn moldura_raw_v1_igual_ao_escritor_legado() {
    let pt_br = vec!["bludv-cardigann".to_string()];
    let bare = vec!["hdrtorrent-cardigann".to_string()];
    let prefix = adom_core::prefix("raw");
    // BR: perde o token de episódio e o acento.
    assert_eq!(
        raw_key_for(&pt_br, &bare, "bludv-cardigann", "Ação S02E05", "series"),
        format!("{prefix}jackett:bludv-cardigann:series:Acao S02")
    );
    // Global (fora das listas): texto simples atravessa intacto.
    assert_eq!(
        raw_key_for(&[], &[], "torrentleech", "Filme 2020", "movie"),
        format!("{prefix}jackett:torrentleech:movie:Filme 2020")
    );
    // Bare title: o ano do fim sai (e o colapso final apara o espaço).
    assert_eq!(
        raw_key_for(&[], &bare, "hdrtorrent-cardigann", "Filme 2020", "movie"),
        format!("{prefix}jackett:hdrtorrent-cardigann:movie:Filme")
    );
    // Guarda do escritor: moldagem que viraria SÓ temporada volta ao original.
    assert_eq!(
        raw_key_for(&pt_br, &bare, "bludv-cardigann", "S02", "series"),
        format!("{prefix}jackett:bludv-cardigann:series:S02")
    );
}

#[test]
fn sem_nomes_e_sem_material_sao_notas_legitimas() {
    let boot = boot_mem();
    let no_names = recompute_offline(
        &boot,
        &test_install(&["bludv-cardigann"], "realdebrid", None),
        "tt777",
        WorkTarget {
            season: None,
            episode: None,
        },
        &["".into()],
        Some(2020.0),
        TEST_NOW,
    );
    assert_eq!(no_names["attempted"], true);
    assert_eq!(no_names["built"], false);
    assert_eq!(no_names["note"], "no-names");
    assert_eq!(no_names["basis"], json!([]));

    // Nomes ok, mas idx/raw vazios: no-material com basis vazio.
    let no_material = recompute_offline(
        &boot,
        &test_install(&["bludv-cardigann"], "realdebrid", None),
        "tt777",
        WorkTarget {
            season: None,
            episode: None,
        },
        &["Filme".into()],
        Some(2020.0),
        TEST_NOW,
    );
    assert_eq!(no_material["attempted"], true);
    assert_eq!(no_material["built"], false);
    assert_eq!(no_material["note"], "no-material");
    assert_eq!(no_material["basis"], json!([]));
}

#[test]
fn raw_quente_reproduz_os_campos_da_regua_ts() {
    let boot = boot_mem();
    let key = raw_key_for(
        &boot.pt_br_indexers,
        &boot.bare_title_indexers,
        "torrentleech",
        "Filme 2020",
        "movie",
    );
    boot.raw
        .set_raw(
            &key,
            &json!({ "items": [
                {
                    "title": "0123456789abcdef0123456789abcdef01234567 Filme.Teste magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff&dn=x",
                    "infoHash": "1111111111111111111111111111111111111111",
                    "seeders": 9, "indexer": "TorrentLeech", "size": 123,
                    "_br": true, "_dubbed": false, "_quality": "1080p",
                },
                {
                    "title": "Outro 1080p",
                    "infoHash": "2222222222222222222222222222222222222222",
                    "seeders": 3, "indexer": "TL", "_br": false,
                },
                // Hash repetido (case diferente): fora.
                { "title": "Duplicado", "infoHash": "1111111111111111111111111111111111111111" },
                // Sem hash: fora.
                { "title": "Sem hash" },
            ]}),
            3600,
            TEST_NOW,
        )
        .unwrap();

    let outcome = recompute_offline(
        &boot,
        &test_install(&["torrentleech"], "realdebrid", None),
        "tt777",
        WorkTarget {
            season: None,
            episode: None,
        },
        &["Filme".into()],
        Some(2020.0),
        TEST_NOW,
    );
    assert_eq!(outcome["attempted"], true);
    assert_eq!(outcome["built"], true);
    assert_eq!(outcome["note"], Value::Null);
    assert_eq!(outcome["builtAt"], TEST_NOW);
    assert_eq!(outcome["basis"], json!(["raw"]));
    let items = outcome["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "dedupe por hash (case-insensitive)");
    assert_eq!(items[0]["id"], "r1");
    assert_eq!(items[1]["id"], "r2");
    assert_eq!(items[0]["br"], true);
    assert_eq!(
        items[0]["dubbed"], false,
        "_dubbed presente (false) ⇒ campo sai"
    );
    assert_eq!(items[0]["quality"], "1080p");
    assert_eq!(items[1]["br"], false);
    assert!(items[1].get("dubbed").is_none(), "sem _dubbed ⇒ sem campo");
    assert!(items[1].get("quality").is_none());
    // Rótulo pela porta única: hash → `<hash>`, magnet → `<magnet>`; e o hash
    // CRU não sai em NENHUM campo do outcome.
    let label = items[0]["label"].as_str().unwrap();
    assert!(label.contains("<hash>"), "{label}");
    assert!(label.contains("<magnet>"), "{label}");
    assert!(!outcome.to_string().contains("btih"), "{outcome}");
    assert!(
        !outcome.to_string().contains("0123456789abcdef"),
        "{outcome}"
    );
    // Sem conta ⇒ leituras de estado nem rodam: `tocável`.
    assert_eq!(items[0]["now"]["state"], "tocável");
    assert_eq!(items[1]["now"]["state"], "tocável");
}

#[test]
fn estados_atuais_somam_com_conta_e_ficam_tocaveis_sem() {
    let boot = boot_mem();
    let api_key = "chave-de-teste-do-estado";
    let location = WorkTarget {
        season: Some(1),
        episode: Some(2),
    };
    let h1 = "1111111111111111111111111111111111111111";
    let h2 = "2222222222222222222222222222222222222222";
    // H3 só existe no raw: prova o `raw` no basis (hash que o idx não cobre).
    let h3 = "3333333333333333333333333333333333333333";
    // Índice quente com os DOIS hashes e H2 provado ausente no episódio.
    boot.idx
        .record(
            "tt777",
            location,
            &[
                json!({ "title": "H1", "infoHash": h1, "seeders": 5, "indexer": "x" }),
                json!({ "title": "H2", "infoHash": h2, "seeders": 4, "indexer": "x" }),
            ],
            RecordOptions {
                partial: false,
                keep_partial: false,
                source: None,
                supplemental: false,
            },
            3600,
            60,
            TEST_NOW,
            None,
        )
        .unwrap();
    boot.idx
        .mark_missing("tt777", location, h2, TEST_NOW)
        .unwrap();
    // Conta da instalação: H1 está bad+lie+dead.
    boot.mag
        .mark_bad("realdebrid", api_key, h1, 3600, TEST_NOW)
        .unwrap();
    boot.mag
        .mark_lie("realdebrid", api_key, h1, 3600, TEST_NOW)
        .unwrap();
    QueueV3::new(&boot.kv)
        .mark_dead(
            "realdebrid",
            &adom_core::account_scope(&json!(api_key)),
            h1,
            3600,
            TEST_NOW,
        )
        .unwrap();
    // Matéria via raw quente: H1/H2 repetem o idx (SÃO do idx na ordem da
    // régua do TS — seen antes do basis) e H3 é exclusivo do raw.
    let key = raw_key_for(
        &boot.pt_br_indexers,
        &boot.bare_title_indexers,
        "bludv-cardigann",
        "Serie",
        "series",
    );
    boot.raw
        .set_raw(
            &key,
            &json!({ "items": [
                { "title": "H1", "infoHash": h1, "seeders": 5, "indexer": "bludv" },
                { "title": "H2", "infoHash": h2, "seeders": 4, "indexer": "bludv" },
                { "title": "H3", "infoHash": h3, "seeders": 2, "indexer": "bludv" },
            ]}),
            3600,
            TEST_NOW,
        )
        .unwrap();

    let com_conta = recompute_offline(
        &boot,
        &test_install(&["bludv-cardigann"], "realdebrid", Some(api_key)),
        "tt777",
        location,
        &["Serie".into()],
        None,
        TEST_NOW,
    );
    assert_eq!(com_conta["basis"], json!(["idx", "raw"]));
    let items = com_conta["items"].as_array().unwrap();
    // Leituras INDEPENDENTES (bad e lie coexistem), na ordem bad/lie/dead/idx-miss.
    assert_eq!(items[0]["now"]["state"], "bad+lie+dead", "{}", items[0]);
    assert_eq!(items[1]["now"]["state"], "idx-miss", "{}", items[1]);
    assert_eq!(items[2]["now"]["state"], "tocável", "{}", items[2]);

    // A MESMA matéria SEM conta: nenhum estado de conta é consultado.
    let sem_conta = recompute_offline(
        &boot,
        &test_install(&["bludv-cardigann"], "realdebrid", None),
        "tt777",
        location,
        &["Serie".into()],
        None,
        TEST_NOW,
    );
    for item in sem_conta["items"].as_array().unwrap() {
        assert_eq!(item["now"]["state"], "tocável", "{}", item);
    }
}

#[test]
fn teto_de_itens_e_300() {
    let boot = boot_mem();
    let items: Vec<Value> = (0..310)
        .map(|i| {
            json!({
                "title": format!("Item {i}"),
                "infoHash": format!("{:040x}", i + 1),
                "seeders": 1,
                "indexer": "x",
            })
        })
        .collect();
    let key = raw_key_for(
        &boot.pt_br_indexers,
        &boot.bare_title_indexers,
        "torrentleech",
        "Filme",
        "movie",
    );
    boot.raw
        .set_raw(&key, &json!({ "items": items }), 3600, TEST_NOW)
        .unwrap();
    let outcome = recompute_offline(
        &boot,
        &test_install(&["torrentleech"], "realdebrid", None),
        "tt777",
        WorkTarget {
            season: None,
            episode: None,
        },
        &["Filme".into()],
        None,
        TEST_NOW,
    );
    let items = outcome["items"].as_array().unwrap();
    assert_eq!(items.len(), 300, "RECOMPUTE_MAX_ITEMS");
    assert_eq!(items[0]["id"], "r1");
    assert_eq!(items[299]["id"], "r300");
}

#[test]
fn recompute_for_hit_silencia_quando_nao_pode_ser_honesto() {
    let _guard = super::BOOT_TEST_LOCK.lock().unwrap();
    super::install_for_tests(Some(boot_mem()));
    let api_key = "chave-do-gate";
    let scope = adom_core::account_scope(&json!(api_key));
    let shape = json!({ "debridService": "RealDebrid", "jackettIndexers": ["bludv-cardigann"] });
    let key_ok = format!(
        "{}movie:tt777:{shape}:account:{scope}",
        adom_store::streams_prefix()
    );
    let meta = json!({ "names": ["Filme"], "year": 2020 });
    let hit = |key: &str, trace: Option<Value>, meta: Option<Value>| adom_store::TraceHit {
        value: adom_search::StreamsEntry {
            trace,
            search_meta: meta,
            ..Default::default()
        },
        stale: false,
        remaining_s: 100,
        key: key.to_string(),
    };
    // Ledger presente ⇒ null (o ledger é a verdade da build).
    assert_eq!(
        recompute_for_hit(
            &hit(&key_ok, Some(json!({ "x": 1 })), Some(meta.clone())),
            "movie",
            "tt777",
            TEST_NOW as u64,
        ),
        Value::Null
    );
    // Sem searchMeta ⇒ null (nada para procurar).
    assert_eq!(
        recompute_for_hit(&hit(&key_ok, None, None), "movie", "tt777", TEST_NOW as u64),
        Value::Null
    );
    // Instalação ilegível na chave: sem sufixo `:account:`, scope inválido e
    // shape quebrado ⇒ null (sem inventar conta).
    for key in [
        format!("{}movie:tt777:{shape}", adom_store::streams_prefix()),
        format!(
            "{}movie:tt777:{shape}:account:nao-hex",
            adom_store::streams_prefix()
        ),
        format!(
            "{}movie:tt777:{{quebrado:account:{scope}",
            adom_store::streams_prefix()
        ),
    ] {
        assert_eq!(
            recompute_for_hit(
                &hit(&key, None, Some(meta.clone())),
                "movie",
                "tt777",
                TEST_NOW as u64,
            ),
            Value::Null,
            "{key}"
        );
    }
    // Instalação legível com matéria ausente: outcome LEGÍTIMO (no-material).
    let outcome = recompute_for_hit(
        &hit(&key_ok, None, Some(meta)),
        "movie",
        "tt777",
        TEST_NOW as u64,
    );
    assert_eq!(outcome["attempted"], true);
    assert_eq!(outcome["note"], "no-material");
    super::install_for_tests(None);
}
