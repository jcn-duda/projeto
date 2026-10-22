//! Play nativo por debrid: o dispatch do `/resolve` do gateway.
//!
//! Cada adaptador continua dono do próprio fluxo (upload/poll/pick/unlock).
//! Aqui só se escolhe o serviço e se normaliza a resposta: `url` (o link de
//! reprodução), `unavailable` (frio que virou negativo no AllDebrid) e a lista
//! de arquivos quando o adaptador a produz. O gateway não grava estado — L1,
//! magnetdb e índice continuam no Node.
//!
//! Sem adaptador (serviço/key ausentes ou desconhecidos) o resultado é vazio,
//! como o `current()` do Node devolvendo `null`: o `/resolve` responde 404
//! "ainda baixando", nunca 500.

use std::time::Duration;

use adom_core::PlayHint;

use crate::alldebrid::{AllDebrid, PlayError, PlayFile, ResolveOpts};
use crate::debridlink::DebridLink;
use crate::error::DebridError;
use crate::http::HttpClient;
use crate::premiumize::Premiumize;
use crate::realdebrid::RealDebrid;
use crate::torbox::TorBox;

/// Espera do poll em produção (o `wait(700)` dos adaptadores TS).
pub const POLL_WAIT: Duration = Duration::from_millis(700);

/// Resultado normalizado do play.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayOutcome {
    /// Link de reprodução; `None` = torrent ainda baixando/sem arquivo.
    pub url: Option<String>,
    /// AllDebrid: o frio foi removido da conta e prova `davail=0`.
    pub unavailable: bool,
    /// Lista do torrent quando o adaptador a expõe (hoje só AllDebrid).
    pub files: Option<Vec<PlayFile>>,
}

impl PlayOutcome {
    fn from_url(url: Option<String>) -> Self {
        Self {
            url,
            ..Self::default()
        }
    }
}

/// Serviços que este crate resolve. Desconhecido = sem adaptador (404).
pub fn known_service(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox" | "debridlink"
    )
}

/// Play com a espera de produção dos adaptadores.
pub async fn resolve(
    service: &str,
    api_key: &str,
    info_hash: &str,
    hint: &PlayHint,
    client: HttpClient,
) -> Result<PlayOutcome, DebridError> {
    resolve_with_wait(service, api_key, info_hash, hint, client, POLL_WAIT).await
}

/// Mesmo dispatch, com a espera entre polls injetável (testes usam `ZERO`).
pub async fn resolve_with_wait(
    service: &str,
    api_key: &str,
    info_hash: &str,
    hint: &PlayHint,
    client: HttpClient,
    poll_wait: Duration,
) -> Result<PlayOutcome, DebridError> {
    resolve_held(service, api_key, info_hash, hint, client, poll_wait, true)
        .await
        .map_err(|failure| failure.error)
}

/// Dispatch completo do `/resolve` nativo: `held` é o fato do Node (o hold do
/// autofetch; só a AllDebrid o usa para decidir se apaga o frio) e a falha
/// leva os `files` que o adaptador já leu — a prova de áudio da dublagem falsa
/// o Node grava mesmo com o play recusado.
pub async fn resolve_held(
    service: &str,
    api_key: &str,
    info_hash: &str,
    hint: &PlayHint,
    client: HttpClient,
    poll_wait: Duration,
    held: bool,
) -> Result<PlayOutcome, PlayError> {
    match service {
        "premiumize" => {
            let url = Premiumize::new(client)
                .resolve_link(api_key, info_hash, hint, None)
                .await?;
            Ok(PlayOutcome::from_url(url))
        }
        "realdebrid" => {
            let url = RealDebrid::new(client)
                .resolve_link(api_key, info_hash, hint, None, poll_wait)
                .await?;
            Ok(PlayOutcome::from_url(url))
        }
        "torbox" => {
            let url = TorBox::new(client)
                .resolve_link(api_key, info_hash, hint, None, poll_wait)
                .await?;
            Ok(PlayOutcome::from_url(url))
        }
        "debridlink" => {
            let url = DebridLink::new(client)
                .resolve_link(api_key, info_hash, hint, None, poll_wait)
                .await?;
            Ok(PlayOutcome::from_url(url))
        }
        "alldebrid" => {
            // O hold volátil do autofetch mora no Node; sem o fato, `held:
            // true` é o lado seguro (não apaga o download de ninguém). O frio
            // só é removido com `DEBRID_DROP_UNCACHED` ligado, como no TS.
            let opts = ResolveOpts {
                poll_wait,
                drop_uncached: drop_uncached_env(),
                held,
            };
            let played = AllDebrid::new(client)
                .resolve_link(api_key, info_hash, hint, &opts)
                .await?;
            Ok(PlayOutcome {
                url: played.url,
                unavailable: played.unavailable,
                files: played.files,
            })
        }
        // Serviço desconhecido: `current()` do Node também devolve null.
        _ => Ok(PlayOutcome::default()),
    }
}

/// `String(env || 'true') === 'true'` — o mesmo default do Node/API interna.
fn drop_uncached_env() -> bool {
    match std::env::var("DEBRID_DROP_UNCACHED") {
        Ok(value) if !value.is_empty() => value == "true",
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::routing::any;
    use axum::{Json, Router};
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::*;

    #[test]
    fn servicos_conhecidos_batem_com_o_registry_do_node() {
        for service in [
            "premiumize",
            "realdebrid",
            "alldebrid",
            "torbox",
            "debridlink",
        ] {
            assert!(known_service(service), "{service}");
        }
        assert!(!known_service(""));
        assert!(!known_service("stremthru"));
    }

    #[tokio::test]
    // A trava de env do crate é global e o teste roda em runtime current-thread;
    // o adaptador lê a base dentro do dispatch (por isso o guard vive até o fim).
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_premiumize_usa_o_adaptador_e_devolve_o_link() {
        let app = Router::new().fallback(any(|| async {
            Json(json!({
                "status": "success",
                "content": [
                    {"path": "Filme.2024.1080p.Dublado.mkv", "size": 10, "link": "https://cdn.test/filme"}
                ]
            }))
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // `Premiumize::new` lê a base no dispatch; a trava é a mesma dos testes
        // de env do crate (não deixa outro teste ver a URL do mock).
        let _lock = crate::test_env::lock();
        std::env::set_var("PREMIUMIZE_API_BASE", format!("http://{addr}"));
        let client = HttpClient::new().expect("cliente");
        let outcome = resolve_with_wait(
            "premiumize",
            "chave",
            "0123456789abcdef0123456789abcdef01234567",
            &PlayHint::default(),
            client,
            Duration::ZERO,
        )
        .await
        .unwrap();
        std::env::remove_var("PREMIUMIZE_API_BASE");
        assert_eq!(outcome.url.as_deref(), Some("https://cdn.test/filme"));
    }
}
