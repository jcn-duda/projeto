use std::borrow::Cow;
use std::collections::BTreeMap;

use adom_core::DebridFile;
use serde_json::json;

use super::{stamp_proven_quality, year_of};
use crate::orchestrator::meta::SearchMeta;
use crate::raw_item::RawItem;

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

fn item(title: &str) -> RawItem {
    RawItem {
        title: Some(title.to_string()),
        info_hash: Some(HASH.to_string()),
        ..RawItem::default()
    }
}

fn file(path: &str, size: f64) -> DebridFile {
    DebridFile {
        path: path.to_string(),
        size,
    }
}

fn files(list: Vec<DebridFile>) -> BTreeMap<String, Vec<DebridFile>> {
    BTreeMap::from([(HASH.to_string(), list)])
}

fn movie() -> SearchMeta {
    let mut meta = SearchMeta::from_id("tt0103064");
    meta.names = vec!["Terminator 2 Judgment Day".into()];
    meta.year = json!(1991);
    meta
}

#[test]
fn titulo_sem_resolucao_ganha_a_do_arquivo() {
    let items = vec![item("O Exterminador do Futuro 2 Remaster BluRay BR")];
    let map = files(vec![file(
        "T2/Terminator.2.1991.1080p.BluRay.DUAL.mkv",
        9e9,
    )]);
    let out = stamp_proven_quality(&items, &map, &movie());
    assert_eq!(out[0].proven_quality.as_deref(), Some("1080p"));
}

#[test]
fn titulo_com_resolucao_fica_como_esta() {
    let items = vec![item("Terminator 2 1991 720p BluRay")];
    let map = files(vec![file("T2/Terminator.2.1991.2160p.mkv", 9e9)]);
    let out = stamp_proven_quality(&items, &map, &movie());
    assert!(matches!(out, Cow::Borrowed(_)));
    assert_eq!(out[0].proven_quality, None);
}

#[test]
fn sem_lista_ou_nome_sem_resolucao_nao_inventa() {
    let items = vec![item("Exterminador BluRay BR")];
    let none = stamp_proven_quality(&items, &BTreeMap::new(), &movie());
    assert_eq!(none[0].proven_quality, None);
    let map = files(vec![file("T2/Exterminador.do.Futuro.2.mkv", 9e9)]);
    let out = stamp_proven_quality(&items, &map, &movie());
    assert_eq!(out[0].proven_quality, None);
}

#[test]
fn serie_escolhe_o_arquivo_do_episodio() {
    let items = vec![item("Dark 1a Temporada Completa BR")];
    let mut meta = SearchMeta::from_id("tt5753856");
    meta.season = Some(1);
    meta.episode = Some(2);
    let map = files(vec![
        file("Dark/Dark.S01E01.720p.mkv", 1e9),
        file("Dark/Dark.S01E02.1080p.mkv", 2e9),
    ]);
    let out = stamp_proven_quality(&items, &map, &meta);
    assert_eq!(out[0].proven_quality.as_deref(), Some("1080p"));
}

#[test]
fn prova_existente_vence() {
    let mut first = item("Exterminador BluRay BR");
    first.proven_quality = Some("720p".into());
    let map = files(vec![file("T2/Terminator.2.1991.2160p.mkv", 9e9)]);
    let items = [first];
    let out = stamp_proven_quality(&items, &map, &movie());
    assert_eq!(out[0].proven_quality.as_deref(), Some("720p"));
}

#[test]
fn ano_sujo_vira_numero() {
    assert_eq!(year_of(&json!(1991)), Some(1991));
    assert_eq!(year_of(&json!("2024–")), Some(2024));
    assert_eq!(year_of(&json!(null)), None);
}
