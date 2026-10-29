//! As GUARDAS do dreno da represa — o que a rota recusa e por quê.
//!
//! Filho de `routes_tests` (reusa o `Admin`, os helpers e o `KnobScope`): o
//! Router REAL da admin em loopback + token, e o `FakeDebrid` provando que
//! NENHUM `remove` chegou ao serviço na recusa. Separado pela catraca de 400
//! linhas, como `suppressed_step`/`suppressed_guard`.
//!
//! Três regras, cada teste nomeando a sua:
//! 1. `{"confirm":true}` sem credencial DESTRUTIVA ⇒ 409/403 (`/sweeps/run`
//!    já tinha; o dreno apaga na conta do operador e agora tem o mesmo trato);
//! 2. sem `confirm` ⇒ 409 `confirmation_required` (nunca no-op silencioso);
//! 3. `config`/`pause` não são porta de credencial e não ecoam o valor.

use std::sync::Arc;

use adom_autofetch::v3::SuppressedV3;
use adom_index::NativeKv;
use http::StatusCode;
use serde_json::json;

use super::suppressed_step;
use super::*;

/// REGRA: ação destrutiva sem `{"confirm":true}` é RECUSADA com 409
/// `confirmation_required` — corpo ausente, `{}`, `false`, `"true"` (string) e
/// `1` não confirmam. Nada é varrido, o serviço não é chamado e a represa fica
/// intacta (o knob OFF aqui é só para o teste não depender do `.env`).
#[tokio::test]
async fn rota_sem_confirm_recusa_409_e_nao_apaga() {
    let knob = KnobScope::value(None);
    let _guard = suppressed_step::test_lock().await;
    suppressed_step::clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    SuppressedV3::new(&kv)
        .note(ADAPTER, ACCOUNT, &hash(7), "id-7", TTL, now)
        .unwrap();
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    let admin = Admin::mount(Some(handle), Some(Arc::clone(&kv))).await;
    let debrid = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = debrid.clone();
    suppressed_step::register_factory(factory_for(SCOPE, io));

    // Sem corpo nenhum: a rota não tem como confirmar.
    let (status, body) = admin
        .call(post_no_body("/autofetch/suppressed-drain", TOKEN))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["ok"], false, "{body}");
    assert_eq!(body["error"], "confirmation_required", "{body}");

    for body in [
        json!({}),
        json!({ "confirm": false }),
        json!({ "confirm": "true" }),
        json!({ "confirm": 1 }),
    ] {
        let (status, out) = admin
            .call(post("/autofetch/suppressed-drain", body.clone()))
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body} => {out}");
        assert_eq!(out["error"], "confirmation_required", "{body} => {out}");
    }
    // Prova do "não apaga": o adaptador não recebeu nenhum `remove`.
    assert!(debrid.removed().is_empty(), "{:?}", debrid.removed());
    assert_eq!(suppressed_step::count(&kv, now).unwrap(), 1);
    assert_eq!(suppressed_step::last(), None, "nenhum passo registrado");
    drop(knob);
    suppressed_step::clear();
}

/// REGRA: o token de DIAGNÓSTICO (o mesmo de `/metrics.json` e dos scripts)
/// abre a superfície mas NÃO apaga magnet: com `{"confirm":true}` e um segundo
/// token configurado, a resposta é 403 `autofetch_token_insufficient` — o mesmo
/// contrato de `POST /sweeps/run`.
#[tokio::test]
async fn rota_com_token_de_diagnostico_recusa_403() {
    let knob = KnobScope::value(None);
    let _guard = suppressed_step::test_lock().await;
    suppressed_step::clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    SuppressedV3::new(&kv)
        .note(ADAPTER, ACCOUNT, &hash(9), "id-9", TTL, now)
        .unwrap();
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    // `TOKEN` abre o `auth` global; a credencial destrutiva é OUTRA.
    let admin = Admin::mount_tokens(
        Some(handle),
        Some(Arc::clone(&kv)),
        TOKEN,
        Some(DESTRUCTIVE),
    )
    .await;
    let debrid = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = debrid.clone();
    suppressed_step::register_factory(factory_for(SCOPE, io));

    let (status, body) = admin
        .call(post(
            "/autofetch/suppressed-drain",
            json!({ "confirm": true }),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["ok"], false, "{body}");
    assert_eq!(body["error"], "autofetch_token_insufficient", "{body}");
    assert_eq!(body["reason"], "diagnostic_token", "{body}");
    assert!(debrid.removed().is_empty(), "{:?}", debrid.removed());
    assert_eq!(suppressed_step::count(&kv, now).unwrap(), 1);

    // A credencial destrutiva NÃO é atalho para a superfície: o `auth` global
    // compara com o token dela (`TOKEN`) e o mesmo header responde 401. É por
    // isso que a config de produção usa UMA env para as duas (`mount`).
    let (status, body) = admin
        .call(post_as(
            "/autofetch/suppressed-drain",
            json!({ "confirm": true }),
            DESTRUCTIVE,
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert!(debrid.removed().is_empty(), "{:?}", debrid.removed());
    drop(knob);
    suppressed_step::clear();
}

/// REGRA: gateway sem credencial destrutiva (só a de diagnóstico configurada)
/// recusa o dreno com 409 `autofetch_requires_admin_token` — falha FECHADA:
/// configuração ausente não vira permissão.
#[tokio::test]
async fn rota_sem_credencial_destrutiva_recusa_409() {
    let knob = KnobScope::value(None);
    let _guard = suppressed_step::test_lock().await;
    suppressed_step::clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    SuppressedV3::new(&kv)
        .note(ADAPTER, ACCOUNT, &hash(10), "id-10", TTL, now)
        .unwrap();
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    let admin = Admin::mount_tokens(Some(handle), Some(Arc::clone(&kv)), TOKEN, None).await;
    let debrid = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = debrid.clone();
    suppressed_step::register_factory(factory_for(SCOPE, io));

    let (status, body) = admin
        .call(post(
            "/autofetch/suppressed-drain",
            json!({ "confirm": true }),
        ))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "autofetch_requires_admin_token", "{body}");
    assert_eq!(body["reason"], "no_destructive_token", "{body}");
    assert!(debrid.removed().is_empty(), "{:?}", debrid.removed());
    assert_eq!(suppressed_step::count(&kv, now).unwrap(), 1);
    drop(knob);
    suppressed_step::clear();
}

/// REGRA: `config`/`pause` não são porta de credencial. Campo fora de
/// `paused`/`intervalMs` é 400 e NEM ecoa o valor recebido na resposta.
#[tokio::test]
async fn config_e_pause_recusam_credencial_no_corpo_sem_ecoar() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    let admin = Admin::mount(Some(handle), Some(Arc::clone(&kv))).await;
    let segredo = "chave-que-nao-pode-vazar";

    for (path, body) in [
        ("/autofetch/config", json!({ "apiKey": segredo })),
        ("/autofetch/config", json!({ "encoded": segredo })),
        ("/autofetch/config", json!({ "token": segredo })),
        (
            "/autofetch/config",
            json!({ "paused": true, "service": segredo }),
        ),
        (
            "/autofetch/pause",
            json!({ "paused": true, "apiKey": segredo }),
        ),
    ] {
        let (status, out) = admin.call(post(path, body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path} {body} => {out}");
        assert!(
            !out.to_string().contains(segredo),
            "{path} ecoou o valor: {out}"
        );
    }
}
