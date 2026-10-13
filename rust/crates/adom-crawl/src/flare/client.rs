//! Cliente HTTP do FlareSolverr — envia cmds e recebe soluções.
//! Porte fiel de `resolvers/flare.ts:91+`.

use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::types::{FlareError, FlareSolution};

/// Request body enviado ao FlareSolverr `/v1`.
#[derive(Debug, Serialize)]
struct FlareRequest {
    cmd: String,
    url: String,
    #[serde(rename = "maxTimeout")]
    max_timeout: u64,
}

/// Response body retornado pelo FlareSolverr `/v1`.
#[derive(Debug, Deserialize)]
struct FlareResponse {
    solution: Option<FlareSolutionPayload>,
    status: Option<String>,
    message: Option<String>,
}

/// Payload da solução dentro da resposta do FlareSolverr.
#[derive(Debug, Deserialize)]
struct FlareSolutionPayload {
    response: Option<String>,
    cookies: Option<Vec<FlareCookie>>,
    #[serde(rename = "userAgent")]
    user_agent: Option<String>,
    url: Option<String>,
    status: Option<u16>,
}

/// Cookie retornado pelo FlareSolverr.
#[derive(Debug, Deserialize)]
struct FlareCookie {
    name: String,
    value: String,
    #[allow(dead_code)]
    domain: Option<String>,
}

/// Busca o conteúdo de uma URL via FlareSolverr.
///
/// Fluxo:
/// 1. POST `{solver_url}/v1` com `{ cmd: "request.get", url, maxTimeout }`
/// 2. Extrai `solution.response`, `solution.cookies[]`, `solution.userAgent`, `solution.url`
/// 3. Se status != 200 ou response vazio → `Err(FlareError::SolverFailed)`
///
/// # Argumentos
/// - `url`: URL alvo a ser resolvida pelo FlareSolverr
/// - `solver_url`: URL base do FlareSolverr (default: `http://127.0.0.1:8191`)
/// - `timeout_ms`: Timeout máximo em millisegundos (default: 55_000)
pub async fn fetch_text_via_flare(
    url: &str,
    solver_url: &str,
    timeout_ms: u64,
) -> Result<FlareSolution, FlareError> {
    let client = Client::new();
    let endpoint = format!("{}/v1", solver_url.trim_end_matches('/'));

    let request_body = FlareRequest {
        cmd: "request.get".to_string(),
        url: url.to_string(),
        max_timeout: timeout_ms,
    };

    // POST ao FlareSolverr
    let http_result = client
        .post(&endpoint)
        .json(&request_body)
        .timeout(std::time::Duration::from_millis(timeout_ms + 10_000))
        .send()
        .await;

    let http_response = match http_result {
        Ok(resp) => resp,
        Err(e) => {
            return Err(FlareError::SolverNotReachable(format!(
                "POST {} falhou: {}",
                endpoint, e
            )));
        }
    };

    let status = http_response.status().as_u16();

    // Lê o body da resposta
    let body_text = match http_response.text().await {
        Ok(b) => b,
        Err(e) => {
            return Err(FlareError::SolverNotReachable(format!(
                "leitura do body falhou: {}",
                e
            )));
        }
    };

    // Parse do JSON de resposta
    let flare_resp: FlareResponse = match serde_json::from_str(&body_text) {
        Ok(r) => r,
        Err(e) => {
            return Err(FlareError::SolverFailed {
                status,
                body: format!("JSON inválido do FlareSolverr: {} — body: {}", e, body_text),
            });
        }
    };

    // Verifica status da solução
    let solution = match flare_resp.solution {
        Some(s) => s,
        None => {
            return Err(FlareError::SolverFailed {
                status,
                body: format!(
                    "Sem solution na resposta: status={:?}, message={:?}",
                    flare_resp.status, flare_resp.message
                ),
            });
        }
    };

    // Verifica se o response (HTML) está presente
    let response_body = match solution.response {
        Some(b) if !b.is_empty() => b,
        _ => {
            return Err(FlareError::SolverFailed {
                status: solution.status.unwrap_or(status),
                body: "solution.response vazio ou ausente".to_string(),
            });
        }
    };

    // Verifica status da solução interna
    let solution_status = solution.status.unwrap_or(200);
    if solution_status != 200 {
        return Err(FlareError::SolverFailed {
            status: solution_status,
            body: format!("solution.status = {} (esperado 200)", solution_status),
        });
    }

    // Extrai cookies
    let cookies: Vec<(String, String)> = solution
        .cookies
        .unwrap_or_default()
        .into_iter()
        .map(|c| (c.name, c.value))
        .collect();

    Ok(FlareSolution {
        body: response_body,
        cookies,
        user_agent: solution.user_agent.unwrap_or_default(),
        final_url: solution.url.unwrap_or_else(|| url.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flare_request_serializes_correctly() {
        let req = FlareRequest {
            cmd: "request.get".to_string(),
            url: "https://example.com".to_string(),
            max_timeout: 55_000,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"cmd\":\"request.get\""));
        assert!(json.contains("\"url\":\"https://example.com\""));
        // O FlareSolverr espera camelCase (`maxTimeout`), como o TS (resolvers/flare.ts).
        assert!(json.contains("\"maxTimeout\":55000"));
    }

    #[test]
    fn flare_response_deserializes_full() {
        let json = r#"{
            "status": "ok",
            "message": "ok",
            "solution": {
                "response": "<html>ok</html>",
                "cookies": [{"name": "cf_clearance", "value": "abc", "domain": ".example.com"}],
                "userAgent": "Mozilla/5.0",
                "url": "https://example.com/final",
                "status": 200
            }
        }"#;
        let resp: FlareResponse = serde_json::from_str(json).unwrap();
        assert!(resp.solution.is_some());
        let sol = resp.solution.unwrap();
        assert_eq!(sol.response.unwrap(), "<html>ok</html>");
        assert_eq!(sol.cookies.unwrap().len(), 1);
        assert_eq!(sol.user_agent.unwrap(), "Mozilla/5.0");
        assert_eq!(sol.status.unwrap(), 200);
    }

    #[test]
    fn flare_response_deserializes_without_solution() {
        let json = r#"{"status": "error", "message": "timeout"}"#;
        let resp: FlareResponse = serde_json::from_str(json).unwrap();
        assert!(resp.solution.is_none());
    }

    #[test]
    fn flare_cookie_extracts_name_value() {
        let json = r#"{"name": "cf_clearance", "value": "xyz123", "domain": ".test.com"}"#;
        let cookie: FlareCookie = serde_json::from_str(json).unwrap();
        assert_eq!(cookie.name, "cf_clearance");
        assert_eq!(cookie.value, "xyz123");
    }
}
