//! Guarda nativa de `/resolve` (`ROUTES_RUST` contém o token exato `resolve`).
//!
//! Fatia C.2 embrião: o Rust **só verifica o HMAC** (infoHash + S/E + `w` com
//! `p:1` dentro da dica). Play real continua no Node via proxy (strangler) —
//! sem segundo upload debrid. Com proxy desligado (`GATEWAY_RESOLVE_PROXY=off`)
//! devolve 501 em vez de encaminhar.

use axum::body::Body;
use axum::response::IntoResponse;
use http::header::CONTENT_TYPE;
use http::{Method, Request, Response, StatusCode};

use adom_search::{resolve_play_from, resolve_secret_for, verify_resolve_play, ResolveVerify};

/// Token exato `resolve` — não confunde com futuros `resolve-*`.
pub fn is_native_resolve(method: &Method, path: &str) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && adom_search::parse_resolve_path(path).is_some()
}

/// Decisão pura após o parse. O dispatch traduz em HTTP / proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    BadHash,
    Forbidden,
    /// Encaminhar ao Node (strangler).
    Proxy,
    /// Proxy desligado — play nativo ainda não existe nesta fatia.
    NotImplemented,
}

/// Verifica HMAC e decide proxy × 501. `resolve_secret` = env `RESOLVE_SECRET`.
pub fn decide(
    path: &str,
    query: Option<&str>,
    resolve_secret: &str,
    proxy_enabled: bool,
) -> GateDecision {
    let Some(play) = resolve_play_from(path, query) else {
        // Path casou em `is_native_resolve` mas query/hash degenerados — trata
        // como hash inválido (mesma faixa do 400 do Node).
        return GateDecision::BadHash;
    };
    let secret = resolve_secret_for(resolve_secret, play.encoded.as_deref());
    match verify_resolve_play(&play, &secret) {
        ResolveVerify::InvalidHash => GateDecision::BadHash,
        ResolveVerify::Forbidden => GateDecision::Forbidden,
        ResolveVerify::Unsigned | ResolveVerify::Ok => {
            if proxy_enabled {
                GateDecision::Proxy
            } else {
                GateDecision::NotImplemented
            }
        }
    }
}

pub fn bad_hash_response() -> Response<Body> {
    (
        StatusCode::BAD_REQUEST,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "infoHash inválido",
    )
        .into_response()
}

pub fn forbidden_response() -> Response<Body> {
    (
        StatusCode::FORBIDDEN,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "assinatura inválida",
    )
        .into_response()
}

pub fn not_implemented_response() -> Response<Body> {
    (
        StatusCode::NOT_IMPLEMENTED,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "play nativo ainda não implementado (proxy desligado)",
    )
        .into_response()
}

/// Extrai path/query da requisição sem consumir o body (proxy precisa dele).
pub fn path_and_query(req: &Request<Body>) -> (&str, Option<&str>) {
    (req.uri().path(), req.uri().query())
}

#[cfg(test)]
mod tests {
    use super::*;
    use adom_search::{ResolveSigner, WorkHint};

    fn signed_url(hash: &str, secret: &str, multi: bool) -> (String, String) {
        let signer = ResolveSigner {
            prefix: String::new(),
            secret: secret.into(),
            season: Some(1),
            episode: Some(1),
            imdb_id: Some("tt0903747".into()),
            work_hint: Some(WorkHint {
                names: vec!["Breaking Bad".into()],
                year: Some(2008),
            }),
        };
        let url = signer.url(hash, true, multi);
        let (path, query) = url.split_once('?').unwrap();
        (path.to_string(), query.to_string())
    }

    #[test]
    fn decide_403_com_sig_errada() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        let path = format!("/resolve/{hash}");
        assert_eq!(
            decide(&path, Some("sig=deadbeef"), "segredo", true),
            GateDecision::Forbidden
        );
    }

    #[test]
    fn decide_proxy_com_sig_ok() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        let (path, q) = signed_url(hash, "segredo", true);
        assert_eq!(
            decide(&path, Some(&q), "segredo", true),
            GateDecision::Proxy
        );
    }

    #[test]
    fn decide_501_quando_proxy_desligado() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        let (path, q) = signed_url(hash, "segredo", true);
        assert_eq!(
            decide(&path, Some(&q), "segredo", false),
            GateDecision::NotImplemented
        );
    }

    #[test]
    fn decide_400_hash_curto() {
        assert_eq!(
            decide("/resolve/aa", Some("sig=x"), "segredo", true),
            GateDecision::BadHash
        );
    }

    #[test]
    fn is_native_resolve_so_get_head() {
        assert!(is_native_resolve(
            &Method::GET,
            "/resolve/0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(is_native_resolve(
            &Method::HEAD,
            "/e30/resolve/0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(!is_native_resolve(
            &Method::POST,
            "/resolve/0123456789abcdef0123456789abcdef01234567"
        ));
        assert!(!is_native_resolve(&Method::GET, "/stream/movie/tt1.json"));
    }

    #[test]
    fn unsigned_ainda_pode_proxy() {
        // Sem segredo o Node também não exige HMAC — strangler encaminha.
        let hash = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            decide(&format!("/resolve/{hash}"), None, "", true),
            GateDecision::Proxy
        );
    }

    #[test]
    fn hint_p1_entra_no_hmac() {
        // Pack multiobra: `p:1` dentro de `w` — trocar a dica invalida o sig.
        let hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let (path, q_ok) = signed_url(hash, "k", true);
        assert_eq!(decide(&path, Some(&q_ok), "k", true), GateDecision::Proxy);
        let (_path, q_sem_p) = signed_url(hash, "k", false);
        // Reusa o sig do pack (`p:1`) com a query sem `p` → Forbidden.
        let sig = q_ok.rsplit("sig=").next().unwrap();
        let w_sem_p = q_sem_p.split('&').find(|p| p.starts_with("w=")).unwrap();
        let q_bad = format!("{w_sem_p}&sig={sig}");
        assert_eq!(
            decide(&path, Some(&q_bad), "k", true),
            GateDecision::Forbidden
        );
    }
}
