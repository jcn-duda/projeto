//! Transporte HTTP com `reqwest` (tokio): teto POR REQUISIÇÃO e prazo ABSOLUTO
//! do caller.
//!
//! Contrato de falha: nada aqui devolve `Err` para o chamador. Rede, timeout,
//! status não-2xx e JSON inválido viram [`JsonFetch`] com `transient`/`status`
//! preenchidos — os clientes decidem o TTL do miss e devolvem `None` honesto.
//! Uma busca nunca cai por causa do Cinemeta ou do TMDB.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde_json::Value;

use crate::redact::redact_secrets;

/// Relógio do crate em epoch ms (o mesmo `Date.now()` do TS).
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

/// O que sobra até `deadline_at_ms`. `None` = já venceu, nem vai à rede.
pub(crate) fn remaining(deadline_at_ms: i64) -> Option<Duration> {
    let left = deadline_at_ms.saturating_sub(now_ms());
    (left > 0).then(|| Duration::from_millis(left as u64))
}

/// Monta a URL a partir da base + segmentos já percent-encoded pelo `url`.
pub(crate) fn url_with_path(base: &str, segments: &[&str]) -> Option<Url> {
    let mut url = match Url::parse(base) {
        Ok(url) => url,
        Err(err) => {
            eprintln!("[sources] base inválida {base:?}: {err}");
            return None;
        }
    };
    {
        let mut path = match url.path_segments_mut() {
            Ok(path) => path,
            Err(()) => {
                eprintln!("[sources] base sem path navegável: {base:?}");
                return None;
            }
        };
        for segment in segments {
            path.push(segment);
        }
    }
    Some(url)
}

/// Anexa query string (`api_key`, `language`, `external_source`).
pub(crate) fn with_query(mut url: Url, pairs: &[(&str, &str)]) -> Url {
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url
}

/// Resultado de um GET JSON. `data: None` cobre status não-2xx, timeout e JSON
/// inválido; `transient` decide o TTL do miss.
#[derive(Debug, Clone)]
pub(crate) struct JsonFetch {
    /// Corpo já parseado. `None` em status não-2xx, timeout ou JSON inválido.
    pub data: Option<Value>,
    /// Falha que volta sozinha (rede/timeout/429/5xx/JSON inválido): NÃO é
    /// "a API não conhece" e não pode congelar pelo TTL autoritativo.
    pub transient: bool,
}

impl JsonFetch {
    fn failed() -> Self {
        Self {
            data: None,
            transient: true,
        }
    }

    /// Resposta autoritativa: 2xx com objeto JSON.
    pub(crate) fn ok(&self) -> bool {
        self.data.is_some() && !self.transient
    }
}

/// Cliente HTTP compartilhado pelos dois clientes (mesmo `User-Agent`).
#[derive(Clone)]
pub(crate) struct Http {
    client: Client,
}

impl Http {
    pub(crate) fn new(user_agent: &str) -> Result<Self, String> {
        let mut builder = Client::builder();
        let agent = user_agent.trim();
        if !agent.is_empty() {
            builder = builder.user_agent(agent);
        }
        let client = builder
            .build()
            .map_err(|err| format!("cliente HTTP: {err}"))?;
        Ok(Self { client })
    }

    /// GET JSON sob `min(prazo absoluto, teto por requisição)`.
    ///
    /// O teto por requisição cobre conexão + cabeçalhos + corpo (reqwest); o
    /// `timeout` externo garante que o prazo ABSOLUTO do caller vale mesmo se o
    /// teto configurado for maior que o que sobrou.
    pub(crate) async fn get_json(
        &self,
        url: Url,
        deadline_at_ms: i64,
        request_timeout_ms: u64,
        label: &str,
    ) -> JsonFetch {
        let Some(budget) = remaining(deadline_at_ms) else {
            eprintln!("[sources] {label}: prazo esgotado (sem requisição)");
            return JsonFetch::failed();
        };

        let request = self.client.get(url).header(ACCEPT, "application/json");
        let request = if request_timeout_ms > 0 {
            request.timeout(Duration::from_millis(request_timeout_ms))
        } else {
            request
        };

        let exchange = async move {
            let response = request.send().await.map_err(|err| err.to_string())?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|err| err.to_string())?;
            Ok::<(u16, Vec<u8>), String>((status, bytes.to_vec()))
        };

        match tokio::time::timeout(budget, exchange).await {
            Ok(Ok((status, bytes))) => {
                if !(200..300).contains(&status) {
                    // 429/5xx são transitórios; 404 (e outros 4xx) são
                    // autoritativos, como no `isTransientFailure` do TS.
                    let transient = status == 429 || status >= 500;
                    eprintln!("[sources] {label}: HTTP {status}");
                    return JsonFetch {
                        data: None,
                        transient,
                    };
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(value) if value.is_object() => JsonFetch {
                        data: Some(value),
                        transient: false,
                    },
                    // Corpo 2xx que não é objeto (null/array) não é "conhece":
                    // o TS estouraria ao ler `.meta`/`.movie_results` e cairia
                    // no catch transitório.
                    Ok(_) => {
                        eprintln!("[sources] {label}: corpo JSON não-objeto");
                        JsonFetch {
                            data: None,
                            transient: true,
                        }
                    }
                    Err(err) => {
                        eprintln!("[sources] {label}: JSON inválido: {err}");
                        JsonFetch {
                            data: None,
                            transient: true,
                        }
                    }
                }
            }
            Ok(Err(err)) => {
                eprintln!(
                    "[sources] {label}: falha de rede: {}",
                    redact_secrets(&err.to_string())
                );
                JsonFetch::failed()
            }
            Err(_) => {
                eprintln!("[sources] {label}: prazo absoluto estourado");
                JsonFetch::failed()
            }
        }
    }
}
