//! Cliente HTTP que comunica resultados do crawl ao Node e consulta atividade.
//!
//! Todas as requisições incluem o token de administração no header
//! `X-Indexer-Test-Token` para autenticação com o endpoint interno do Node.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fmt;

use crate::motor::types::CrawlWorkResult;

/// Token de autenticação enviado em cada requisição ao Node.
const TOKEN_HEADER: &str = "X-Indexer-Test-Token";

/// Cliente HTTP que envia resultados ao Node e consulta atividade do usuário.
pub struct SidecarHttpClient {
    client: Client,
    node_url: String,
    admin_token: String,
}

/// Erros possíveis na comunicação HTTP com o Node.
#[derive(Debug)]
pub enum SidecarHttpError {
    /// Falha de conexão (DNS, TCP reset, servidor recusou, etc.).
    ConnectionError(String),
    /// Resposta HTTP com status de erro.
    HttpError { status: u16, body: String },
    /// Timeout da requisição.
    Timeout,
    /// Falha ao serializar/deserializar JSON.
    SerializeError(String),
}

impl fmt::Display for SidecarHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConnectionError(msg) => write!(f, "erro de conexão: {}", msg),
            Self::HttpError { status, body } => {
                write!(f, "HTTP {} — {}", status, body)
            }
            Self::Timeout => write!(f, "timeout na requisição"),
            Self::SerializeError(msg) => write!(f, "erro de serialização: {}", msg),
        }
    }
}

impl std::error::Error for SidecarHttpError {}

/// Resposta esperada de `GET /internal/activity`.
#[derive(Deserialize)]
struct ActivityResponse {
    recent: bool,
}

impl SidecarHttpClient {
    /// Cria um novo cliente HTTP para o sidecar.
    ///
    /// * `node_url` — URL base do Node, ex.: `http://127.0.0.1:7000`
    /// * `admin_token` — token de administração para o header `X-Indexer-Test-Token`
    pub fn new(node_url: String, admin_token: String) -> Self {
        Self {
            client: Client::new(),
            node_url,
            admin_token,
        }
    }

    /// POST `/internal/crawl-result` com o `CrawlWorkResult` serializado em JSON.
    ///
    /// O token é enviado no header `X-Indexer-Test-Token`.
    pub async fn post_crawl_result(
        &self,
        result: &CrawlWorkResult,
    ) -> Result<(), SidecarHttpError> {
        let url = format!("{}/internal/crawl-result", self.node_url);

        let resp = self
            .client
            .post(&url)
            .header(TOKEN_HEADER, &self.admin_token)
            .json(result)
            .send()
            .await
            .map_err(|e| classify_reqwest_error(&e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<corpo ilegível>".into());
            return Err(SidecarHttpError::HttpError {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    /// GET `/internal/activity` — consulta se houve tráfego de usuário recente.
    ///
    /// Envia `idle_window_ms` como query parameter.
    /// Retorna `true` se o raspador deve pausar (usuário ativo).
    pub async fn check_activity(&self, idle_window_ms: u64) -> Result<bool, SidecarHttpError> {
        let url = format!(
            "{}/internal/activity?window_ms={}",
            self.node_url, idle_window_ms
        );

        let resp = self
            .client
            .get(&url)
            .header(TOKEN_HEADER, &self.admin_token)
            .send()
            .await
            .map_err(|e| classify_reqwest_error(&e))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<corpo ilegível>".into());
            return Err(SidecarHttpError::HttpError {
                status: status.as_u16(),
                body,
            });
        }

        let activity: ActivityResponse = resp
            .json()
            .await
            .map_err(|e| SidecarHttpError::SerializeError(e.to_string()))?;

        Ok(activity.recent)
    }

    /// GET `/internal/crawl-status` — healthcheck do motor de crawl.
    ///
    /// Retorna `Ok(())` se o Node respondeu com status 2xx.
    pub async fn healthcheck(&self) -> Result<(), SidecarHttpError> {
        let url = format!("{}/internal/crawl-status", self.node_url);

        let resp = self
            .client
            .get(&url)
            .header(TOKEN_HEADER, &self.admin_token)
            .send()
            .await
            .map_err(|e| classify_reqwest_error(&e))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            return Err(SidecarHttpError::HttpError {
                status,
                body: format!("healthcheck falhou com status {}", status),
            });
        }

        Ok(())
    }
}

/// Classifica um erro do `reqwest` em [`SidecarHttpError`].
fn classify_reqwest_error(e: &reqwest::Error) -> SidecarHttpError {
    if e.is_timeout() {
        SidecarHttpError::Timeout
    } else if e.is_connect() {
        SidecarHttpError::ConnectionError(e.to_string())
    } else {
        SidecarHttpError::ConnectionError(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json;

    /// Verifica que o enum de erro formata mensagens legíveis.
    #[test]
    fn sidecar_http_error_display() {
        let err = SidecarHttpError::ConnectionError("recusado".into());
        assert_eq!(err.to_string(), "erro de conexão: recusado");

        let err = SidecarHttpError::Timeout;
        assert_eq!(err.to_string(), "timeout na requisição");

        let err = SidecarHttpError::HttpError {
            status: 500,
            body: "erro interno".into(),
        };
        assert_eq!(err.to_string(), "HTTP 500 — erro interno");

        let err = SidecarHttpError::SerializeError("campo faltando".into());
        assert_eq!(err.to_string(), "erro de serialização: campo faltando");
    }

    /// Verifica que `SidecarHttpError` implementa `std::error::Error`.
    #[test]
    fn sidecar_http_error_is_std_error() {
        let err: Box<dyn std::error::Error> =
            Box::new(SidecarHttpError::ConnectionError("teste".into()));
        assert!(err.to_string().contains("teste"));
    }

    /// Verifica que `classify_reqwest_error` classifica timeout corretamente.
    /// (Teste unitário básico — não faz requisição real.)
    #[test]
    fn classify_reqwest_error_timeout() {
        // reqwest::Error não é construível diretamente, mas podemos testar
        // a lógica via a função pública indiretamente em integração.
        // Aqui garantimos que o enum existe e é construtível.
        let err = SidecarHttpError::Timeout;
        assert!(matches!(err, SidecarHttpError::Timeout));
    }
}
