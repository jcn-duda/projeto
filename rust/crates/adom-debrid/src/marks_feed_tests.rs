//! Marcas da limpeza nativa (`/internal/debrid/marked`): contrato do POST,
//! loopback, prazo, envs internas e o gate da flag. O dublê da rota mora em
//! [`super::test_support`]; nada aqui fala com rede real.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::test_support::{listen, wait_bodies, MarksSeen};
use super::{timeout_from, InternalMarkedClient, MarkedBatch, DEFAULT_BASE, TIMEOUT_ENV};

const TOKEN: &str = "token-interno-marked";
const KEY: &str = "chave-da-conta-marked";
const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/// Env com a trava única do crate (outros módulos de teste também mexem).
struct EnvGuard {
    prev: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
        let lock = crate::test_env::lock();
        let mut prev = Vec::new();
        for (name, value) in pairs {
            prev.push((*name, std::env::var(name).ok()));
            unsafe {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
        Self { prev, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            for (name, value) in &self.prev {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

fn batch() -> MarkedBatch {
    MarkedBatch {
        api_key: KEY.into(),
        submitted: vec![HIT.into()],
    }
}

#[test]
fn corpo_leva_servico_chave_e_a_posse_sem_canal_de_remocao() {
    let body = batch().body();
    assert_eq!(body["service"], json!("alldebrid"));
    assert_eq!(body["apiKey"], json!(KEY));
    assert_eq!(body["submitted"], json!([HIT]));
    // A higiene da checagem nunca vira `adrm`: o campo não existe mais.
    assert!(body.get("removed").is_none());
}

#[tokio::test]
async fn cliente_manda_token_no_header_e_as_listas_no_corpo() {
    let seen = Arc::new(MarksSeen::default());
    let base = listen(seen.clone()).await;
    let client = InternalMarkedClient::new(&base, TOKEN, Duration::from_millis(2_000)).unwrap();
    client.send(&batch()).await.unwrap();

    let tokens = seen.tokens.lock().unwrap();
    assert_eq!(
        tokens.first().cloned().flatten().as_deref(),
        Some(TOKEN),
        "o token vai SÓ no header"
    );
    drop(tokens);
    let bodies = seen.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["service"], json!("alldebrid"));
    assert_eq!(bodies[0]["apiKey"], json!(KEY));
    assert_eq!(bodies[0]["submitted"], json!([HIT]));
    assert!(bodies[0].get("removed").is_none());
    assert!(
        bodies[0].get("encoded").is_none(),
        "a marca não carrega config do usuário"
    );
}

#[tokio::test]
async fn cliente_recusa_lote_vazio_host_nao_loopback_e_chave_ausente() {
    let seen = Arc::new(MarksSeen::default());
    let base = listen(seen.clone()).await;
    let client = InternalMarkedClient::new(&base, TOKEN, Duration::from_millis(1_000)).unwrap();
    assert!(
        client.send(&MarkedBatch::default()).await.is_err(),
        "lote vazio não vira POST"
    );
    let mut sem_chave = batch();
    sem_chave.api_key.clear();
    assert!(client.send(&sem_chave).await.is_err());
    assert!(InternalMarkedClient::new(
        "http://example.com:7100",
        TOKEN,
        Duration::from_millis(1_000)
    )
    .is_err());
    assert!(
        seen.bodies.lock().unwrap().is_empty(),
        "nada inválido abriu HTTP"
    );
}

#[test]
fn from_env_usa_as_mesmas_envs_internas_do_feed() {
    // Sem token não há canal (nem com base válida).
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some(DEFAULT_BASE)),
            ("DEBRID_INTERNAL_TOKEN", None),
            ("JACKETT_TEST_TOKEN", None),
        ]);
        assert!(InternalMarkedClient::from_env().is_none());
    }
    // `JACKETT_TEST_TOKEN` é o fallback do token interno.
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some(DEFAULT_BASE)),
            ("DEBRID_INTERNAL_TOKEN", None),
            ("JACKETT_TEST_TOKEN", Some(TOKEN)),
        ]);
        assert!(InternalMarkedClient::from_env().is_some());
    }
    // Fora do loopback não há canal, mesmo com token.
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some("http://203.0.113.9:7100")),
            ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
            ("JACKETT_TEST_TOKEN", None),
        ]);
        assert!(InternalMarkedClient::from_env().is_none());
    }
}

#[test]
fn timeout_tem_default_e_minimo() {
    assert_eq!(timeout_from(None), Duration::from_millis(1_500));
    assert_eq!(timeout_from(Some("0")), Duration::from_millis(1_500));
    assert_eq!(timeout_from(Some("250")), Duration::from_millis(250));
    let _env = EnvGuard::set(&[(TIMEOUT_ENV, Some("120"))]);
    assert_eq!(
        timeout_from(std::env::var(TIMEOUT_ENV).ok().as_deref()),
        Duration::from_millis(120)
    );
}

// ── Gate: nada é enviado com a limpeza OFF ──────────────────────────────────

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn spawn_so_entrega_com_cleanup_ligado() {
    let seen = Arc::new(MarksSeen::default());
    let base = listen(seen.clone()).await;
    {
        let _env = EnvGuard::set(&[
            ("DEBRID_AL_CLEANUP", Some("off")),
            ("INTERNAL_CHECK_URL", Some(base.as_str())),
            ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
            ("JACKETT_TEST_TOKEN", None),
        ]);
        super::spawn(batch());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            seen.bodies.lock().unwrap().is_empty(),
            "cleanup OFF não abre HTTP: nada foi subido/removido de propósito"
        );
    }
    {
        let _env = EnvGuard::set(&[
            ("DEBRID_AL_CLEANUP", Some("on")),
            ("INTERNAL_CHECK_URL", Some(base.as_str())),
            ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
            ("JACKETT_TEST_TOKEN", None),
        ]);
        super::spawn(batch());
        let bodies = wait_bodies(&seen, 1).await;
        assert_eq!(bodies.len(), 1, "cleanup ON entrega o lote uma vez");
        assert_eq!(bodies[0]["submitted"], json!([HIT]));
    }
}
