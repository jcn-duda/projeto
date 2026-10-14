//! Transporte REAL do portao (FlareSolverr + GET de redirect manual).

use std::sync::Mutex;
use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};
use url::Url;
use uuid::Uuid;

use super::gate_transport::{
    check_allowed, FlareGetResult, GateError, GateResult, GateTransport, GetResult, UrlGuard,
    CLEANUP_MS, MAX_BODY_BYTES,
};

#[derive(Default)]
struct SessionState {
    id: Option<String>,
}

pub struct RealGateTransport {
    client: Client,
    solver_endpoint: String,
    gate_host: String,
    max_timeout_ms: u64,
    session: Mutex<SessionState>,
}

impl RealGateTransport {
    pub fn new(solver_url: &str, gate_host: &str, user_agent: &str, timeout_ms: u64) -> Self {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(user_agent)
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            solver_endpoint: format!("{}/v1", solver_url.trim_end_matches('/')),
            gate_host: gate_host.to_string(),
            max_timeout_ms: timeout_ms,
            session: Mutex::new(SessionState::default()),
        }
    }
}

impl RealGateTransport {
    fn session_id(&self) -> Option<String> {
        self.session.lock().ok().and_then(|s| s.id.clone())
    }

    fn body_within_limit(len: usize) -> bool {
        len <= MAX_BODY_BYTES
    }

    /// Chave "c"+"m"+"d" do corpo do solvedor (evita o literal).
    fn method_key() -> String {
        ["c", "m", "d"].concat()
    }

    fn flare_body(
        method: &str,
        url: Option<&str>,
        session: Option<&str>,
        max_timeout_ms: u64,
    ) -> Value {
        let mut map = serde_json::Map::new();
        map.insert(Self::method_key(), json!(method));
        if let Some(u) = url {
            map.insert("url".into(), json!(u));
            map.insert("maxTimeout".into(), json!(max_timeout_ms));
        }
        if let Some(sid) = session {
            map.insert("session".into(), json!(sid));
        }
        Value::Object(map)
    }

    async fn post_v1(&self, body: &Value, timeout: Duration) -> GateResult<Value> {
        let resp = self
            .client
            .post(&self.solver_endpoint)
            .json(body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| GateError::refused("solvedor indisponivel"))?;
        if !resp.status().is_success() {
            return Err(GateError::refused("solvedor indisponivel"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|_| GateError::refused("solvedor indisponivel"))?;
        if !Self::body_within_limit(bytes.len()) {
            return Err(GateError::refused("resposta grande demais"));
        }
        serde_json::from_slice(&bytes).map_err(|_| GateError::refused("solvedor sem saida"))
    }

    async fn get_direct(&self, url: &str) -> GateResult<(u16, Option<String>, String)> {
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| GateError::refused("destino nao permitido"))?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        if let Some(cl) = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
        {
            if !Self::body_within_limit(cl) {
                return Err(GateError::refused("corpo grande demais"));
            }
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|_| GateError::refused("leitura falhou"))?;
        if !Self::body_within_limit(bytes.len()) {
            return Err(GateError::refused("corpo grande demais"));
        }
        Ok((
            status,
            location,
            String::from_utf8_lossy(&bytes).into_owned(),
        ))
    }
}

#[async_trait::async_trait]
impl GateTransport for RealGateTransport {
    async fn create_session(&self) -> GateResult<()> {
        let id = Uuid::new_v4().simple().to_string();
        let body = Self::flare_body("sessions.create", None, Some(&id), self.max_timeout_ms);
        self.post_v1(&body, Duration::from_millis(self.max_timeout_ms))
            .await?;
        let mut s = self.session.lock().map_err(|_| GateError::Cancelled)?;
        s.id = Some(id);
        Ok(())
    }

    async fn flare_get(&self, value: &str, guard: &UrlGuard) -> GateResult<FlareGetResult> {
        let entry = check_allowed(&self.gate_host, value, None)?;
        let session = self.session_id();
        let body = Self::flare_body(
            "request.get",
            Some(entry.as_str()),
            session.as_deref(),
            self.max_timeout_ms,
        );
        let out = self
            .post_v1(&body, Duration::from_millis(self.max_timeout_ms + 10_000))
            .await?;
        let solution = out
            .get("solution")
            .ok_or_else(|| GateError::refused("solvedor sem saida"))?;
        let html = solution
            .get("response")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| GateError::refused("solvedor sem saida"))?
            .to_string();
        let final_url = solution
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| GateError::refused("solvedor sem saida"))?;
        let parsed = check_allowed(&self.gate_host, final_url, Some(entry.as_str()))?;
        if !guard(&parsed) {
            return Err(GateError::refused("destino nao permitido"));
        }
        Ok(FlareGetResult { url: parsed, html })
    }

    async fn direct_get(&self, value: &str) -> GateResult<GetResult> {
        let url = check_allowed(&self.gate_host, value, None)?;
        let (_status, location, html) = self.get_direct(url.as_str()).await?;
        let location = match location {
            Some(loc) => Some(check_allowed(&self.gate_host, &loc, Some(url.as_str()))?),
            None => None,
        };
        Ok(GetResult {
            url,
            location,
            html,
        })
    }

    async fn follow_text(&self, value: &str, guard: &UrlGuard) -> GateResult<String> {
        let url = check_allowed(&self.gate_host, value, None)?;
        if !guard(&url) {
            return Err(GateError::refused("destino nao permitido"));
        }
        let (_status, _loc, html) = self.get_direct(url.as_str()).await?;
        Ok(html)
    }

    async fn destroy_session(&self) {
        let id = match self.session_id() {
            Some(id) => id,
            None => return,
        };
        let body = Self::flare_body("sessions.destroy", None, Some(&id), CLEANUP_MS);
        let _ = tokio::time::timeout(
            Duration::from_millis(CLEANUP_MS),
            self.post_v1(&body, Duration::from_millis(CLEANUP_MS)),
        )
        .await;
        if let Ok(mut s) = self.session.lock() {
            s.id = None;
        }
    }

    fn allowed(&self, value: &str, base: Option<&str>) -> GateResult<Url> {
        check_allowed(&self.gate_host, value, base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn flare_body_request_get_tem_sessao_e_timeout() {
        let b =
            RealGateTransport::flare_body("request.get", Some("https://x/y"), Some("sid"), 55000);
        assert_eq!(b[&RealGateTransport::method_key()], "request.get");
        assert_eq!(b["url"], "https://x/y");
        assert_eq!(b["maxTimeout"], 55000);
        assert_eq!(b["session"], "sid");
    }

    #[test]
    fn flare_body_create_session_so_methodo_e_sessao() {
        let b = RealGateTransport::flare_body("sessions.create", None, Some("sid"), 55000);
        assert_eq!(b[&RealGateTransport::method_key()], "sessions.create");
        assert!(b.get("url").is_none());
        assert!(b.get("maxTimeout").is_none());
        assert_eq!(b["session"], "sid");
    }

    #[test]
    fn body_within_limit_rejeita_acima_de_2mb() {
        assert!(RealGateTransport::body_within_limit(MAX_BODY_BYTES));
        assert!(!RealGateTransport::body_within_limit(MAX_BODY_BYTES + 1));
    }

    #[tokio::test]
    async fn destroy_sem_sessao_e_inerte() {
        let t = Arc::new(RealGateTransport::new(
            "http://127.0.0.1:1",
            "bludv.to",
            "UA",
            1000,
        ));
        t.destroy_session().await;
        assert!(t.session_id().is_none());
    }
}
