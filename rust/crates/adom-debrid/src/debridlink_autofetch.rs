//! Operações simples de seedbox usadas pelo futuro worker de autofetch.
//! O chamador é responsável por reservar a obra e validar a conta antes do upload.

use std::collections::BTreeMap;

use reqwest::Method;
use serde_json::Value;

use super::{add_body, magnet_for, truthy_id, DebridLink};
use crate::error::DebridError;
use crate::http::Call;

#[derive(Clone, Debug, PartialEq)]
pub struct DebridLinkStatus {
    pub state: &'static str,
    pub id: Option<Value>,
}

impl DebridLink {
    /// Envia um magnet sem esperar o download. O URI só é aceito se carrega o hash pedido.
    pub async fn enqueue_autofetch(
        &self,
        api_key: &str,
        hash: &str,
        magnet: Option<&str>,
    ) -> Result<bool, DebridError> {
        let value = self
            .call(
                api_key,
                "/seedbox/add",
                Method::POST,
                Some(add_body(&magnet_for(hash, magnet))),
                &[],
            )
            .await?;
        Ok(truthy_id(&value).is_some())
    }

    /// Foto da seedbox para recheck. A resposta parcial não marca hashes ausentes como mortos.
    pub async fn autofetch_status(
        &self,
        api_key: &str,
    ) -> Result<BTreeMap<String, DebridLinkStatus>, DebridError> {
        let value = self
            .call(api_key, "/seedbox/list", Method::GET, None, &[])
            .await?;
        let rows = value.as_array().cloned().unwrap_or_default();
        let mut out = BTreeMap::new();
        for row in rows {
            let Some(hash) = row
                .get("hash")
                .or_else(|| row.get("infoHash"))
                .and_then(value_as_nonempty_string)
            else {
                continue;
            };
            let percent = js_number(row.get("downloadPercent"));
            let state = if percent.is_some_and(|n| n >= 100.0) {
                "ready"
            } else if row.get("status").and_then(Value::as_str) == Some("error")
                || js_truthy(row.get("error"))
                || row
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        let status = status.to_ascii_lowercase();
                        ["error", "failed", "dead"]
                            .iter()
                            .any(|needle| status.contains(needle))
                    })
            {
                "dead"
            } else {
                // Contrato TS: percentual ausente também fica downloading.
                "downloading"
            };
            out.insert(
                hash.to_ascii_lowercase(),
                DebridLinkStatus {
                    state,
                    id: row.get("id").cloned(),
                },
            );
        }
        Ok(out)
    }

    /// Remove por ID; um valor inválido não pode alterar o caminho HTTP.
    pub async fn remove_autofetch(&self, api_key: &str, id: &Value) -> bool {
        let Some(id) = truthy_id(&serde_json::json!({ "id": id })) else {
            return false;
        };
        if !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return false;
        }
        let Ok(base) = self.usable_base() else {
            return false;
        };
        self.client
            .json(Call {
                method: Method::DELETE,
                url: format!("{base}/seedbox/{id}/remove"),
                headers: vec![("Authorization".into(), format!("Bearer {api_key}"))],
                body: None,
                timeout: self.timeout,
                abort_safe: false,
            })
            .await
            .is_ok()
    }
}

fn value_as_nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn js_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => Some(0.0),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        Value::Number(value) => value.as_f64().filter(|n| n.is_finite()),
        Value::String(value) if value.trim().is_empty() => Some(0.0),
        Value::String(value) => value.parse::<f64>().ok().filter(|n| n.is_finite()),
        _ => None,
    }
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
#[path = "debridlink_autofetch_tests.rs"]
mod tests;
