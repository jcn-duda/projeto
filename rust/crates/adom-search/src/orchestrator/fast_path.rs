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
