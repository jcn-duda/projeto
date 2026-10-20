//! Peças de resposta do `/stream`: pedido, aviso e materialização do host.

use crate::cache::StreamsEntry;
use crate::contract::{StreamItem, StreamResponse};
use crate::list_builder::{apply_notice_origin, BuiltStream};
use crate::request::parse_stream_path;

use super::config::OrchestratorConfig;
use super::Orchestrator;

/// Aviso do corte externo — o MESMO texto do Node (`search-cache.ts:169-176`).
pub const NOTICE_SEARCHING: &str = "Procurando fontes — reabra em instantes";

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Relógio da busca (i64, porque o orçamento do núcleo é i64) → o `u64` que o
/// store SWR usa. Clamp em 0: relógio antes da época não gera instante válido.
pub(super) fn as_ms(now: i64) -> u64 {
    now.max(0) as u64
}

/// Requisição `/stream` já separada. `origin` é o host de QUEM PERGUNTA: entra
/// só na resposta, nunca no cache.
#[derive(Debug, Clone, Default)]
pub struct StreamRequest {
    pub kind: String,
    pub id: String,
    pub encoded: Option<String>,
    pub user_agent: Option<String>,
    /// `https://host[:port]` — o `origin()` do Node (já validado lá).
    pub origin: Option<String>,
    /// Relógio injetado (teste determinístico); `None` = agora.
    pub now_ms: Option<i64>,
}

impl StreamRequest {
    /// Açúcar para o servidor: caminho cru + UA + origin.
    ///
    /// `encoded` espelha a URL (`None` sem `/:userConfig`). O corpo das rotas
    /// internas usa [`crate::request::encoded_for_internal`] — nunca omitir/`""` lá.
    pub fn from_path(
        path: &str,
        user_agent: Option<&str>,
        origin: Option<&str>,
        now_ms: Option<i64>,
    ) -> Option<Self> {
        let target = parse_stream_path(path)?;
        Some(StreamRequest {
            kind: target.kind,
            id: target.id,
            encoded: target.encoded,
            user_agent: user_agent.map(str::to_string),
            origin: origin.map(|o| o.trim_end_matches('/').to_string()),
            now_ms,
        })
    }

    /// `/<config>` ou `""` — prefixo das URLs de play e do aviso (paridade Node:
    /// instalação sem segmento na URL não inventa `/e30`).
    pub fn prefix(&self) -> String {
        match &self.encoded {
            Some(encoded) if !encoded.is_empty() => format!("/{encoded}"),
            _ => String::new(),
        }
    }
}

/// Resultado de UMA busca computada (o que o coalescing compartilha).
#[derive(Debug, Clone)]
pub struct SearchOutcome {
    pub entry: StreamsEntry,
    /// A coleta não terminou dentro do orçamento.
    pub partial: bool,
    /// Nenhuma fonte respondeu (erro de collector): a lista vazia é "sem
    /// resposta", não "sem resultado".
    pub collect_failed: bool,
    /// A checagem do debrid precisa ser refeita (passe tardio).
    pub needs_debrid_refresh: bool,
    /// `cacheMaxAge` já decidido (`0` = revalidar).
    pub cache_max_age: u32,
}

pub(super) fn empty_response() -> StreamResponse {
    StreamResponse {
        streams: Vec::new(),
        cache_max_age: 0,
    }
}

pub(super) fn entry_streams(entry: &StreamsEntry, req: &StreamRequest) -> Vec<StreamItem> {
    let built: Vec<BuiltStream> = entry
        .streams
        .iter()
        .map(|item| BuiltStream {
            item: item.clone(),
            is_br: false,
            // A marca de aviso é da ENTRADA (o cache não guarda `notice` por
            // item); `applyNoticeOrigin` a converte em `externalUrl`.
            notice: entry.notice,
            cached: false,
            info_hash: None,
            dubbed: false,
            multi_work_admitted: false,
            p2p: false,
            multi_work: false,
        })
        .collect();
    apply_notice_origin(&built, req.origin.as_deref(), &req.prefix())
}

pub(super) fn notice_streams(req: &StreamRequest, text: &str) -> Vec<StreamItem> {
    let built = vec![BuiltStream {
        item: StreamItem {
            name: Some(text.to_string()),
            ..StreamItem::default()
        },
        is_br: false,
        notice: true,
        cached: false,
        info_hash: None,
        dubbed: false,
        multi_work_admitted: false,
        p2p: false,
        multi_work: false,
    }];
    apply_notice_origin(&built, req.origin.as_deref(), &req.prefix())
}

/// `cacheMaxAge` de uma entrada do cache (o `streamsNeedRevalidation` +
/// `onlyNotice` do handler): lista vazia, parcial, aviso ou debrid não
/// confiável NÃO pode ser cacheada pelo cliente.
pub(super) fn cache_max_age_for_entry(entry: &StreamsEntry, config: &OrchestratorConfig) -> u32 {
    let revalidation = entry.streams.is_empty()
        || entry.partial
        || entry.notice
        || entry.debrid_known == Some(false);
    if revalidation {
        0
    } else {
        config.cache_ttl.max(0) as u32
    }
}

impl Orchestrator {
    pub(super) fn respond_entry(
        &self,
        entry: &StreamsEntry,
        req: &StreamRequest,
    ) -> StreamResponse {
        StreamResponse {
            streams: entry_streams(entry, req),
            cache_max_age: cache_max_age_for_entry(entry, &self.config),
        }
    }

    pub(super) fn respond_outcome(
        &self,
        outcome: &SearchOutcome,
        req: &StreamRequest,
    ) -> StreamResponse {
        let mut streams = entry_streams(&outcome.entry, req);
        // Lista vazia + coleta ainda aberta (parcial) OU todas as fontes
        // falharam = "sem resposta", não "sem resultado". O corte externo
        // (`timeout`) já devolve NOTICE_SEARCHING; este ramo cobre o caso em
        // que a busca ASSENTA dentro do reply_ms com balde vazio (filme a
        // frio: o list_builder NÃO promete "reabra" em filme completo — mas
        // parcial ainda está procurando). Sem isto: `{"streams":[],"cacheMaxAge":0}`.
        if streams.is_empty() && (outcome.collect_failed || outcome.partial) {
            streams = notice_streams(req, NOTICE_SEARCHING);
        }
        StreamResponse {
            streams,
            cache_max_age: outcome.cache_max_age,
        }
    }

    pub(super) fn respond_notice(&self, req: &StreamRequest, text: &str) -> StreamResponse {
        StreamResponse {
            streams: notice_streams(req, text),
            cache_max_age: 0,
        }
    }
}
