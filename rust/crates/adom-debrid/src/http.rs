//! Cliente HTTP do debrid. O prazo é absoluto por chamada (o `timeout` do
//! `json()` em `common.ts`). `abort_safe` existe para o upload do AllDebrid:
//! largar a espera da busca não cancela a requisição — ela já foi enviada.

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::error::DebridError;

pub const USER_AGENT: &str = "stremio-adom/1.0";

#[derive(Clone)]
pub struct HttpClient {
    inner: reqwest::Client,
}

pub struct Call {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
    pub abort_safe: bool,
}

impl HttpClient {
    pub fn new() -> Result<Self, DebridError> {
        Self::with_pool_idle(None)
    }

    /// Cliente com prazo de ociosidade do pool escolhido pelo chamador.
    ///
    /// O default (sem prazo) serve às APIs do debrid, onde o handshake TLS é
    /// caro e o keep-alive do servidor é longo. As rotas INTERNAS em loopback
    /// passam um prazo curto: o http server do Node fecha a conexão ociosa em
    /// 5 s e o pool do reqwest guardaria 90 s — o POST seguinte cairia numa
    /// conexão morta, como o 502 do proxy reverso do painel.
    pub fn with_pool_idle(idle: Option<Duration>) -> Result<Self, DebridError> {
        let mut builder = reqwest::Client::builder().user_agent(USER_AGENT);
        if let Some(idle) = idle {
            builder = builder.pool_idle_timeout(idle);
        }
        let inner = builder
            .build()
            .map_err(|err| DebridError::other(format!("cliente http: {err}")))?;
        Ok(Self { inner })
    }

    /// JSON da resposta, ou `None` em 204 / corpo vazio. Não repete: o retry
    /// de cada serviço fica no adaptador, como no TypeScript.
    pub async fn json(&self, call: Call) -> Result<Option<Value>, DebridError> {
        if call.abort_safe {
            let (tx, rx) = oneshot::channel();
            let client = self.inner.clone();
            tokio::spawn(async move {
                let result = execute(&client, &call).await;
                let _ = tx.send(result);
            });
            return rx
                .await
                .map_err(|_| DebridError::other("chamada abort_safe sem resposta"))?;
        }
        execute(&self.inner, &call).await
    }
}

async fn execute(client: &reqwest::Client, call: &Call) -> Result<Option<Value>, DebridError> {
    let mut req = client.request(call.method.clone(), &call.url);
    req = req.header("Accept", "application/json");
    req = req.header("User-Agent", USER_AGENT);
    for (name, value) in &call.headers {
        req = req.header(name.as_str(), value.as_str());
    }
    if let Some(body) = &call.body {
        req = req.body(body.clone());
    }
    req = req.timeout(call.timeout);
    let response = req
        .send()
        .await
        .map_err(|err| DebridError::other(format!("rede: {err}")))?;
    let status = response.status().as_u16();
    if status == 204 {
        return Ok(None);
    }
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !(200..300).contains(&status) {
        let text = response.text().await.unwrap_or_default();
        let detail: String = text.chars().take(200).collect();
        let message = if detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status} — {detail}")
        };
        return Err(DebridError::from_http(
            status,
            message,
            retry_after.as_deref(),
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|err| DebridError::other(format!("corpo: {err}")))?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|err| DebridError::other(format!("json: {err}")))
}

#[cfg(test)]
#[path = "http_tests.rs"]
mod http_tests;
