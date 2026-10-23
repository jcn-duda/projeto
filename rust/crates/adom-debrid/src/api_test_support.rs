//! Andaimes dos testes da API interna 8710: o roteador por token e a env em
//! loopback sob a trava ÚNICA do crate. Fora do `api_tests` porque mais de um
//! módulo de teste dirige as mesmas rotas (`/debrid/account`, `/debrid/check`).

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use super::{router, InternalConfig};

pub(super) const KEY: &str = "nao-logar";

pub(super) fn cfg(token: &str) -> InternalConfig {
    InternalConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: token.to_string(),
        // Ausente de propósito: sem ledger o RD responde `unknown`, e o boot
        // da API não cria arquivo nenhum.
        cache_db: PathBuf::from("data/cache.db.ausente"),
    }
}

pub(super) async fn call(
    token: &str,
    header: Option<&str>,
    path: &str,
    body: &str,
) -> (StatusCode, String) {
    let app = router(&cfg(token));
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(value) = header {
        builder = builder.header("x-indexer-test-token", value);
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

pub(super) struct EnvBase {
    name: &'static str,
    prev: Option<String>,
    // Trava ÚNICA do crate: outros módulos de teste também mexem na env.
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvBase {
    pub(super) fn set(name: &'static str, value: &str) -> Self {
        let lock = crate::test_env::lock();
        let prev = std::env::var(name).ok();
        // SAFETY: a trava única serializa os testes de env do crate.
        unsafe { std::env::set_var(name, value) }
        Self {
            name,
            prev,
            _lock: lock,
        }
    }
}

impl Drop for EnvBase {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var(self.name, value),
                None => std::env::remove_var(self.name),
            }
        }
    }
}

/// Várias envs sob a MESMA trava (dois `EnvBase` no mesmo teste travariam).
pub(super) struct EnvVars {
    saved: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvVars {
    pub(super) fn set(pairs: &[(&'static str, &str)]) -> Self {
        let _lock = crate::test_env::lock();
        let saved = pairs
            .iter()
            .map(|(name, value)| {
                let prev = std::env::var(name).ok();
                // SAFETY: a trava única serializa os testes de env do crate.
                unsafe { std::env::set_var(name, value) };
                (*name, prev)
            })
            .collect();
        Self { saved, _lock }
    }
}

impl Drop for EnvVars {
    fn drop(&mut self) {
        for (name, prev) in &self.saved {
            unsafe {
                match prev {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}
