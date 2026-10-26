//! Provas do `davail_state`: TTL 0 DESLIGA a janela (nada grava), hash vazio
//! não é chave, negativo vence cedo e sai do lote, conta diferente não enxerga o
//! cache da outra e o valor legado do Node (`true`/`false` cru) continua legível.

use adom_core::{account_scope, prefix};
use rusqlite::params;
use serde_json::Value;

use super::{davail_key, key_head, DavailAnswer, DavailStore};

fn store() -> DavailStore {
    DavailStore::open_memory().expect("store em memória")
}

fn veredito(lote: &[DavailAnswer], hash: &str) -> Option<bool> {
    lote.iter()
        .find(|item| item.hash == hash)
        .map(|item| item.cached)
}

#[test]
fn davail_ttl_zero_nao_grava() {
    let store = store();
    store
        .put("premiumize", "k1", "aaaa", true, 0, 1_000)
        .expect("put com a janela desligada");
    assert_eq!(
        store.get("premiumize", "k1", "aaaa", 2_000).expect("get"),
        None,
        "ttl 0 desliga a janela: nada é gravado"
    );

    store
        .put_many(
            "premiumize",
            "k1",
            &[
                ("bbbb".to_string(), true, 0),
                ("cccc".to_string(), false, 600),
            ],
            1_000,
        )
        .expect("lote");
    assert_eq!(
        store
            .get_many(
                "premiumize",
                "k1",
                &["bbbb".to_string(), "cccc".to_string()],
                2_000,
            )
            .expect("lote"),
        vec![DavailAnswer {
            hash: "cccc".to_string(),
            cached: false,
        }],
        "a entrada desligada não impede a outra de gravar"
    );
    assert_eq!(
        store.get("premiumize", "k1", "bbbb", 2_000).expect("get"),
        None,
        "nem a curta do lote ficou para trás"
    );
}

#[test]
fn davail_hash_vazio_nao_grava_nem_le() {
    let dir = tempfile::tempdir().expect("pasta temporária");
    let path = dir.path().join("cache.db");
    let store = DavailStore::open(&path).expect("store em arquivo");

    store
        .put("premiumize", "k1", "", true, 600, 1_000)
        .expect("hash vazio não grava");
    store
        .put_many("premiumize", "k1", &[(String::new(), true, 600)], 1_000)
        .expect("lote com hash vazio");

    assert_eq!(
        store.get("premiumize", "k1", "", 2_000).expect("get vazio"),
        None,
        "hash vazio não tem veredito"
    );
    assert!(
        store
            .get_many("premiumize", "k1", &[String::new()], 2_000)
            .expect("lote vazio")
            .is_empty(),
        "hash vazio não aparece no lote"
    );
    // Prova física: sem a recusa, o `put` gravaria a CABEÇA da chave (prefixo
    // sem hash), linha que nenhuma leitura de hash real encontraria.
    let raw = rusqlite::Connection::open(&path).expect("conexão crua");
    let linhas: i64 = raw
        .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
        .expect("contagem de linhas");
    assert_eq!(linhas, 0, "nenhuma linha nasceu");
    drop(raw);
    assert_eq!(
        store
            .get("premiumize", "k1", "aaaa", 2_000)
            .expect("get real"),
        None,
        "hash real segue desconhecido"
    );
}

#[test]
fn conta_diferente_nao_ve_o_cache_da_outra() {
    let store = store();
    store
        .put("premiumize", "k1", "aaaa", true, 600, 1_000)
        .expect("put da conta 1");

    assert_eq!(
        store
            .get("premiumize", "k2", "aaaa", 2_000)
            .expect("get k2"),
        None,
        "⚡ de uma conta não vaza para a outra"
    );
    assert_eq!(
        store
            .get("premiumize", "k1", "aaaa", 2_000)
            .expect("get k1"),
        Some(true),
        "a dona do veredito continua vendo"
    );
}

#[test]
fn negativo_expira_e_sai_do_lote() {
    let store = store();
    store
        .put("alldebrid", "k1", "cccc", false, 60, 1_000)
        .expect("put negativo de 60s");

    assert_eq!(
        store.get("alldebrid", "k1", "cccc", 60_999).expect("get"),
        Some(false),
        "dentro da janela o negativo responde"
    );
    assert_eq!(
        store.get("alldebrid", "k1", "cccc", 61_000).expect("get"),
        None,
        "vencido na leitura"
    );
    assert!(
        store
            .get_many("alldebrid", "k1", &["cccc".to_string()], 61_000)
            .expect("lote")
            .is_empty(),
        "negativo vencido não volta no lote"
    );
    // A linha foi APAGADA na leitura: nem com o relógio recuado ela reaparece.
    assert_eq!(
        store.get("alldebrid", "k1", "cccc", 2_000).expect("get"),
        None
    );
}

#[test]
fn put_many_grava_ttl_por_entrada() {
    let store = store();
    store
        .put_many(
            "torbox",
            "k1",
            &[
                ("aaaa".to_string(), true, 60),
                ("bbbb".to_string(), true, 3_600),
            ],
            1_000,
        )
        .expect("lote");

    let lote = store
        .get_many(
            "torbox",
            "k1",
            &["aaaa".to_string(), "bbbb".to_string()],
            61_000,
        )
        .expect("lote depois do curto");
    assert_eq!(
        lote,
        vec![DavailAnswer {
            hash: "bbbb".to_string(),
            cached: true,
        }],
        "a entrada de TTL curto vence sem derrubar a longa"
    );
    assert_eq!(
        store.get("torbox", "k1", "aaaa", 2_000).expect("get"),
        None,
        "o curto foi apagado do banco na leitura"
    );
}

#[test]
fn hash_e_normalizado_na_chave() {
    let store = store();
    store
        .put("premiumize", "k1", "AAAA", true, 600, 1_000)
        .expect("put em maiúsculas");
    assert_eq!(
        store.get("premiumize", "k1", "aaaa", 2_000).expect("get"),
        Some(true),
        "a chave é sempre minúscula"
    );

    let chave = davail_key("premiumize", "k1", "AAAA");
    assert!(chave.starts_with(prefix("davail")), "{chave}");
    assert!(chave.ends_with(":aaaa"), "{chave}");
    let esperada = format!(
        "{}premiumize:{}:aaaa",
        prefix("davail"),
        account_scope(&Value::String("k1".to_string()))
    );
    assert_eq!(chave, esperada, "mesma forma do davailKey do Node");
    // O prefixo do lote é o MESMO do `davail_key`: divergência entre eles faria
    // o `put_many` gravar onde o `get` não lê.
    let head = key_head("premiumize", "k1").expect("cabeça da chave");
    assert_eq!(format!("{head}aaaa"), chave);
    assert_ne!(
        chave,
        davail_key("premiumize", "k2", "AAAA"),
        "a conta faz parte da chave"
    );
}

#[test]
fn le_valor_legado_booleano() {
    let dir = tempfile::tempdir().expect("pasta temporária");
    let path = dir.path().join("data").join("cache.db");
    let store = DavailStore::open(&path).expect("abre criando a pasta pai");

    // Escrita CRUA pelo mesmo arquivo, como um valor legado deixado pelo Node.
    let raw = rusqlite::Connection::open(&path).expect("conexão crua");
    for (hash, value) in [
        ("aaaa", "true"),
        ("bbbb", "false"),
        ("cccc", "1"),
        ("dddd", "0"),
        ("eeee", "lixo"),
    ] {
        raw.execute(
            "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?1, ?2, 0)",
            params![davail_key("premiumize", "k1", hash), value],
        )
        .expect("insere legado");
    }
    drop(raw);

    assert_eq!(
        store.get("premiumize", "k1", "aaaa", 2_000).expect("get"),
        Some(true),
        "`true` cru é positivo"
    );
    assert_eq!(
        store.get("premiumize", "k1", "bbbb", 2_000).expect("get"),
        Some(false),
        "`false` cru é negativo"
    );
    assert_eq!(
        store.get("premiumize", "k1", "cccc", 2_000).expect("get"),
        Some(true),
        "`1` cru é positivo"
    );
    assert_eq!(
        store.get("premiumize", "k1", "dddd", 2_000).expect("get"),
        Some(false),
        "`0` cru é negativo"
    );
    assert_eq!(
        store.get("premiumize", "k1", "eeee", 2_000).expect("get"),
        None,
        "valor ilegível é ausência, nunca ⚡ adivinhado"
    );
}

#[test]
fn escopo_vazio_nao_grava_nem_le() {
    let store = store();
    store
        .put("", "k1", "aaaa", true, 600, 1_000)
        .expect("sem adapter é no-op");
    store
        .put("premiumize", "", "aaaa", true, 600, 1_000)
        .expect("sem chave é no-op");
    store
        .put_many("", "k1", &[("aaaa".to_string(), true, 600)], 1_000)
        .expect("lote sem adapter é no-op");

    assert_eq!(store.get("", "k1", "aaaa", 2_000).expect("get"), None);
    assert_eq!(
        store.get("premiumize", "", "aaaa", 2_000).expect("get"),
        None
    );
    assert!(
        store
            .get_many("premiumize", "k1", &["aaaa".to_string()], 2_000)
            .expect("lote")
            .is_empty(),
        "nada foi gravado"
    );
}

#[test]
fn lote_tem_teto_de_hashes_por_chamada() {
    let store = store();
    let hashes: Vec<String> = (0..205).map(|i| format!("{i:04x}")).collect();
    let entries: Vec<(String, bool, i64)> = hashes
        .iter()
        .map(|hash| (hash.clone(), true, 600))
        .collect();
    store
        .put_many("premiumize", "k1", &entries, 1_000)
        .expect("lote");

    // Hash vazio no meio do pedido NÃO consome vaga do teto: se consumisse, o
    // último hash do recorte ("00c7") ficaria de fora.
    let mut pedido = hashes[..200].to_vec();
    pedido.insert(100, String::new());
    let lote = store
        .get_many("premiumize", "k1", &pedido, 2_000)
        .expect("lote");
    assert_eq!(lote.len(), 200, "teto por chamada, sem paginação");
    assert_eq!(
        veredito(&lote, "0000"),
        Some(true),
        "a ordem da entrada vale"
    );
    assert_eq!(
        veredito(&lote, "00c7"),
        Some(true),
        "o hash vazio não encurtou o recorte"
    );
}
