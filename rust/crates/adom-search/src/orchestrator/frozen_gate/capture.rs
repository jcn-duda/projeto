//! Captura congelada do `/stream`: as formas de fio lidas de `inputs/*.json`.
//!
//! Nada aqui conhece o orquestrador: sao so os `Deserialize` do record.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

// ── captura ─────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub(super) struct RequestFile {
    #[serde(default)]
    pub(super) r#type: String,
    #[serde(default)]
    pub(super) stream_id: String,
    #[serde(default)]
    pub(super) encoded_len: usize,
}

#[derive(Debug, Deserialize)]
pub(super) struct KeyFile {
    #[serde(default)]
    pub(super) scope: String,
    #[serde(default)]
    pub(super) season: Option<i64>,
    #[serde(default)]
    pub(super) episode: Option<i64>,
    #[allow(dead_code)]
    #[serde(default)]
    pub(super) query: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub(super) struct BatchFile {
    #[serde(default)]
    pub(super) items: Vec<Value>,
    #[serde(default)]
    pub(super) partial: bool,
    #[serde(default)]
    pub(super) live: Option<crate::internal_types::LiveSnapshot>,
}

#[derive(Debug, Deserialize)]
pub(super) struct CollectFile {
    pub(super) key: KeyFile,
    pub(super) response: BatchFile,
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct ApplyDebridFile {
    /// `service|cachedOnly|hash1,hash2,...` — o lote que o Node passou ao
    /// `applyDebrid` (a lista PRÉ-debrid da resposta). É o único registro dessa
    /// fronteira no corpus: sem ele o replay re-deriva filtros que dependem de
    /// `releaseIndex.fileEvidence` (não capturado) e mantém item que o Node já
    /// tinha descartado.
    #[serde(default)]
    pub(super) key: String,
    #[serde(default)]
    pub(super) output: Vec<Value>,
}

/// Campos de APRESENTAÇÃO que o `applyDebrid` já fechou (title/size). O
/// `annotateEpisodeSizes` do replay pode ficar na média quando a lista `fsz`
/// só chegou depois do build; o título do `apply-debrid` é a resposta final do
/// Node e é a fonte para esses dois campos.
#[derive(Debug, Clone, Default)]
pub(super) struct AppliedFields {
    pub(super) title: Option<String>,
    pub(super) size: Option<String>,
}

/// Item de `inputs/files.json` — o memo `fsz` do Node (arquivo + tamanho).
#[derive(Debug, Clone, Deserialize, Default)]
pub(super) struct FileEntry {
    #[serde(default)]
    pub(super) path: String,
    #[serde(default)]
    pub(super) size: f64,
}

/// `inputs/fallback.json`: o RESULTADO de `collectFallbackForBuild` (o Node
/// grava `{key, value:{items,injected,cut}}`), não as linhas do banco.
#[derive(Debug, Deserialize, Default)]
pub(super) struct FallbackFile {
    #[serde(default)]
    pub(super) value: Option<FallbackValue>,
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct FallbackValue {
    #[serde(default)]
    pub(super) items: Vec<Value>,
}

/// `inputs/index.json`: o lote que o Node passou ao build. Na via instantânea
/// ele é a MESCLA `índice + banco + conta`, com cada item já marcado pela
/// origem (`fromSnapshot`/`fromFallback`/`fromAccount`); fora dela é o lote cru
/// do índice. É o lote FINAL do build do Node, com as anotações de prova que só
/// ele tem (`provenQuality`/`provenAudio`/`provenName`/`mediaSource`): desde o
/// R4 não existe rota Node de índice, então o gate entrega esse lote VERBATIM à
/// via rápida (ver `Orchestrator::with_frozen_fast_path`).
#[derive(Debug, Deserialize)]
pub(super) struct IndexFile {
    #[serde(default)]
    pub(super) value: IndexValue,
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct IndexValue {
    #[serde(rename = "servedFromIndex", default)]
    pub(super) served_from_index: bool,
    #[serde(default)]
    pub(super) instant: bool,
    /// `null` em caso sem lote (`movie-fake-id-guard`).
    #[serde(default)]
    pub(super) raw: Option<BatchFile>,
}

/// Lote congelado da via rápida, já anotado.
pub(super) struct FrozenBatch {
    pub(super) items: Vec<Value>,
    pub(super) instant: bool,
    pub(super) index_covered: bool,
}

#[derive(Debug, Deserialize, Default)]
pub(super) struct DebridFile {
    #[serde(default)]
    pub(super) calls: Vec<DebridCall>,
    /// Formato do record atual (checagem Node consolidada): hash →
    /// veredito. Antes o replay só lia `calls[0]` e, sem esse campo, tratava
    /// TODO hash como "não perguntado" — o expected marcado `[AD⚡]` virava
    /// `[AD download]` no replay (Carandiru/Central/Bacurau, 2026-10-20).
    #[serde(default)]
    pub(super) results: BTreeMap<String, DebridResult>,
}

/// Veredito POR HASH do check consolidado que gerou o expected.
#[derive(Debug, Clone, Deserialize, Default)]
pub(super) struct DebridResult {
    #[serde(default)]
    pub(super) cached: bool,
    #[serde(default)]
    pub(super) known: bool,
    #[serde(default)]
    pub(super) unusable: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub(super) struct DebridCall {
    #[allow(dead_code)]
    #[serde(default)]
    pub(super) hashes: Vec<String>,
    #[serde(default)]
    pub(super) known: bool,
    #[serde(default)]
    pub(super) unusable: Option<Value>,
    #[serde(default)]
    pub(super) cached: Vec<String>,
    /// Cache hermético: o veredito POR HASH da checagem que gerou o expected.
    #[serde(default)]
    pub(super) results: BTreeMap<String, DebridResult>,
    /// Hashes que o `apply-debrid` fechou como P2P (sem link do debrid). O
    /// `debrid.json` pode ter `cached:true` do memo; o P2P do apply vence.
    #[serde(skip)]
    pub(super) applied_p2p: std::collections::BTreeSet<String>,
}
