//! Vias rápidas do `/stream` nativo: instantânea do banco vivo e índice
//! coberto. A leitura e a decisão são NATIVAS (`idx:v14`/`magnets.db`, ver
//! `native_index.rs`); não há mais rota Node de índice. Falha de abertura
//! degrada SEM via rápida (a coleta ao vivo segue), nunca cai no Node.

use std::collections::BTreeSet;

use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::RawItem;

use super::finish::{is_demo, SearchInput};
use super::meta::SearchMeta;
use super::Orchestrator;

/// Lista de uma das vias rápidas.
#[derive(Clone)]
pub(super) struct FastPath {
    /// `true` = instantânea do banco (a coleta ao vivo inteira vai ao tail);
    /// `false` = índice coberto (BR prioritário inline, globais no tail).
    pub instant: bool,
    pub items: Vec<RawItem>,
}

/// Indexer da marca, normalizado como o Node compara
/// (`String(item.indexer || '').trim().toLowerCase()`).
fn indexer_da_marca(item: &RawItem) -> String {
    item.indexer
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default()
}

/// "Vivo vence sempre" no tail: une a lista da via rápida com a coleta ao vivo
/// completa e tira as marcas de dado salvo. Espelho de `dropInstantFallbacks` +
/// `clearInstantSnapshots` do TS, com o estado vivo POR indexer quando ele
/// chegou no `CollectBatch`:
///
/// - **coleta inteira falhou** (`all_failed` estrutural OU agregado `/all`
///   error/pending): nada muda — a reserva segue 📦 e a foto mantém o selo,
///   senão a foto viraria lista viva completa (TTL cheio), EXCETO a reserva
///   cujo MESMO hash apareceu no lote vivo: aí o vivo já é prova suficiente;
/// - **com contrato vivo**, sai só o que o indexer da marca PROVOU que
///   respondeu: falha isolada preserva a 📦/selo do indexer que caiu; pending
///   não prova sucesso (fica no `failedIndexers()` do Node); vazio suspeito é
///   o `empty − failed − pending` que o Node já classificou (nunca inferido
///   aqui). Em QUALQUER caso o vivo vence por hash
///   (`collectFallbackForBuild.liveHashes` no TS): reserva 📦 cujo `infoHash`
///   está no lote vivo sai mesmo que o indexer dela esteja não-provado;
/// - **sem contrato vivo** (`None`: collector nativo, Node antigo), a régua
///   antiga vale — saem TODAS as reservas e selos, como antes. Ausência nunca
///   vira "todos responderam".
///
/// A foto do índice (`from_snapshot`) perde o selo quando o MESMO hash aparece
/// vivo, mesmo que o indexer dela siga não-provado: o build deduplica pela
/// primeira ocorrência (fast → live) e, mantendo a marca, a cópia salva
/// esconderia o item vivo e exibiria 📦 num hash que o vivo entregou. O hash é
/// evidência suficiente de que aquele dado não é mais reserva.
///
/// A ordem fast → live é contrato: o dedupe do build é primeira ocorrência
/// (`dedupe_by_hash`), e o TS também mantém o item da via na frente.
pub(super) fn merge_fast_with_live(
    fast: Vec<RawItem>,
    live: Vec<RawItem>,
    all_failed: bool,
    live_state: Option<&LiveBatchState>,
) -> Vec<RawItem> {
    let live_hashes: BTreeSet<String> = live
        .iter()
        .map(RawItem::bank_hash)
        .filter(|h| !h.is_empty())
        .collect();
    let mut out: Vec<RawItem> = Vec::with_capacity(fast.len() + live.len());
    let agregado_falhou = live_state.is_some_and(|state| state.all.failed());
    if all_failed || agregado_falhou {
        // Falha agregada preserva as marcas, mas não uma reserva cujo hash o
        // vivo entregou: `liveHashes` do TS corta a duplicata antes do build.
        // A foto que o vivo provou não é reserva, mesmo com o indexer não
        // provado — senão o dedupe mantém a cópia salva marcada.
        for mut item in fast {
            let hash_vivo = live_hashes.contains(&item.bank_hash());
            if item.from_fallback && hash_vivo {
                continue;
            }
            if item.from_snapshot && hash_vivo {
                item.from_snapshot = false;
            }
            out.push(item);
        }
    } else {
        // `None` = nada provado por indexer: `respondeu` é sempre verdadeiro e a
        // régua antiga vale (todas as marcas saem). Com contrato, `unproven()` =
        // falho + pendente + suspeito — exatamente quem mantém 📦/selo no Node.
        let nao_provado = live_state.map(|state| state.unproven());
        for mut item in fast {
            let respondeu = nao_provado
                .as_ref()
                .is_none_or(|set| !set.contains(&indexer_da_marca(&item)));
            let hash_vivo = live_hashes.contains(&item.bank_hash());
            if item.from_fallback && (respondeu || hash_vivo) {
                continue;
            }
            // O hash vivo tira o selo mesmo sem prova do indexer: a cópia
            // salva seria a primeira no dedupe e esconderia o item vivo.
            if item.from_snapshot && (respondeu || hash_vivo) {
                item.from_snapshot = false;
            }
            out.push(item);
        }
    }
    out.extend(live);
    out
}

/// Lista completa de uma janela de coleta: o `completion` devolve o balde
/// INTEIRO (o que chegou no prazo + o tardio); sem ele (ou se a task caiu),
/// vale o que a janela já tinha.
pub(super) async fn full_window(
    items: Vec<RawItem>,
    completion: Option<tokio::task::JoinHandle<Vec<RawItem>>>,
) -> Vec<RawItem> {
    match completion {
        Some(handle) => handle.await.unwrap_or(items),
        None => items,
    }
}

impl Orchestrator {
    /// Injeta o lote da via rápida já decidido (replay congelado). Substituiu a
    /// rota Node `search/index`: o gate entrega o lote capturado VERBATIM — com
    /// as anotações de qualidade/áudio/fonte que o build do Node aplicou — em
    /// vez de re-derivá-lo de `idx:v14`/`magnets.db`, que são wire-shaped e não
    /// carregam prova por item. Produção nunca chama (o campo fica `None`).
    #[doc(hidden)]
    pub fn with_frozen_fast_path(mut self, instant: bool, items: Vec<RawItem>) -> Self {
        self.frozen_fast_path = Some(FastPath { instant, items });
        self
    }

    /// Entrada da coleta do tail: o prazo da resposta vira o do tail
    /// (`tail_collect_ms`), senão os globais lentos não chegam à promoção.
    pub(super) fn tail_input(&self, input: &SearchInput) -> SearchInput {
        let mut tail = input.clone();
        tail.deadline_at = Some(super::respond::now_ms() + self.config.tail_collect_ms);
        tail
    }

    /// `None` = nenhuma via rápida (demo, índice indisponível, erro ou obra
    /// fora do acervo): a coleta ao vivo segue como antes.
    pub(super) async fn fast_path_items(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> Option<FastPath> {
        if is_demo(&input.options) {
            return None;
        }
        // Replay congelado: o lote capturado substitui a leitura nativa (a
        // decisão de QUAL via já veio no próprio lote).
        if let Some(frozen) = &self.frozen_fast_path {
            return Some(frozen.clone());
        }
        // Índice e banco nativos são os ÚNICOS caminhos (R4). Sem store, o
        // `native_index_scan`/`fill_instant` já degrada com log `[search]` — a
        // coleta ao vivo segue e NUNCA há fallback para a rota Node.
        if self.index.is_none() && self.bank.is_none() {
            return None;
        }
        self.native_fast_path(input, meta).await
    }
}

#[cfg(test)]
#[path = "fast_path_tests.rs"]
mod tests;
