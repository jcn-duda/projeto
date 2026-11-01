use std::collections::BTreeMap;
use std::sync::Mutex;

use adom_core::{BankRow, InstantSource, InstantWork, WorkTarget};
use serde_json::{json, Value};

use super::mark_shared_works;
use crate::list_builder::{build_stream_list, BuildContext, BuildOptions};
use crate::orchestrator::config::NoDebridCheck;
use crate::orchestrator::index_source::{BankFilterCtx, MagnetBankSource};
use crate::orchestrator::meta::SearchMeta;
use crate::raw_item::{raw_item_from_value, RawItem};

const H1: &str = "1111111111111111111111111111111111111111";
const H2: &str = "2222222222222222222222222222222222222222";

struct Fake {
    counts: BTreeMap<String, i64>,
    asked: Mutex<u32>,
}

impl MagnetBankSource for Fake {
    fn works_for_obra_many(
        &self,
        _: &str,
        _: &[WorkTarget],
        _: usize,
        _: usize,
        _: Option<&[String]>,
    ) -> Vec<InstantWork> {
        Vec::new()
    }
    fn sources_for_many(&self, _: &[String]) -> BTreeMap<String, Vec<InstantSource>> {
        BTreeMap::new()
    }
    fn bank_rows_many(&self, _: &[String]) -> Vec<BankRow> {
        Vec::new()
    }
    fn other_works_passed(&self, _: &[String], _: &str) -> BTreeMap<String, i64> {
        *self.asked.lock().unwrap() += 1;
        self.counts.clone()
    }
    fn mark_filter_outcome(&self, _: &[Value], _: &[Value], _: &BankFilterCtx, _: i64) -> bool {
        true
    }
    fn has_br_row(&self, _: &str, _: &[WorkTarget]) -> bool {
        false
    }
}

fn bank(works: i64) -> Fake {
    Fake {
        counts: BTreeMap::from([(H1.to_string(), works)]),
        asked: Mutex::new(0),
    }
}

fn item(hash: &str) -> RawItem {
    raw_item_from_value(&json!({ "title": "Filme (2017)", "infoHash": hash }))
}

fn movie() -> SearchMeta {
    SearchMeta {
        imdb_id: "tt1".to_string(),
        ..SearchMeta::default()
    }
}

#[test]
fn marca_so_o_hash_que_alcanca_o_minimo() {
    let items = [item(H1), item(H2)];
    let marked = mark_shared_works(Some(&bank(2)), &items, &movie(), 2);
    assert!(marked[0].shared_by_other_works);
    assert!(!marked[1].shared_by_other_works);
}

#[test]
fn abaixo_do_minimo_nao_marca() {
    let items = [item(H1)];
    let marked = mark_shared_works(Some(&bank(1)), &items, &movie(), 2);
    assert!(!marked[0].shared_by_other_works);
}

#[test]
fn serie_minimo_zero_e_banco_fora_nem_consultam() {
    let items = [item(H1)];
    let fake = bank(9);
    let series = SearchMeta {
        season: Some(1),
        ..movie()
    };
    assert!(!mark_shared_works(Some(&fake), &items, &series, 2)[0].shared_by_other_works);
    assert!(!mark_shared_works(Some(&fake), &items, &movie(), 0)[0].shared_by_other_works);
    assert_eq!(*fake.asked.lock().unwrap(), 0);
    assert!(!mark_shared_works(None, &items, &movie(), 2)[0].shared_by_other_works);
}

/// O cortado não entra em `entered_raw`: é isso que preserva a marca
/// `passed_filter` da obra e mantém a evidência de pé.
#[test]
fn magnet_alheio_sai_da_lista_e_nao_conta_como_entrada() {
    let foreign = {
        let mut raw = raw_item_from_value(&json!({
            "title": "A Grande Muralha (2017) BluRay [LEGENDADO]",
            "infoHash": H1,
            "magnet": format!("magnet:?xt=urn:btih:{H1}&dn=Kong.Skull.Island.2017.1080p.HDRip"),
            "isBr": true,
        }));
        raw.shared_by_other_works = true;
        raw
    };
    let own = raw_item_from_value(&json!({
        "title": "A Grande Muralha (2017) BluRay 1080p",
        "infoHash": H2,
        "magnet": format!("magnet:?xt=urn:btih:{H2}&dn=The.Great.Wall.2016.1080p.WEB-DL"),
        "isBr": true,
    }));
    let ctx = BuildContext {
        names: vec!["A Grande Muralha".to_string(), "The Great Wall".to_string()],
        year: "2017".to_string(),
        ..BuildContext::default()
    };
    let built = build_stream_list(
        &[foreign, own],
        &ctx,
        &BuildOptions::default(),
        &mut NoDebridCheck,
        &Default::default(),
    );
    let hashes = |list: &[RawItem]| list.iter().map(RawItem::hash).collect::<Vec<_>>();
    assert_eq!(hashes(&built.filtered_raw), vec![H2.to_string()]);
    assert_eq!(hashes(&built.entered_raw), vec![H2.to_string()]);
}
