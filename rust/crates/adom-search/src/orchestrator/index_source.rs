//! Contrato do ÍNDICE e do BANCO DE MAGNETS nativos (R4).
//!
//! A DECISÃO (quais releases o índice tem, qual a foto instantânea, quando
//! consultar a reserva) continua no orquestrador; aqui ficam as duas traits de
//! I/O que o `adom-store` implementa sobre o MESMO `cache.db` (`idx:v14`) e
//! `magnets.db` do Node:
//!
//! - [`ReleaseIndexSource`] — `releaseIndex.lookup`/`isPartial`/`record`;
//! - [`MagnetBankSource`] — `worksForObraMany`/`sourcesForMany`/
//!   `markBankFilterOutcome`/`captureItems` (a captura da busca é NATIVA; o
//!   efeito `magnet_capture` do Node não existe mais).
//!
//! Os tipos de fio são os do núcleo (`InstantWork`/`InstantSource`/`BankRow`,
//! `WorkTarget`) mais [`IndexedReleaseWire`], que espelha o JSON persistido pelo
//! Node. Nada aqui abre arquivo: o `adom-server` injeta os stores sempre;
//! falha de abertura degrada sem índice/banco, nunca cai no Node.

use std::sync::Arc;

use adom_core::{BankRow, InstantSource, InstantWork, WorkTarget};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::internal_types::ReleaseEntry;
use crate::RawItem;

/// Uma release do índice (`idx:v14`), campo a campo como o Node grava.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedReleaseWire {
    pub hash: String,
    pub title: String,
    pub size: Option<i64>,
    pub indexer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker: Option<String>,
    pub is_br: bool,
    pub dubbed: bool,
    pub quality: String,
    pub seeders: i64,
    pub seen_at: i64,
    pub lied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_source: Option<String>,
}

/// Contexto da escrita do filtro no banco (`WorkCtx` do Node).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BankFilterCtx {
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// Consulta em lote ao acervo (`listMagnetsMany` do Node): hashes → linhas.
/// Alias porque a travessia de `Option<&dyn Fn…>` no fio das traits dispara o
/// `type_complexity` do Clippy sem ele.
pub type BankLookup<'a> = &'a dyn Fn(&[String]) -> Vec<BankRow>;

/// Índice de releases. Todas as leituras recebem o relógio (o núcleo não lê
/// `Date.now`) e toda falha é do chamador (fail-open: lista vazia).
pub trait ReleaseIndexSource: Send + Sync {
    fn lookup(
        &self,
        imdb: &str,
        season: Option<i64>,
        episode: Option<i64>,
        now_ms: i64,
    ) -> Vec<IndexedReleaseWire>;

    fn is_partial(
        &self,
        imdb: &str,
        season: Option<i64>,
        episode: Option<i64>,
        now_ms: i64,
    ) -> bool;

    /// `releaseIndex.record` — grava o lote pós-filtro. `bank` resolve a fonte
    /// de mídia/dn dos hashes sem `dn=` (o `bankRowsForMediaSource` do Node).
    fn record(
        &self,
        entry: &ReleaseEntry,
        now_ms: i64,
        bank: Option<BankLookup<'_>>,
    ) -> Result<usize, String>;
}

/// Banco de magnets vivo (`magnets.db`). Leitura em lote, escrita do veredito
/// do filtro; a captura continua na coleta viva.
pub trait MagnetBankSource: Send + Sync {
    fn works_for_obra_many(
        &self,
        imdb: &str,
        targets: &[WorkTarget],
        limit_per_target: usize,
        max_total: usize,
        indexers: Option<&[String]>,
    ) -> Vec<InstantWork>;

    fn sources_for_many(
        &self,
        hashes: &[String],
    ) -> std::collections::BTreeMap<String, Vec<InstantSource>>;

    fn bank_rows_many(&self, hashes: &[String]) -> Vec<BankRow>;

    fn mark_filter_outcome(
        &self,
        entered: &[Value],
        survivors: &[Value],
        ctx: &BankFilterCtx,
        now_ms: i64,
    ) -> bool;

    /// `captureItems`: grava a leva da busca no acervo (`magnet`,
    /// `magnet_source`, `magnet_work`) numa transação. Devolve quantos itens
    /// passaram pelo guardrail (item de conta/reserva/foto e sem hash ficam de
    /// fora).
    ///
    /// Default `Ok(0)`: implementações que só LEEM o banco (stubs de teste,
    /// colhedor de fundo) não gravam — só o store real sobrescreve.
    fn capture_items(
        &self,
        _items: &[RawItem],
        _source: &str,
        _ctx: &BankFilterCtx,
        _now_ms: i64,
    ) -> Result<usize, String> {
        Ok(0)
    }

    /// `bankHasBrRow` do Node (evidência de plausibilidade da sonda BR).
    fn has_br_row(&self, imdb: &str, targets: &[WorkTarget]) -> bool;
}

/// Alias de leitura: os dois stores nativos viajam juntos no orquestrador.
pub type SharedIndex = Arc<dyn ReleaseIndexSource>;
pub type SharedBank = Arc<dyn MagnetBankSource>;

/// `obraTargets` (`magnet-bank-fallback.ts`): filme só a raiz; série pede o
/// episódio, o pack da temporada e a série completa.
pub fn obra_targets(type_: &str, season: Option<i64>, episode: Option<i64>) -> Vec<WorkTarget> {
    if type_ == "movie" || season.is_none() {
        return vec![WorkTarget {
            season: None,
            episode: None,
        }];
    }
    let mut out = Vec::new();
    if episode.is_some() {
        out.push(WorkTarget { season, episode });
    }
    out.push(WorkTarget {
        season,
        episode: None,
    });
    out.push(WorkTarget {
        season: None,
        episode: None,
    });
    out
}

/// `PER_INDEXER_MAX`/teto global JÁ clampados como no TS.
pub fn bank_limits(per_indexer: i64, global: i64) -> (i64, i64) {
    let per = if per_indexer == 0 { 40 } else { per_indexer }.clamp(1, 40);
    let global = if global == 0 { 40 } else { global }.clamp(1, 500);
    (per, global)
}

/// Tamanho da leitura do banco: no máximo o dobro do teto global, por alvo.
pub fn bank_read_window(per_indexer: i64, global: i64) -> (usize, usize) {
    let read_limit = (global.max(per_indexer) * 2).clamp(1, 200) as usize;
    let max_total = (global * 3).max(1) as usize;
    (read_limit, max_total)
}

/// `SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`.
fn safe_indexer_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0];
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .skip(1)
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// Origens que não são indexer Jackett — não entram no filtro `ji`.
const NON_INDEXER: [&str; 3] = ["autofetch", "bludv", "account"];

/// Porte de `allowedSourceIndexer` (`src/providers/allowed-source-indexer.ts`):
/// o índice/banco são globais entre instalações; sem isto `p=jackett` recebia
/// release gravada como `indexer:'torrentio'` e o `ji` restrito via banco.
///
/// `options` é a config EFETIVA do pedido (`opts()`); `selected` é o default do
/// operador (`config.jackett.indexers`), usado quando a URL não trouxe `ji`.
pub fn allowed_source_indexer(
    indexer: &str,
    options: &Value,
    index_only_indexers: &[String],
    selected: &[String],
) -> bool {
    let id = indexer.trim();
    if id.is_empty() {
        return true;
    }
    let lower = id.to_lowercase();
    if NON_INDEXER.contains(&lower.as_str()) {
        return true;
    }
    let providers: Vec<String> = options
        .get("providers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mode = if providers.iter().any(|p| p == "both") {
        "both".to_string()
    } else {
        providers.first().cloned().unwrap_or_default()
    };
    let wants = |name: &str| mode == "both" || providers.iter().any(|p| p == name);
    if lower == "torrentio" {
        return wants("torrentio");
    }
    // Index-only nunca é consultado ao vivo por instalação — o `ji` não o
    // governa (o `.env` da VPS tem id inexistente e a /configure desmarca o
    // card Cardigann; filtrá-lo cortava a fonte para todos).
    if index_only_indexers
        .iter()
        .any(|candidate| candidate.trim().to_lowercase() == lower)
    {
        return true;
    }
    if safe_indexer_id(id) {
        let from_options: Vec<String> = options
            .get("jackettIndexers")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .filter(|candidate| safe_indexer_id(candidate))
                    .map(|candidate| candidate.to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        let mut chosen: Vec<String> = if from_options.is_empty() {
            selected
                .iter()
                .filter(|candidate| safe_indexer_id(candidate))
                .map(|candidate| candidate.to_lowercase())
                .collect()
        } else {
            from_options
        };
        chosen.sort();
        chosen.dedup();
        if chosen.is_empty() {
            return true;
        }
        return chosen.contains(&lower);
    }
    true
}

#[cfg(test)]
#[path = "index_source_tests.rs"]
mod tests;
