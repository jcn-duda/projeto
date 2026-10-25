//! Marcas da limpeza NATIVA devolvidas ao Node (`/internal/debrid/marked`).
//!
//! O Rust sobe (`/magnet/upload` da checagem) e apaga (fila com backoff) pela
//! conta; o `cache.db` é do Node. Aqui se prova o que sai pelo canal: `submitted`
//! só com a prova de criação do lote, `removed` só com o id CONFIRMADO pelo
//! `DeleteReport` (com o nome da release) e NADA com a limpeza OFF.
//!
//! Módulo filho de `alldebrid_cleanup_tests`: reaproveita o servidor falso da
//! AllDebrid (`scene`/`respond`/`DeleteMode`) e o `EnvGuard` de lá.

use super::*;

use crate::marks_feed::test_support::{listen as marks_listen, wait_until, MarksSeen};

/// Hash com primeiro char fora dos 'a'..'f' das outras suítes: os testes rodam
/// em paralelo e as envs internas são globais.
const HASH_CHAR: char = 'k';

/// Cliente da AllDebrid contra o dublê, com as envs internas apontadas para o
/// dublê de marcas. O guard mantém tudo vivo (e serializa) até o fim do teste.
async fn armed(seen: &Arc<MarksSeen>, cleanup: &str) -> (AllDebrid, EnvGuard) {
    let marks = marks_listen(seen.clone()).await;
    let api_scene = scene(&HASH_CHAR.to_string(), &[], DeleteMode::Ok);
    let addr = listen(api_scene).await;
    let base = format!("http://{addr}");
    let env = EnvGuard::set(&[
        ("DEBRID_AL_CLEANUP", cleanup),
        ("DEBRID_INTERNAL_TOKEN", MARKS_TOKEN),
        ("INTERNAL_CHECK_URL", marks.as_str()),
        ("ALLDEBRID_API_BASE", base.as_str()),
    ]);
    (AllDebrid::new(HttpClient::new().unwrap()), env)
}

/// `submitted` é lista de strings; `removed` é lista de `{ hash, name? }`.
fn contains(body: &Value, list: &str, hash: &str) -> bool {
    body[list].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item.as_str() == Some(hash) || item["hash"] == json!(hash))
    })
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn upload_aceito_devolve_posse_ao_node() {
    let seen = Arc::new(MarksSeen::default());
    let (ad, _env) = armed(&seen, "on").await;
    let hash = hash_of(HASH_CHAR);
    // `drop_ready: false` mantém o lote sem alvo de delete: só a posse viaja.
    let report = ad
        .check_cached(
            KEY,
            std::slice::from_ref(&hash),
            &opts(false, true, Some(&[]), &[], true, None),
        )
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash.clone()]);
    let body = wait_until(&seen, |body| contains(body, "submitted", &hash))
        .await
        .expect("a posse do upload precisa chegar ao Node");
    assert_eq!(body["service"], json!("alldebrid"));
    assert_eq!(body["apiKey"], json!(KEY));
    assert!(body.get("removed").is_none(), "não existe canal de remoção");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn limpeza_de_higiene_nao_devolve_adrm() {
    let seen = Arc::new(MarksSeen::default());
    let (ad, _env) = armed(&seen, "on").await;
    let hash = hash_of(HASH_CHAR);
    let report = ad
        .check_cached(
            KEY,
            std::slice::from_ref(&hash),
            &opts(true, false, Some(&[]), &[], true, None),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano com a flag ON");
    assert_eq!(plan.ready.len(), 1);
    assert_eq!(
        plan.ready[0].name.as_deref(),
        Some(UPLOAD_NAME),
        "o nome vem do /magnet/upload e segue com o alvo"
    );
    let deleted = plan
        .run_with(
            &ad,
            KEY,
            DeleteConfig {
                kill: Some(false),
                ..DeleteConfig::fast()
            },
        )
        .await
        .expect("fila rodou");
    assert_eq!(deleted.removed, vec![id_of(&hash)]);
    // Higiene da checagem NÃO vira `adrm`: o hash não foi condenado, só não
    // estava em cache. Marcá-lo bloqueava o Chupim por 3 dias.
    assert!(
        wait_until(&seen, |body| contains(body, "removed", &hash))
            .await
            .is_none(),
        "limpeza de higiene não pode ser devolvida como remoção intencional"
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn cleanup_off_nao_devolve_marca() {
    let seen = Arc::new(MarksSeen::default());
    let (ad, _env) = armed(&seen, "off").await;
    let hash = hash_of(HASH_CHAR);
    // Pior caso: o plano ATIVO é injetado mesmo com a flag OFF no ambiente.
    let report = ad
        .check_cached(
            KEY,
            std::slice::from_ref(&hash),
            &opts(true, true, Some(&[]), &[], true, None),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    plan.run_with(
        &ad,
        KEY,
        DeleteConfig {
            kill: Some(false),
            ..DeleteConfig::fast()
        },
    )
    .await
    .expect("fila rodou");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        seen.bodies
            .lock()
            .unwrap()
            .iter()
            .all(|body| !contains(body, "submitted", &hash) && !contains(body, "removed", &hash)),
        "cleanup OFF não abre HTTP: nada subiu nem saiu de propósito"
    );
}
