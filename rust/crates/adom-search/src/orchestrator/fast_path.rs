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

fn indexer_key(item: &RawItem) -> String {
    item.indexer.as_deref().unwrap_or("").trim().to_lowercase()
}

/// "Vivo vence sempre" no tail: une a lista da via rápida com a coleta ao vivo
/// completa, tirando as marcas que a coleta já superou. Espelho de
/// `dropInstantFallbacks` + `clearInstantSnapshots` do TS:
/// - reserva do banco (`from_fallback`) sai quando o hash voltou ao vivo ou o
///   indexer dela respondeu. O Rust não reinjeta 📦 no tail como o
///   `collectFallbackForBuild`, então a de indexer ausente fica (ainda 📦);
/// - foto do índice (`from_snapshot`) perde o selo quando o indexer dela
///   respondeu; indexer ausente (falho ou vazio suspeito) mantém o selo.
///
/// Sem isto o dedupe (empate → 1ª ocorrência) mantinha a cópia marcada, a
/// lista promovida nunca ficava completa e o 📦 aparecia em release viva.
pub(super) fn merge_fast_with_live(fast: Vec<RawItem>, live: Vec<RawItem>) -> Vec<RawItem> {
    let responded: std::collections::HashSet<String> = live
        .iter()
        .map(indexer_key)
        .filter(|k| !k.is_empty())
        .collect();
    let live_hashes: std::collections::HashSet<String> = live
        .iter()
        .filter_map(|i| i.info_hash.as_deref())
        .map(str::to_lowercase)
        .collect();
    let mut out: Vec<RawItem> = Vec::with_capacity(fast.len() + live.len());
    for mut item in fast {
        let indexer_ok = responded.contains(&indexer_key(&item));
        if item.from_fallback {
            let seen_live = item
                .info_hash
                .as_deref()
                .is_some_and(|h| live_hashes.contains(&h.to_lowercase()));
            if seen_live || indexer_ok {
                continue;
            }
        }
        if item.from_snapshot && indexer_ok {
            item.from_snapshot = false;
        }
        out.push(item);
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
    fn vivo_supera_reserva_e_foto_do_indexer_que_respondeu() {
        let mut banco_vivo = item("banco reencontrado", "AAA", "mico");
        banco_vivo.from_fallback = true;
        let mut banco_ausente = item("banco de indexer caído", "BBB", "vacatorrent");
        banco_ausente.from_fallback = true;
        let mut foto_ok = item("foto de indexer vivo", "CCC", "BLUDV ");
        foto_ok.from_snapshot = true;
        let mut foto_caida = item("foto de indexer caído", "DDD", "nerdfilmes");
        foto_caida.from_snapshot = true;
        let live = vec![
            item("ao vivo", "aaa", "mico"),
            item("outro", "EEE", "bludv"),
        ];

        let out = merge_fast_with_live(vec![banco_vivo, banco_ausente, foto_ok, foto_caida], live);
        let titles: Vec<&str> = out
            .iter()
            .map(|i| i.title.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(
            titles,
            [
                "banco de indexer caído",
                "foto de indexer vivo",
                "foto de indexer caído",
                "ao vivo",
                "outro"
            ]
        );
        assert!(out[0].from_fallback, "reserva sem confirmação segue 📦");
        assert!(
            !out[1].from_snapshot,
            "indexer respondeu: a foto perde o selo"
        );
        assert!(
            out[2].from_snapshot,
            "indexer ausente: a foto mantém o selo"
        );
    }
}
