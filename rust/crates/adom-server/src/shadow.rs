//! Sombra de `/stream` (`ROUTES_RUST=stream-shadow`).
//!
//! Contrato `docs/rust-stream-contract.md` §9.1: o Node responde ao cliente; o
//! Rust observa em `tokio::spawn` e **só compara**. Não escreve cache, não
//! chama debrid, não devolve nada ao cliente. O remontador usa
//! [`crate::stream::build_shadow_orchestrator`] (`shadow_mode` +
//! `NoDebridFactory` + `NoopTailEffects`).
//!
//! Gate atual: comparação por **identidade** (§9.3 parcial — `infoHash` / URL
//! relativa mascarando host+sig+config / `externalUrl`, ordem via `BTreeSet`).
//! Isso **não** autoriza o corte por rota do §9.4 sozinho (faltam cobertura,
//! janela ≥72 h, distribuição, corpus e2e e revisor humano).
//!
//! Sem token/env para remontar: **pula** — não incrementa `compared` nem
//! acusa `divergence` (falso positivo envenenaria o critério de corte).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_search::orchestrator::{NodeRoutes, Orchestrator, StreamRequest};
use adom_search::{parse_stream_path, relative_url, reply_deadline_ms, StreamItem, StreamResponse};
use bytes::Bytes;
use http::StatusCode;

/// Nomes do contrato `docs/rust-stream-contract.md` §9.2.
pub const COMPARED: &str = "stream.shadow.compared";
pub const DIVERGENCE: &str = "stream.shadow.divergence";
pub const DIVERGENCE_ITEMS: &str = "stream.shadow.divergence.items";
pub const TIMEOUT: &str = "stream.shadow.timeout";
pub const ERROR: &str = "stream.shadow.error";

const KEYS: &[&str] = &[COMPARED, DIVERGENCE, DIVERGENCE_ITEMS, TIMEOUT, ERROR];

/// Contadores da sombra. Sempre expõe as chaves do §9 (zeradas até haver
/// observação). `Clone` barato via `Arc` para o `tokio::spawn`.
#[derive(Clone, Default)]
pub struct ShadowMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl ShadowMetrics {
    pub fn new() -> Self {
        let metrics = Self::default();
        let _ = metrics.snapshot();
        metrics
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        for key in KEYS {
            guard.entry((*key).to_string()).or_insert(0);
        }
        guard.clone()
    }

    pub fn inc(&self, key: &str, by: u64) {
        if by == 0 {
            return;
        }
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(key.to_string()).or_insert(0);
        *entry = (*entry).saturating_add(by);
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> u64 {
        self.snapshot().get(key).copied().unwrap_or(0)
    }
}

/// Remontador opcional: só existe com `JACKETT_TEST_TOKEN` (e base loopback).
pub type ShadowRemount = Orchestrator;

/// Monta o orquestrador **compare-only** ligado às rotas internas do Node.
/// `None` sem token — a sombra então **não compara** (evita falso `divergence`).
///
/// Usa [`crate::stream::build_shadow_orchestrator`] (sem debrid / SWR / tail).
pub fn remount_from_env() -> Option<ShadowRemount> {
    NodeRoutes::from_env()?;
    Some(crate::stream::build_shadow_orchestrator())
}

/// `true` para `/stream/<type>/<id>.json` e `/<config>/stream/<type>/<id>.json`.
pub fn is_stream_path(path: &str) -> bool {
    parse_stream_path(path).is_some()
}

/// Contexto da requisição capturado no proxy (path + UA + origin).
#[derive(Debug, Clone)]
pub struct ShadowRequest {
    pub path: String,
    pub user_agent: Option<String>,
    pub origin: Option<String>,
}

/// Observação fire-and-forget do corpo que o Node devolveu.
///
/// - Sem `remount`: pula (sem `compared` / sem `divergence`).
/// - Body inválido / path inválido / falha do orquestrador: `error` (nunca
///   `divergence`).
/// - Prazo estourado: `timeout`.
/// - Remontagem ok: sempre `compared`; `divergence`/`items` só se os conjuntos
///   de identidade diferirem.
pub async fn observe_node_response(
    status: StatusCode,
    body: Bytes,
    req: ShadowRequest,
    metrics: ShadowMetrics,
    remount: Option<ShadowRemount>,
) {
    let Some(orch) = remount else {
        return;
    };
    debug_assert!(
        orch.shadow_mode(),
        "sombra deve usar build_shadow_orchestrator (shadow_mode)"
    );
    if !status.is_success() {
        // `/stream` quase sempre é 200; não-sucesso não entra no denominador.
        return;
    }

    let Some(stream_req) = StreamRequest::from_path(
        &req.path,
        req.user_agent.as_deref(),
        req.origin.as_deref(),
        None,
    ) else {
        metrics.inc(ERROR, 1);
        return;
    };

    let node = match parse_stream_body(&body) {
        Ok(parsed) => parsed,
        Err(()) => {
            metrics.inc(ERROR, 1);
            return;
        }
    };

    let reply_ms = reply_deadline_ms(
        req.user_agent.as_deref(),
        orch.config().stremio_reply_ms,
        orch.config().app_reply_ms,
    );
    let rust_body = match tokio::time::timeout(
        Duration::from_millis(reply_ms.saturating_add(500)),
        orch.handle(stream_req.clone()),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => {
            metrics.inc(TIMEOUT, 1);
            return;
        }
    };

    record_comparison(&node, &rust_body, stream_req.encoded.as_deref(), &metrics);
}

/// Compara duas respostas já montadas (testes e caminho do observe).
pub fn record_comparison(
    node: &StreamResponse,
    rust: &StreamResponse,
    config_segment: Option<&str>,
    metrics: &ShadowMetrics,
) {
    metrics.inc(COMPARED, 1);
    let left = identity_set(&node.streams, config_segment);
    let right = identity_set(&rust.streams, config_segment);
    let items = divergent_item_count(&left, &right);
    if items > 0 {
        metrics.inc(DIVERGENCE, 1);
        metrics.inc(DIVERGENCE_ITEMS, items);
    }
}

fn parse_stream_body(body: &[u8]) -> Result<StreamResponse, ()> {
    serde_json::from_slice(body).map_err(|_| ())
}

/// Identidades estáveis de uma lista (ordem fora do conjunto).
pub fn identity_set(streams: &[StreamItem], config_segment: Option<&str>) -> BTreeSet<String> {
    streams
        .iter()
        .map(|item| item_identity(item, config_segment))
        .collect()
}

fn item_identity(item: &StreamItem, config_segment: Option<&str>) -> String {
    if let Some(hash) = &item.info_hash {
        return format!("ih:{}", hash.to_ascii_lowercase());
    }
    if let Some(url) = &item.url {
        let masked = mask_url(url, config_segment);
        if let Some(hash) = resolve_hash(&masked) {
            return format!("resolve:{}", hash.to_ascii_lowercase());
        }
        return format!("url:{masked}");
    }
    if let Some(ext) = &item.external_url {
        return format!("ext:{}", mask_url(ext, config_segment));
    }
    "empty".to_string()
}

/// Host → path relativo; `sig` → `{{sig}}`; segmento de config → `{{config}}`.
pub fn mask_url(raw: &str, config_segment: Option<&str>) -> String {
    let mut text = relative_url(raw);
    if let Some(segment) = config_segment {
        let segment = segment.trim_matches('/');
        if !segment.is_empty() {
            text = text.replace(&format!("/{segment}/"), "/{{config}}/");
        }
    }
    mask_sig_param(&text)
}

fn resolve_hash(url: &str) -> Option<&str> {
    let rest = url.split("/resolve/").nth(1)?;
    let hash = rest.split(['?', '/', '#']).next().unwrap_or(rest);
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}

fn mask_sig_param(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'?' | b'&' => {
                out.push(bytes[index] as char);
                index += 1;
                let name_start = index;
                while index < bytes.len() && !matches!(bytes[index], b'=' | b'&' | b'#') {
                    index += 1;
                }
                let name = &text[name_start..index];
                if name == "sig" && bytes.get(index) == Some(&b'=') {
                    out.push_str("sig={{sig}}");
                    index += 1; // '='
                    while index < bytes.len() && !matches!(bytes[index], b'&' | b'#') {
                        index += 1;
                    }
                } else {
                    out.push_str(&text[name_start..index]);
                }
            }
            _ => {
                out.push(bytes[index] as char);
                index += 1;
            }
        }
    }
    out
}

/// Magnitude §9.2: quantos ids estão só de um lado (diferença simétrica).
pub fn divergent_item_count(node: &BTreeSet<String>, rust: &BTreeSet<String>) -> u64 {
    node.symmetric_difference(rust).count() as u64
}

#[cfg(test)]
mod compare_tests {
    use super::*;
    use std::sync::Arc;

    use adom_search::orchestrator::{NoDebridFactory, OrchestratorConfig};
    use adom_search::MemorySwrStore;

    fn item_ih(hash: &str) -> StreamItem {
        StreamItem {
            info_hash: Some(hash.to_string()),
            ..StreamItem::default()
        }
    }

    fn item_url(url: &str) -> StreamItem {
        StreamItem {
            url: Some(url.to_string()),
            ..StreamItem::default()
        }
    }

    #[test]
    fn mascara_host_sig_e_config() {
        let raw = "https://powermovie.net/eyJ4IjoxfQ/resolve/abc123def?sig=DEADBEEF&x=1";
        assert_eq!(
            mask_url(raw, Some("eyJ4IjoxfQ")),
            "/{{config}}/resolve/abc123def?sig={{sig}}&x=1"
        );
    }

    #[test]
    fn identidade_ignora_ordem_e_host() {
        let a = vec![
            item_url("https://a.test/resolve/AAAA?sig=1"),
            item_ih("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ];
        let b = vec![
            item_ih("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
            item_url("http://outro.host/resolve/AAAA?sig=ZZZ"),
        ];
        assert_eq!(identity_set(&a, None), identity_set(&b, None));
        assert_eq!(
            divergent_item_count(&identity_set(&a, None), &identity_set(&b, None)),
            0
        );
    }

    #[test]
    fn divergence_conta_itens_da_diferenca_simetrica() {
        let metrics = ShadowMetrics::new();
        let node = StreamResponse {
            streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
            cache_max_age: 0,
        };
        let rust = StreamResponse {
            streams: vec![item_ih("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
            cache_max_age: 0,
        };
        record_comparison(&node, &rust, None, &metrics);
        assert_eq!(metrics.get(COMPARED), 1);
        assert_eq!(metrics.get(DIVERGENCE), 1);
        assert_eq!(metrics.get(DIVERGENCE_ITEMS), 2);
    }

    #[test]
    fn paridade_nao_marca_divergence() {
        let metrics = ShadowMetrics::new();
        let body = StreamResponse {
            streams: vec![item_ih("cccccccccccccccccccccccccccccccccccccccc")],
            cache_max_age: 900,
        };
        record_comparison(&body, &body, None, &metrics);
        assert_eq!(metrics.get(COMPARED), 1);
        assert_eq!(metrics.get(DIVERGENCE), 0);
        assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);
    }

    #[test]
    fn shadow_orchestrator_e_compare_only_sem_debrid() {
        let orch = crate::stream::build_shadow_orchestrator();
        assert!(orch.shadow_mode(), "sombra exige shadow_mode");
    }

    #[tokio::test]
    async fn observe_sem_remount_ainda_pula() {
        let metrics = ShadowMetrics::new();
        let body = serde_json::to_vec(&StreamResponse {
            streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
            cache_max_age: 0,
        })
        .unwrap();
        observe_node_response(
            StatusCode::OK,
            Bytes::from(body),
            ShadowRequest {
                path: "/stream/movie/tt0133093.json".into(),
                user_agent: Some("Stremio/1.6".into()),
                origin: None,
            },
            metrics.clone(),
            None,
        )
        .await;
        assert_eq!(metrics.get(COMPARED), 0);
        assert_eq!(metrics.get(DIVERGENCE), 0);
        assert_eq!(metrics.get(ERROR), 0);
    }

    #[tokio::test]
    async fn observe_com_remount_shadow_sobe_compared_sem_debrid() {
        let metrics = ShadowMetrics::new();
        // Collector default falha → lista/aviso; sem AdapterDebridFactory.
        let orch = Orchestrator::new(
            OrchestratorConfig::default(),
            Arc::new(MemorySwrStore::new()),
        )
        .with_shadow_mode(true)
        .with_debrid(Arc::new(NoDebridFactory));
        assert!(orch.shadow_mode());

        let body = serde_json::to_vec(&StreamResponse {
            streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
            cache_max_age: 0,
        })
        .unwrap();
        observe_node_response(
            StatusCode::OK,
            Bytes::from(body),
            ShadowRequest {
                path: "/stream/movie/tt0133093.json".into(),
                user_agent: Some("Stremio/1.6".into()),
                origin: None,
            },
            metrics.clone(),
            Some(orch),
        )
        .await;
        assert_eq!(metrics.get(COMPARED), 1);
        // Corpos diferem (Node com ih vs aviso/vazio do stub) → divergence ok;
        // o que importa: compared sobe e o caminho não panica sem debrid.
        assert_eq!(metrics.get(TIMEOUT), 0);
        assert_eq!(metrics.get(ERROR), 0);
    }
}
