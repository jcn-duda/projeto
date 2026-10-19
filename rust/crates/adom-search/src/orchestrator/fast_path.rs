//! Vias rápidas do `/stream` nativo: instantânea do banco vivo e índice
//! coberto. A DECISÃO (qual via, quais itens) é do Node, em
//! `POST /internal/search/index`; aqui só se monta a lista da resposta.

use serde_json::Value;

use crate::internal_types::SearchIndexRequest;
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

/// "Vivo vence sempre" no tail: une a lista da via rápida com a coleta ao vivo
/// completa e tira as marcas de dado salvo. Espelho de `dropInstantFallbacks` +
/// `clearInstantSnapshots` do TS, sem o estado vivo POR indexer (o `Collector`
/// do Rust só devolve itens e "todas falharam"):
/// - coleta inteira falhou (Jackett parado): nada muda — a reserva segue 📦 e
///   a foto mantém o selo, senão a foto viraria lista viva completa (TTL cheio);
/// - senão, a reserva do banco sai (o TS a tira e só reinjeta 📦 de indexer
///   que falhou) e a foto perde o selo (o TS só o mantém para indexer falho).
///
/// O TS mantém o selo do indexer que falhou sozinho; aqui ele sai junto. Isso
/// espera o estado vivo por indexer chegar ao `CollectBatch`.
///
/// Sem isto o dedupe (empate → 1ª ocorrência) mantinha a cópia marcada, a
/// lista promovida nunca ficava completa e o 📦 aparecia em release viva.
pub(super) fn merge_fast_with_live(
    fast: Vec<RawItem>,
    live: Vec<RawItem>,
    all_failed: bool,
) -> Vec<RawItem> {
    let mut out: Vec<RawItem> = Vec::with_capacity(fast.len() + live.len());
    if all_failed {
        out.extend(fast);
    } else {
        for mut item in fast {
            if item.from_fallback {
                continue;
            }
            item.from_snapshot = false;
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
mod tests {
    use super::*;

    fn item(title: &str, hash: &str, indexer: &str) -> RawItem {
        RawItem {
            title: Some(title.into()),
            info_hash: Some(hash.into()),
            indexer: Some(indexer.into()),
            ..RawItem::default()
        }
    }

    #[test]
    fn vivo_supera_reserva_e_foto_quando_a_coleta_respondeu() {
        let mut banco = item("banco", "AAA", "mico");
        banco.from_fallback = true;
        let mut foto = item("foto", "CCC", "bludv");
        foto.from_snapshot = true;
        let live = vec![item("ao vivo", "EEE", "bludv")];

        let out = merge_fast_with_live(vec![banco.clone(), foto.clone()], live.clone(), false);
        let titles: Vec<&str> = out
            .iter()
            .map(|i| i.title.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(titles, ["foto", "ao vivo"], "a reserva sai; a foto fica");
        assert!(
            !out[0].from_snapshot,
            "coleta respondeu: a foto perde o selo"
        );

        // Jackett parado: nada muda, senão a foto vira lista viva completa.
        let out = merge_fast_with_live(vec![banco, foto], live, true);
        assert!(out[0].from_fallback && out[1].from_snapshot);
        assert_eq!(out.len(), 3);
    }
    #[test]
    fn tail_input_troca_o_prazo_da_resposta_pelo_do_tail() {
        use crate::orchestrator::tests::test_support::{config, MemorySwrStore};
        use std::sync::Arc;
        let mut cfg = config();
        cfg.tail_collect_ms = 25_000;
        let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()));
        let input = SearchInput {
            kind: "movie".into(),
            id: "tt0133093".into(),
            encoded: None,
            prefix: String::new(),
            options: serde_json::json!({}),
            key: "k".into(),
            now_ms: 0,
            deadline_at: Some(1),
        };
        let before = crate::orchestrator::respond::now_ms();
        let tail = orch.tail_input(&input);
        assert!(tail.deadline_at.unwrap_or(0) >= before + 25_000);
    }
}
