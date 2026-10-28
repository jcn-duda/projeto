//! Invariante 6 no `check` da AllDebrid: o hash que o usuário mandou apagar
//! (`adrm:v1`) não pode voltar ao `/magnet/upload` — que, nesta conta, É a
//! consulta de cache. Sem isso o `check` do worker reenchia a conta a cada
//! rodada, mesmo com o `enqueue` já barrando o hash antes dos pools.
//!
//! A prova é a REQUISIÇÃO gravada pelo servidor falso (query do GET, porque o
//! check da AllDebrid não tem corpo), nunca um contador interno: contador diz
//! "não pedi", a query diz "não pedi ESTE hash".
//!
//! Filho de `autofetch_ports_tests`: reaproveita `listen`/`cache_db`/`hits`.

use serde_json::json;

use super::*;
use crate::alldebrid_cleanup::{account_scope, adrm_key};

/// Row `adrm` VIVA (TTL futuro) da conta de `KEY` para `hash`. A chave sai de
/// `adrm_key` — o MESMO formatador que o `enqueue` usa (`adrm_key(account,
/// hash)` → `adrm:v1:<conta>:<hash>` em minúsculas).
fn live_adrm(hash: &str) -> (String, i64) {
    (
        adrm_key(&account_scope(KEY), hash),
        crate::error::now_ms() as i64 + 60_000,
    )
}

/// `cache.db` do Node com as linhas que o teste precisa (quem escreve é o Node).
fn db_with(rows: &[(String, i64)]) -> (tempfile::TempDir, std::path::PathBuf) {
    let (dir, path) = cache_db();
    let conn = rusqlite::Connection::open(&path).unwrap();
    for (key, expires_at) in rows {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params![key, expires_at],
        )
        .unwrap();
    }
    (dir, path)
}

/// Bases legíveis: `cache.db` com a tabela `cache` e sem `adrm` nenhum.
fn db_limpo() -> (tempfile::TempDir, std::path::PathBuf) {
    db_with(&[])
}

/// Queries CRUAS dos `GET /magnet/upload` que chegaram ao servidor falso.
fn uploads(scene: &Scene) -> Vec<String> {
    scene
        .hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.path == "/magnet/upload")
        .map(|hit| hit.query.clone())
        .collect()
}

/// O hash foi pedido ao serviço? Hash é hexa, então não sofre percent-encode e
/// `contains` na query crua é prova direta.
fn asked(queries: &[String], hash: &str) -> bool {
    queries.iter().any(|query| query.contains(hash))
}

fn port(addr: SocketAddr, db_path: Option<std::path::PathBuf>) -> AutofetchPorts {
    AutofetchPorts::alldebrid(
        alldebrid(addr),
        KEY,
        AlldebridFacts {
            db_path,
            ..AlldebridFacts::default()
        },
    )
}

/// `DEBRID_REUPLOAD_BLOCK` trocado sob a trava ÚNICA do crate e restaurado no
/// `Drop` — inclusive em pânico: a env é do processo e vazar `false` faria o
/// filtro dos outros testes parecer quebrado.
struct BlockFlag {
    prev: Option<String>,
    /// Só existe para manter a trava enquanto a flag está trocada.
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl BlockFlag {
    fn set(value: &str) -> Self {
        let lock = crate::test_env::lock();
        let prev = std::env::var("DEBRID_REUPLOAD_BLOCK").ok();
        unsafe {
            std::env::set_var("DEBRID_REUPLOAD_BLOCK", value);
        }
        Self { prev, _lock: lock }
    }
}

impl Drop for BlockFlag {
    fn drop(&mut self) {
        unsafe {
            match self.prev.take() {
                Some(prev) => std::env::set_var("DEBRID_REUPLOAD_BLOCK", prev),
                None => std::env::remove_var("DEBRID_REUPLOAD_BLOCK"),
            }
        }
    }
}

/// O caso que doía: com `adrm` vivo, o `check` NÃO manda o hash ao
/// `/magnet/upload`; o hash livre da MESMA chamada continua sendo consultado.
#[tokio::test]
async fn check_alldebrid_tira_o_adrm_vivo_do_magnet_upload() {
    let (blocked_hash, free_hash) = (hash_of('a'), hash_of('b'));
    let body = envelope(json!({"magnets": [{"id": 1, "hash": free_hash.clone(), "ready": true}]}));
    let (addr, scene) = listen(vec![("GET /magnet/upload", 200, body)], (404, "{}".into())).await;
    let (_dir, db_path) = db_with(&[live_adrm(&blocked_hash)]);
    let port = port(addr, Some(db_path));

    let evidence = port
        .check(&[blocked_hash.clone(), free_hash.clone()])
        .await
        .unwrap();

    let sent = uploads(&scene);
    assert_eq!(sent.len(), 1, "um lote só: {sent:?}");
    assert!(
        asked(&sent, &free_hash),
        "hash sem marca é perguntado: {sent:?}"
    );
    assert!(
        !asked(&sent, &blocked_hash),
        "adrm vivo NÃO pode ir ao /magnet/upload: {sent:?}"
    );
    // O bloqueado também não vira ⚡: não foi perguntado, não está em `cached`.
    assert_eq!(evidence.cached, vec![free_hash]);
    // `known` segue o `complete` do lote (nenhum lote falhou): rebaixá-lo aqui
    // faria o worker recusar a rodada inteira (`unknown-cache`) por causa de um
    // único hash marcado, perdendo o ⚡ dos outros.
    assert!(evidence.known);
}

/// Chave e normalização: `enqueue` e `check` têm de bater na MESMA fixture e na
/// mesma caixa. O `enqueue` já barrava; o `check` tem de barrar com a chave
/// idêntica — ambos com hash em CAIXA ALTA na entrada.
#[tokio::test]
async fn enqueue_e_check_concordam_na_chave_e_na_caixa_do_adrm() {
    let hash = hash_of('c');
    let upper = hash.to_uppercase();
    let (key, expires_at) = live_adrm(&hash);
    // A fixture prova o formato do Node (`adrm:v1:<conta>:<hash>` minúsculo).
    assert_eq!(key, format!("adrm:v1:{}:{}", account_scope(KEY), hash));
    let (_dir, db_path) = db_with(&[(key, expires_at)]);
    // Sem rota: qualquer `/magnet/upload` seria o bloqueado voltando à conta.
    let (addr, scene) = listen(vec![], (404, "{}".into())).await;

    let enq = port(addr, Some(db_path.clone()));
    assert!(
        !enq.enqueue(&candidate(&upper)).await.unwrap().accepted,
        "enqueue: guarda viva recusa o aceite"
    );

    let chk = port(addr, Some(db_path));
    let evidence = chk.check(std::slice::from_ref(&upper)).await.unwrap();
    assert!(evidence.cached.is_empty());
    assert_eq!(
        hits(&scene),
        0,
        "nenhum dos dois lados pode subir o hash marcado ({})",
        upper
    );
}

/// Kill-switch do Node (`enabled()` de `alldebrid-reupload.ts`): as mesmas envs
/// do `.env` único. `DEBRID_REUPLOAD_BLOCK=false` libera o upload — o Rust não
/// pode continuar filtrando depois de um rollback de uma linha.
#[tokio::test]
async fn check_alldebrid_com_kill_switch_desligado_libera_o_upload() {
    let hash = hash_of('d');
    let body = envelope(json!({"magnets": [{"id": 9, "hash": hash.clone(), "ready": true}]}));
    let (addr, scene) = listen(vec![("GET /magnet/upload", 200, body)], (404, "{}".into())).await;
    let (_dir, db_path) = db_with(&[live_adrm(&hash)]);
    let port = port(addr, Some(db_path));
    let _flag = BlockFlag::set("false");

    let evidence = port.check(std::slice::from_ref(&hash)).await.unwrap();

    let sent = uploads(&scene);
    assert!(
        asked(&sent, &hash),
        "kill-switch desligado libera o /magnet/upload: {sent:?}"
    );
    assert_eq!(evidence.cached, vec![hash]);
}

/// Guarda ilegível é fail-CLOSED: sem prova do `adrm` nenhum hash é enviado.
/// `known:false` é a resposta honesta (não sei), nunca "está frio".
#[tokio::test]
async fn check_alldebrid_com_guarda_ilegivel_nao_envia_nada() {
    let hash = hash_of('e');
    // Resposta VÁLIDA no fallback de propósito: com fail-open o upload sairia e
    // a falha do teste seria "o hash subiu", não "a requisição deu erro".
    let (addr, scene) = listen(vec![], (200, envelope(json!({ "magnets": [] })))).await;

    // (a) `cache.db` ausente: a leitura não cria o banco do Node.
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("ausente.db");
    let evidence = port(addr, Some(missing.clone()))
        .check(std::slice::from_ref(&hash))
        .await
        .unwrap();
    assert!(!evidence.known, "sem banco não há prova de cache");
    assert!(evidence.cached.is_empty());
    assert_eq!(hits(&scene), 0, "fail-closed: nenhum upload");
    assert!(!missing.exists(), "a guarda é somente leitura");

    // (b) arquivo existe mas sem a tabela `cache` (banco de outro schema).
    let broken = dir.path().join("outro.db");
    rusqlite::Connection::open(&broken)
        .unwrap()
        .execute_batch("CREATE TABLE outra_coisa (id INTEGER);")
        .unwrap();
    let evidence = port(addr, Some(broken)).check(&[hash]).await.unwrap();
    assert!(!evidence.known, "tabela ilegível não vira 'nada em cache'");
    assert_eq!(hits(&scene), 0, "fail-closed: nenhum upload");

    // (c) sem `db_path` (fatos do chamador incompletos): mesma recusa.
    let evidence = port(addr, None).check(&[hash_of('f')]).await.unwrap();
    assert!(!evidence.known);
    assert_eq!(hits(&scene), 0);
}

/// Contraponto obrigatório: guarda LEGÍVEL e vazia não bloqueia nada — o
/// fail-closed é só para ilegível, senão a conta perderia todo ⚡.
#[tokio::test]
async fn check_alldebrid_com_guarda_limpa_sobe_o_hash() {
    let hash = hash_of('a');
    let body = envelope(json!({"magnets": [{"id": 3, "hash": hash.clone(), "ready": true}]}));
    let (addr, scene) = listen(vec![("GET /magnet/upload", 200, body)], (404, "{}".into())).await;
    let (_dir, db_path) = db_limpo();

    let evidence = port(addr, Some(db_path))
        .check(std::slice::from_ref(&hash))
        .await
        .unwrap();

    let sent = uploads(&scene);
    assert!(asked(&sent, &hash), "hash livre sobe: {sent:?}");
    assert_eq!(evidence.cached, vec![hash]);
    assert!(evidence.known);
}
