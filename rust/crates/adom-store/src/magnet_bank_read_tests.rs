//! Testes da leitura do painel (`bank_status`/`bank_search`): banco em memória
//! com o schema real e fixtures por SQL direto, como nos irmãos.

use serde_json::{json, Value};

use crate::magnet_bank::MagnetBankStore;

fn hash(c: char) -> String {
    c.to_string().repeat(40)
}

/// Magnet mínimo para as buscas (título e last_seen variam).
fn insert_magnet(store: &MagnetBankStore, h: &str, title: &str, last_seen: i64) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet (hash, uri, title, size, is_br, dubbed, quality, \
         seeders_max, seeders_last, first_seen, last_seen, lied) VALUES \
         ('{h}', 'magnet:?xt=urn:btih:{h}&dn=T', '{title}', 123, 1, 0, '1080p', 10, 3, 100, {last_seen}, 0)"
    ));
}

fn insert_source(store: &MagnetBankStore, h: &str, indexer: &str, last_seen: i64) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet_source (hash, indexer, tracker, first_seen, last_seen, seeders_last) \
         VALUES ('{h}', '{indexer}', 'tracker.example', 100, {last_seen}, 3)"
    ));
}

fn insert_work(store: &MagnetBankStore, h: &str, imdb: &str, passed: i64, last_seen: i64) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter) \
         VALUES ('{h}', '{imdb}', -1, -1, 100, {last_seen}, {passed})"
    ));
}

#[test]
fn status_banco_vazio_e_zero() {
    let store = MagnetBankStore::open_memory().unwrap();
    let status = store.bank_status(1_000_000, true).unwrap();
    assert_eq!(status["enabled"], json!(true));
    assert_eq!(status["engine"], "sql");
    assert_eq!(status["magnets"], 0);
    assert_eq!(status["sources"], 0);
    assert_eq!(status["works"], 0);
    assert_eq!(status["lastSeen"], 0);
    assert_eq!(status["byIndexer"], json!([]));
    assert!(status["memoryMax"].is_null());
    assert_eq!(status["memoryEvictions"], 0);
    assert_eq!(status["queue"], 0);
    assert_eq!(status["queueMax"], 500);
}

#[test]
fn status_com_linhas_agrega_totais_indexer_e_ultimo_visto() {
    let store = MagnetBankStore::open_memory().unwrap();
    let (a, b, c) = (hash('a'), hash('b'), hash('c'));
    insert_magnet(&store, &a, "Filme A", 2500);
    insert_magnet(&store, &b, "Filme B", 1000);
    insert_magnet(&store, &c, "Filme C", 5000);
    // bludv viu A e B; redetorrent só A; apache EMPATA com bludv no last_seen.
    insert_source(&store, &a, "bludv", 2200);
    insert_source(&store, &b, "bludv", 1000);
    insert_source(&store, &a, "redetorrent", 3000);
    insert_source(&store, &c, "apache", 2200);
    insert_work(&store, &a, "tt0000001", 1, 2500);
    insert_work(&store, &b, "tt0000001", 0, 1000);

    let status = store.bank_status(1_000_000, true).unwrap();
    assert_eq!(status["magnets"], 3);
    assert_eq!(status["sources"], 4);
    assert_eq!(status["works"], 2);
    // MAX das DUAS tabelas: o 5000 do magnet C vence o 3000 das fontes.
    assert_eq!(status["lastSeen"], 5000);
    // Ordem do TS: last_seen DESC, indexer ASC (empate: apache antes de bludv).
    let rows: Vec<(&str, i64, i64, i64)> = status["byIndexer"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["indexer"].as_str().unwrap(),
                r["hashes"].as_i64().unwrap(),
                r["sources"].as_i64().unwrap(),
                r["lastSeen"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            ("redetorrent", 1, 1, 3000),
            ("apache", 1, 1, 2200),
            ("bludv", 2, 2, 2200)
        ]
    );
}

#[test]
fn kill_switch_responde_formato_desligado_sem_ler_o_banco() {
    let store = MagnetBankStore::open_memory().unwrap();
    // Com linhas no banco: o formato desligado IGNORA o conteúdo (no TS o
    // banco nem abre com MAGNET_BANK=false).
    insert_magnet(&store, &hash('a'), "Filme A", 2500);
    let status = store.bank_status(1_000_000, false).unwrap();
    assert_eq!(
        status,
        json!({
            "enabled": false, "engine": "disabled",
            "magnets": 0, "sources": 0, "works": 0, "lastSeen": 0,
            "byIndexer": [], "memoryMax": null, "memoryEvictions": 0,
            "queue": 0, "queueMax": 500,
        })
    );
}

#[test]
fn busca_por_hash_e_case_insensitive_e_normalizada() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('a'); // minúsculo no banco
    insert_magnet(&store, &h, "Filme A", 2500);
    insert_source(&store, &h, "bludv", 2200);
    insert_work(&store, &h, "tt0000001", 1, 2500);

    // MAIÚSCULAS + espaços: trim e toLowerCase do modo hash; limit 0 → default.
    let result = store
        .bank_search(&format!("  {}  ", h.to_uppercase()), 0)
        .unwrap();
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["mode"], "hash");
    assert_eq!(
        result["query"], h,
        "query sai normalizada (trim + minúsculas)"
    );
    assert_eq!(result["limit"], 50, "limit <= 0 cai no default do TS");
    assert_eq!(result["returned"], 1);
    assert_eq!(result["matched"], 1);
    assert_eq!(result["truncated"], json!(false));

    let item = &result["items"][0];
    assert_eq!(item["hash"], h);
    assert_eq!(item["uri"], format!("magnet:?xt=urn:btih:{h}&dn=T"));
    assert_eq!(item["title"], "Filme A");
    assert_eq!(item["size"], 123);
    assert_eq!(item["isBr"], json!(true));
    assert_eq!(item["dubbed"], json!(false));
    assert_eq!(item["quality"], "1080p");
    assert_eq!(item["seedersMax"], 10);
    assert_eq!(item["seedersLast"], 3);
    assert_eq!(item["firstSeen"], 100);
    assert_eq!(item["lastSeen"], 2500);
    assert_eq!(item["lied"], json!(false));
    // Fonte/obra projetadas SEM o hash; passed_filter vira booleano e -1 fica.
    assert_eq!(
        item["sources"],
        json!([{ "indexer": "bludv", "tracker": "tracker.example", "firstSeen": 100,
                "lastSeen": 2200, "seedersLast": 3 }])
    );
    assert_eq!(
        item["works"],
        json!([{ "imdb": "tt0000001", "season": -1, "episode": -1, "firstSeen": 100,
                "lastSeen": 2500, "passedFilter": true }])
    );
}

#[test]
fn busca_por_hash_inexistente_volta_vazia() {
    let store = MagnetBankStore::open_memory().unwrap();
    let result = store.bank_search(&hash('9'), 10).unwrap();
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["mode"], "hash");
    assert_eq!(result["matched"], 0);
    assert_eq!(result["returned"], 0);
    assert_eq!(result["items"], json!([]));
}

#[test]
fn busca_por_titulo_casa_variante_de_caixa_e_respeita_escape() {
    let store = MagnetBankStore::open_memory().unwrap();
    insert_magnet(&store, &hash('a'), "anime épico dublado", 3000);
    insert_magnet(&store, &hash('b'), "X_Y Zeta", 2500);
    insert_magnet(&store, &hash('c'), "X-Y Zeta", 2400);
    insert_magnet(&store, &hash('d'), "Rota 50% Dupla", 2000);
    insert_magnet(&store, &hash('e'), "5000 Dias", 1000);
    insert_magnet(&store, &hash('f'), "A TORTA ÉPICA", 900);

    let titles = |result: &Value| -> Vec<String> {
        result["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["title"].as_str().unwrap().to_string())
            .collect()
    };

    // Variante LOWER com acento: a query em MAIÚSCULAS acha o título minúsculo
    // — o casefold ASCII do LIKE NÃO fecharia é/É sozinho (palavras distintas
    // para as variantes não se cruzarem entre os títulos).
    let result = store.bank_search("ÉPICO", 10).unwrap();
    assert_eq!(titles(&result), vec!["anime épico dublado"]);
    // Variante UPPER com acento: a query minúscula acha o título em maiúsculas.
    let result = store.bank_search("épica", 10).unwrap();
    assert_eq!(titles(&result), vec!["A TORTA ÉPICA"]);

    // Escape de `_`: sem ele, "x_y" casaria também "X-Y Zeta" (coringa).
    let result = store.bank_search("x_y", 10).unwrap();
    assert_eq!(titles(&result), vec!["X_Y Zeta"]);
    // Escape de `%`: sem ele, "50% D" casaria também "5000 Dias".
    let result = store.bank_search("50% D", 10).unwrap();
    assert_eq!(titles(&result), vec!["Rota 50% Dupla"]);

    // Dois casados com limit 1: janela corta, matched vira null.
    let result = store.bank_search("zeta", 1).unwrap();
    assert_eq!(result["mode"], "title");
    assert_eq!(result["returned"], 1);
    assert!(result["matched"].is_null());
    assert_eq!(result["truncated"], json!(true));
    assert_eq!(titles(&result), vec!["X_Y Zeta"], "last_seen DESC");
}

#[test]
fn busca_recente_ordenada_com_clamp_e_truncamento() {
    let store = MagnetBankStore::open_memory().unwrap();
    insert_magnet(&store, &hash('a'), "Recente 1", 3000);
    insert_magnet(&store, &hash('b'), "Recente 2", 2000);
    insert_magnet(&store, &hash('c'), "Recente 3", 1000);

    // Query vazia = modo recentes, last_seen DESC; limit 2 corta a janela.
    let result = store.bank_search("", 2).unwrap();
    assert_eq!(result["mode"], "recent");
    assert_eq!(result["limit"], 2);
    assert_eq!(result["returned"], 2);
    assert!(
        result["matched"].is_null(),
        "truncado: total exato desconhecido"
    );
    assert_eq!(result["truncated"], json!(true));
    let titles: Vec<&str> = result["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, vec!["Recente 1", "Recente 2"]);

    // Clamp do limit: <= 0 cai no default 50; acima do teto, 100.
    assert_eq!(store.bank_search("", 0).unwrap()["limit"], 50);
    assert_eq!(store.bank_search("", -7).unwrap()["limit"], 50);
    assert_eq!(store.bank_search("", 500).unwrap()["limit"], 100);
    // Com folga, a janela contém todos: matched exato e sem truncamento.
    let result = store.bank_search("", 50).unwrap();
    assert_eq!(result["matched"], 3);
    assert_eq!(result["truncated"], json!(false));
}

#[test]
fn busca_recusa_query_curta_e_longa() {
    let store = MagnetBankStore::open_memory().unwrap();
    // 1 caractere não é hash nem título (mínimo de 2).
    let curta = store.bank_search("a", 10).unwrap();
    assert_eq!(curta["ok"], json!(false));
    assert_eq!(
        curta["error"],
        "informe ao menos 2 caracteres para buscar por título"
    );
    // Acima do teto de 120 caracteres.
    let longa = store.bank_search(&"x".repeat(121), 10).unwrap();
    assert_eq!(longa["ok"], json!(false));
    assert_eq!(longa["error"], "consulta acima de 120 caracteres");
    // No teto exato é uma busca por título válida (vazia, mas válida).
    let ok = store.bank_search(&"x".repeat(120), 10).unwrap();
    assert_eq!(ok["ok"], json!(true));
    assert_eq!(ok["mode"], "title");
    assert_eq!(ok["matched"], 0);
}
