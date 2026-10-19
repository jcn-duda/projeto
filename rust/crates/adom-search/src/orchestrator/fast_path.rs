//! Vias rápidas do `/stream` nativo: instantânea do banco vivo e índice
//! coberto. A DECISÃO (qual via, quais itens) é do Node, em
//! `POST /internal/search/index`; aqui só se monta a lista da resposta.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::internal_types::SearchIndexRequest;
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::{raw_item_from_value, RawItem};
use crate::request::encoded_for_internal;

use super::finish::{is_demo, SearchInput};
use super::meta::SearchMeta;
use super::Orchestrator;

/// Lista de uma das vias rápidas.
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

/// Hash canônico do `hashOf` do banco (`src/utils/magnet-bank-merge.ts`):
/// tenta `infoHash`, `magnet`, `MagnetUri` e `Guid` EM ORDEM até um válido.
/// `RawItem::hash()` para no `infoHash` não vazio mesmo inválido; aqui não,
/// porque o `liveHashes` do Node também não para.
fn bank_hash(item: &RawItem) -> String {
    [
        item.info_hash.as_deref(),
        item.magnet.as_deref(),
        item.magnet_uri.as_deref(),
        item.guid.as_deref(),
    ]
    .into_iter()
    .flatten()
    .find_map(|candidate| {
        adom_core::extract_info_hash(candidate)
            .map(|hash| hash.trim().to_lowercase())
            .filter(|hash| !hash.is_empty())
    })
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
        .map(bank_hash)
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
            let hash_vivo = live_hashes.contains(&bank_hash(&item));
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
            let hash_vivo = live_hashes.contains(&bank_hash(&item));
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

fn mapped(values: Vec<Value>, mark: impl Fn(&mut RawItem)) -> Vec<RawItem> {
    values
        .iter()
        .map(|v| {
            let mut item = raw_item_from_value(v);
            mark(&mut item);
            item
        })
        .collect()
}

impl Orchestrator {
    /// Entrada da coleta do tail: o prazo da resposta vira o do tail
    /// (`tail_collect_ms`), senão os globais lentos não chegam à promoção.
    pub(super) fn tail_input(&self, input: &SearchInput) -> SearchInput {
        let mut tail = input.clone();
        tail.deadline_at = Some(super::respond::now_ms() + self.config.tail_collect_ms);
        tail
    }

    /// `None` = nenhuma via rápida (sem rota interna, demo, erro ou obra fora
    /// do acervo): a coleta ao vivo segue como antes.
    pub(super) async fn fast_path_items(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> Option<FastPath> {
        if is_demo(&input.options) {
            return None;
        }
        let routes = self.routes.as_ref()?;
        let req = SearchIndexRequest {
            encoded: encoded_for_internal(input.encoded.as_deref()),
            media_type: input.kind.clone(),
            imdb: meta.imdb_id.clone(),
            season: meta.season,
            episode: meta.episode,
            names: Some(meta.names.clone()),
            year: Some(meta.year.clone()),
            released: None,
            first_aired: None,
        };
        let resp = routes.search_index(req).await.ok()?;
        if resp.instant_eligible {
            let mut items = mapped(resp.instant_items, |_| {});
            items.extend(mapped(resp.index_items, |i| i.from_snapshot = true));
            items.extend(mapped(resp.account_items, |i| i.from_account = true));
            return Some(FastPath {
                instant: true,
                items,
            });
        }
        if resp.index_covered {
            let mut items = mapped(resp.index_items, |i| i.from_snapshot = true);
            items.extend(mapped(resp.account_items, |i| i.from_account = true));
            return Some(FastPath {
                instant: false,
                items,
            });
        }
        None
    }
}

#[cfg(test)]
#[path = "fast_path_tests.rs"]
mod tests;
