//! Tipos públicos do cliente BLUDV — alinhados a `src/providers/bludv.ts`.

use serde::{Deserialize, Serialize};

/// Card da lista WordPress (`div.post > div.title > a`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BludvPost {
    pub url: String,
    pub title: String,
}

/// Botão de download raspado do post (legado systemads/videosad ou gate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BludvDownloadLink {
    pub url: String,
    pub label: String,
    /// Texto de tamanho cru ("3.39 GB"); bytes vêm depois de `parse_size`.
    pub size: Option<String>,
    /// `dublado` / `legendado` / `desconhecido`.
    pub audio: String,
    /// Qualidade do CONTEXTO (segmento + texto da âncora), como o
    /// `normalizeQuality` do TS: 2160/1080/720/576/480 ou o número do token.
    pub quality: Option<u32>,
    /// Fonte normalizada do contexto (`WEB-DL`, `BLU-RAY`, `REMUX`, …).
    pub source: Option<String>,
}

/// Opções injetáveis na busca (não lê `opts()` global).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BludvSearchOpts {
    /// Filtra botões `legendado` (espelha `opts().dubbedOnly`, cujo default do
    /// Node é `BLUDV_DUBBED_ONLY` — verdadeiro).
    pub dubbed_only: bool,
    /// Sombra read-only (F2.1/F2.4): não LÊ nem GRAVA o `raw:v1` e não tem
    /// efeitos. A rede/parse são os mesmos do caminho vivo.
    pub read_only: bool,
}

/// Desfecho da consulta ao BLUDV. O caminho vivo usa a variante para o estado
/// `live` por fonte; `search()` continua fail-open e devolve só os itens.
#[derive(Debug, Clone, PartialEq)]
pub enum BludvOutcome {
    /// Resposta válida (itens possivelmente vazios; quem chama decide
    /// `live.ok` × `live.empty` pela relevância).
    Ok(Vec<BludvRawItem>),
    /// Kill-switch/consulta vazia: nem foi à rede — nada foi prometido.
    Disabled,
    /// Base barrada pela guarda SSRF: nada foi prometido.
    BlockedUrl,
    /// HTTP não-2xx (o `status` decide falha viva × vazio suspeito).
    Http(u16),
    /// Rede/timeout/redirect inválido — a consulta foi tentada e não respondeu.
    Failed(String),
}

impl BludvOutcome {
    /// Rótulo curto para log (sem credencial/URL).
    pub fn label(&self) -> String {
        match self {
            BludvOutcome::Ok(items) => format!("{} item(ns)", items.len()),
            BludvOutcome::Disabled => "desligado/consulta vazia".into(),
            BludvOutcome::BlockedUrl => "URL barrada".into(),
            BludvOutcome::Http(status) => format!("HTTP {status}"),
            BludvOutcome::Failed(reason) => format!("falha: {reason}"),
        }
    }

    /// 429/5xx/rede/timeout: a fonte foi consultada e não respondeu.
    pub fn is_host_failure(&self) -> bool {
        match self {
            BludvOutcome::Failed(_) => true,
            BludvOutcome::Http(status) => *status == 429 || *status >= 500,
            _ => false,
        }
    }
}

/// Item cru do scraper BLUDV.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BludvRawItem {
    pub title: String,
    pub magnet: String,
    /// Neutro das fontes BR (site não publica seeds).
    pub seeders: f64,
    pub size: Option<f64>,
    /// Sempre `"BLUDV"` — é o `tracker` do Node (o `_indexer` nasce dele).
    pub tracker: String,
    /// `dublado` / `legendado` / `desconhecido`.
    pub audio: String,
    /// Sempre `true` (origem BR do provider).
    pub is_br: bool,
}
