//! Catálogo de indexers do Jackett (F4.1) — porte de
//! `src/providers/jackett-catalog.ts`.
//!
//! Fatia SÓ DA COLETA: tipos (card + procedência), fetch Torznab
//! `t=indexers`, parse do XML e fallback do `.env`. Sem rota, sem cache e sem
//! fiação — quem chama (gateway/Node) é a fatia seguinte; por isso as funções
//! são `pub` da lib e recebem o [`reqwest::Client`] pronto (o mesmo do
//! [`super::client::JackettClient`], que já carrega o User-Agent
//! `stremio-adom/1.0` do TS).
//!
//! De propósito FORA desta fatia (segue no TS até a fiação): memo TTL/in-flight
//! do `load`, `syncAutoIndexers` (mutação da lista automática), `withVirtual`
//! (card virtual do Mico) e o `decorate` do status por indexer.
//!
//! Contratos espelhados do TS:
//!
//! - **Procedência honesta**: API respondeu → `live` MESMO com XML vazio (vazio
//!   é medição de Jackett vivo com zero indexers); sem `api_key` ou falha de
//!   rede → `fallback` do `.env` — ids presentes NÃO são medição.
//! - **`is_br` vem da MESMA lista que governa query pt-BR** (`pt_br_indexers`
//!   da [`JackettConfig`], recebida como parâmetro): inferir por idioma criaria
//!   classificação paralela e inconsistente.
//! - **Entidades**: uma passagem só (o `&#38;amp;` vira `&amp;`, não `&`) e
//!   entidade numérica inválida fica literal — por isso este porte NÃO reusa o
//!   `adom_core::decode_entities` (três passagens, tabela maior que as seis
//!   entidades nomeadas do TS).
//! - **A chave vai SÓ na query**: log de falha passa por `redact_secrets`
//!   (o `Display` do erro do reqwest carrega a URL inteira).

use std::sync::LazyLock;
use std::time::Duration;

use regex::{Captures, Regex};
use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde::Serialize;

use super::config::JackettConfig;
use super::config_file::is_safe_indexer_id;
use crate::redact::redact_secrets;

/// Card do catálogo (o `CatalogItem` do TS, sem o `virtual` do Mico — ele não
/// vem do Jackett e entra só na fiação).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCard {
    pub id: String,
    pub label: String,
    pub language: String,
    pub is_br: bool,
}

/// Procedência do catálogo (o `CatalogSource` do TS): `live` = API Jackett
/// respondeu; `fallback` = `.env` sem prova de rede.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Live,
    Fallback,
}

/// Catálogo coletado + de onde veio. `cards` vazio com `Live` é medição real
/// (XML vazio) — NÃO é ausência de coleta.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub cards: Vec<CatalogCard>,
    pub source: CatalogSource,
}

/// Entidades do `decodeXml` do TS: seis nomeadas + numéricas, UMA passagem.
fn decode_xml(text: &str) -> String {
    static ENTITY_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)&(?:#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);")
            .expect("regex de entidade XML")
    });
    ENTITY_RE
        .replace_all(text, |caps: &Captures| {
            let entity = &caps[0];
            let body = entity[1..entity.len() - 1].to_ascii_lowercase();
            if let Some(ch) = named_entity(&body) {
                return ch.to_string();
            }
            // Entidade numérica: inválida (overflow, surrogate, fora do plano)
            // fica LITERAL em vez de derrubar o catálogo (o `fromCodePoint` do
            // TS lançaria `RangeError`).
            let value = if let Some(hex) = body.strip_prefix("#x") {
                u32::from_str_radix(hex, 16).ok()
            } else {
                body[1..].parse::<u32>().ok()
            };
            value
                .and_then(char::from_u32)
                .map(|ch| ch.to_string())
                .unwrap_or_else(|| entity.to_string())
        })
        .into_owned()
}

fn named_entity(body: &str) -> Option<char> {
    match body {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => None,
    }
}

/// Atributos `name="value"`/`name='value'` da tag de abertura (o `attrs` do
/// TS): nome ASCII, valor até a PRÓPRIA aspa, chave em minúsculas, valor
/// decodificado.
fn parse_attrs(open_tag: &str) -> Vec<(String, String)> {
    static ATTR_RE: LazyLock<Regex> = LazyLock::new(|| {
        // O TS usa `(\["'])(.*?)\2` (backreference); o crate `regex` não
        // suporta backreference — a alternância abaixo casa a MESMA aspa dos
        // dois lados: o valor termina na primeira aspa do tipo aberto e não
        // cruza quebra de linha (o `.` do TS não cruza).
        Regex::new(r#"([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')"#)
            .expect("regex de atributo XML")
    });
    ATTR_RE
        .captures_iter(open_tag)
        .map(|caps| {
            let value = caps
                .get(2)
                .or_else(|| caps.get(3))
                .map(|m| m.as_str())
                .unwrap_or("");
            (caps[1].to_ascii_lowercase(), decode_xml(value))
        })
        .collect()
}

fn attr<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// `<name>…</name>` do corpo, sem tags internas — o `tag` do TS (strip → trim →
/// decode, nesta ordem).
fn tag_text(body: &str, name: &str) -> String {
    static STRIP_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<[^>]+>").expect("regex de tag XML"));
    let Ok(re) = Regex::new(&format!(r"(?is)<{name}(?-u:\b)[^>]*>(.*?)</{name}>")) else {
        return String::new();
    };
    let Some(caps) = re.captures(body) else {
        return String::new();
    };
    let plain = STRIP_RE.replace_all(&caps[1], "").into_owned();
    decode_xml(plain.trim())
}

/// Rótulo nascido do id — só o fallback do `.env` usa isto (no catálogo vivo o
/// rótulo é o `name` do próprio Jackett, que nunca carregou o sufixo).
/// `-cardigann` é detalhe de IMPLEMENTAÇÃO do card local e não pertence ao
/// rótulo que o usuário lê; o id permanece.
fn label_for(id: &str) -> String {
    let stem = if id.len() >= 10
        && id.is_char_boundary(id.len() - 10)
        && id[id.len() - 10..].eq_ignore_ascii_case("-cardigann")
    {
        &id[..id.len() - 10]
    } else {
        id
    };
    // `[-_]+` do TS: um separador (ou vários) vira UM espaço.
    let mut spaced = String::with_capacity(stem.len());
    let mut prev_sep = false;
    for ch in stem.chars() {
        if matches!(ch, '-' | '_') {
            if !prev_sep {
                spaced.push(' ');
            }
            prev_sep = true;
        } else {
            spaced.push(ch);
            prev_sep = false;
        }
    }
    // `\b\w` do TS: a primeira letra de cada palavra sobe (dígito e letra já
    // maiúscula ficam como estão).
    let mut label = String::with_capacity(spaced.len());
    let mut at_word_start = true;
    for ch in spaced.chars() {
        let is_word = ch.is_ascii_alphanumeric();
        if is_word && at_word_start {
            label.extend(ch.to_uppercase());
        } else {
            label.push(ch);
        }
        at_word_start = !is_word;
    }
    label
}

/// Catálogo vivo: parse do XML Torznab `t=indexers` — o `parseXml` do TS.
/// Ids inseguros saem fora (o id vai cru na URL Torznab).
pub fn parse_indexers_xml(xml: &str, pt_br: &[String]) -> Vec<CatalogCard> {
    static BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?is)<(?:indexer|torznab:indexer)(?-u:\b)([^>]*)>(.*?)</(?:indexer|torznab:indexer)>",
        )
        .expect("regex de bloco <indexer>")
    });
    let mut items = Vec::new();
    for caps in BLOCK_RE.captures_iter(xml) {
        let attrs = parse_attrs(&caps[1]);
        let body = &caps[2];
        // Cadeia `||` do TS: string vazia cai para o próximo candidato.
        let id = attr(&attrs, "id")
            .filter(|value| !value.is_empty())
            .or_else(|| attr(&attrs, "identifier").filter(|value| !value.is_empty()))
            .unwrap_or("")
            .to_ascii_lowercase();
        if !is_safe_indexer_id(&id) {
            continue;
        }
        let language = attr(&attrs, "language")
            .filter(|value| !value.is_empty())
            .or_else(|| attr(&attrs, "languages").filter(|value| !value.is_empty()))
            .map(str::to_string)
            .unwrap_or_else(|| tag_text(body, "language"));
        let label = attr(&attrs, "name")
            .filter(|value| !value.is_empty())
            .or_else(|| attr(&attrs, "label").filter(|value| !value.is_empty()))
            .map(str::to_string)
            .unwrap_or_else(|| {
                let title = tag_text(body, "title");
                if title.is_empty() {
                    id.clone()
                } else {
                    title
                }
            });
        items.push(CatalogCard {
            is_br: pt_br.iter().any(|br| br == &id),
            id,
            label,
            language,
        });
    }
    items
}

/// Fallback do `.env` (o `fallback()` do TS): união indexers/BR/slow, ids
/// seguros, dedupe preservando a primeira ocorrência, rótulo nascido do id.
/// Sem prova de rede — as listas vêm da [`JackettConfig`] (mesmas envs do Node).
pub fn fallback_catalog(
    indexers: &[String],
    pt_br: &[String],
    slow: &[String],
) -> Vec<CatalogCard> {
    let mut seen: Vec<&str> = Vec::new();
    indexers
        .iter()
        .chain(pt_br)
        .chain(slow)
        .map(String::as_str)
        .filter(|id| is_safe_indexer_id(id))
        .filter(|id| {
            if seen.contains(id) {
                return false;
            }
            seen.push(id);
            true
        })
        .map(|id| CatalogCard {
            language: if pt_br.iter().any(|br| br == id) {
                "pt-BR".to_string()
            } else {
                String::new()
            },
            is_br: pt_br.iter().any(|br| br == id),
            id: id.to_string(),
            label: label_for(id),
        })
        .collect()
}

fn fallback_snapshot(config: &JackettConfig) -> CatalogSnapshot {
    CatalogSnapshot {
        cards: fallback_catalog(
            &config.indexers,
            &config.pt_br_indexers,
            &config.slow_indexers,
        ),
        source: CatalogSource::Fallback,
    }
}

/// GET Torznab `t=indexers&configured=true` (espelho de :143-150 do TS):
/// Accept XML e timeout por requisição (o `AbortSignal.timeout` do TS). A
/// chave vai SÓ na query — erros de rede são redigidos antes do log.
async fn fetch_indexers_xml(http: &Client, config: &JackettConfig) -> Result<String, String> {
    let base = config.url.trim_end_matches('/');
    let raw = format!("{base}/api/v2.0/indexers/all/results/torznab/api");
    let mut url = Url::parse(&raw).map_err(|err| format!("URL Jackett inválida: {err}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("apikey", &config.api_key);
        pairs.append_pair("t", "indexers");
        pairs.append_pair("configured", "true");
    }
    let response = http
        .get(url)
        .header(ACCEPT, "application/xml,text/xml")
        .timeout(Duration::from_millis(config.indexer_timeout_ms))
        .send()
        .await
        .map_err(|err| redact_secrets(&err.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    response
        .text()
        .await
        .map_err(|err| redact_secrets(&err.to_string()))
}

/// Coleta do catálogo (o `load()` do TS sem cache): API respondeu → `live`
/// MESMO com XML vazio; sem chave ou falha de rede → fallback do `.env`.
pub async fn load_catalog(http: &Client, config: &JackettConfig) -> CatalogSnapshot {
    if !config.has_api_key() {
        return fallback_snapshot(config);
    }
    match fetch_indexers_xml(http, config).await {
        Ok(xml) => CatalogSnapshot {
            cards: parse_indexers_xml(&xml, &config.pt_br_indexers),
            source: CatalogSource::Live,
        },
        Err(err) => {
            eprintln!("[jackett] catálogo indisponível: {err}");
            fallback_snapshot(config)
        }
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
