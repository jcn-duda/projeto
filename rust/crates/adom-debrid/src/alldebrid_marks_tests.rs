//! Posse da limpeza NATIVA gravada no KV nativo (`adsub:v1`, mesmo `cache.db`
//! do Node) pela checagem real, e o que NÃO sai dela: higiene nunca vira
//! `adrm` e com a limpeza OFF nada é gravado. O KV de teste é o arquivo do
//! processo (`marks_feed::test_db_path`), o mesmo que o `spawn` escreve.
//!
//! Módulo filho de `alldebrid_cleanup_tests`: reaproveita o servidor falso da
//! AllDebrid (`scene`/`listen`/`DeleteMode`) e o `EnvGuard` de lá.

use super::*;

use std::time::Instant;

use adom_index::NativeKv;

use crate::alldebrid_cleanup::{account_scope, adrm_key, adsub_key};
use crate::marks_feed::test_kv;

/// Chars HEXADECIMAIS (o hash é 40 hex, senão a posse é descartada) que nenhuma
/// outra suíte usa: o KV de teste é compartilhado no processo. `7` é o da
/// subida (ON); `8` é o da prova com a limpeza OFF, que não pode herdar posse.
const HASH_ON: char = '7';
const HASH_OFF: char = '8';

/// Cliente da AllDebrid contra o dublê da API. O guard mantém o env e a trava
/// até o fim do teste (testes que mexem em env rodam um por vez).
async fn armed(cleanup: &str, ch: char) -> (AllDebrid, EnvGuard) {
    let api_scene = scene(&ch.to_string(), &[], DeleteMode::Ok);
    let addr = listen(api_scene).await;
    let base = format!("http://{addr}");
    let env = EnvGuard::set(&[
        ("DEBRID_AL_CLEANUP", cleanup),
        ("ALLDEBRID_API_BASE", base.as_str()),
    ]);
    (AllDebrid::new(HttpClient::new().unwrap()), env)
}

fn kv() -> &'static NativeKv {
    test_kv().expect("KV de teste aberto pelo spawn")
}

fn now() -> i64 {
    crate::error::now_ms() as i64
}

/// Espera a chave aparecer (teto de ~2 s): a gravação roda em `spawn_blocking`.
async fn wait_key(kv: &NativeKv, key: &str) -> Option<serde_json::Value> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(value) = kv.get_json(key, now()).unwrap() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn upload_aceito_grava_posse_no_kv_nativo() {
    let (ad, _env) = armed("on", HASH_ON).await;
    let hash = hash_of(HASH_ON);
    // `drop_ready: false` mantém o lote sem alvo de delete: só a posse é gravada.
    let report = ad
        .check_cached(
            KEY,
            std::slice::from_ref(&hash),
            &opts(false, true, Some(&[]), &[], true, None),
        )
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash.clone()]);
    let account = account_scope(KEY);
    let value = wait_key(kv(), &adsub_key(&account, &hash))
        .await
        .expect("a posse do upload precisa cair no KV nativo");
    assert!(value["at"].is_number(), "valor é {{at}}: {value}");
    assert!(
        kv().get_json(&adrm_key(&account, &hash), now())
            .unwrap()
            .is_none(),
        "subir não é remoção intencional"
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn limpeza_de_higiene_nao_grava_adrm() {
    let (ad, _env) = armed("on", HASH_ON).await;
    let hash = hash_of(HASH_ON);
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
    let account = account_scope(KEY);
    // Espera a posse da subida: prova que a gravação de fundo já rodou.
    wait_key(kv(), &adsub_key(&account, &hash))
        .await
        .expect("a subida da checagem precisa virar posse");
    // Higiene da checagem NÃO vira `adrm`: o hash não foi condenado, só não
    // estava em cache. Marcá-lo bloqueava o Chupim por 3 dias.
    assert!(
        kv().get_json(&adrm_key(&account, &hash), now())
            .unwrap()
            .is_none(),
        "limpeza de higiene não pode gravar remoção intencional"
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn cleanup_off_nao_grava_posse_nem_marca() {
    let (ad, _env) = armed("off", HASH_OFF).await;
    let hash = hash_of(HASH_OFF);
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
    let account = account_scope(KEY);
    assert!(
        kv().get_json(&adsub_key(&account, &hash), now())
            .unwrap()
            .is_none(),
        "cleanup OFF não grava posse: nada subiu de propósito"
    );
    assert!(kv()
        .get_json(&adrm_key(&account, &hash), now())
        .unwrap()
        .is_none());
}
