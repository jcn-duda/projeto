//! Corpus de TÍTULOS (`scripts/golden/corpus-search-name-helpers.json`): para
//! cada caso de `resolveSearchNames`, a fonte NATIVA (`meta_from_lookup`) e a
//! rota Node (`meta_from_response`) têm que montar o MESMO `SearchMeta`
//! (nome, aliases ORDENADOS, ano/altYear, queries derivadas).
//!
//! O corpus é o mesmo que prende `adom-core::resolve_search_names`; aqui ele
//! responde à pergunta do C5: "o caminho nativo preserva títulos/aliases/ano do
//! Node?". A montagem vem de `build_search_meta`, compartilhada pelas duas
//! fontes — o teste pega assimetria na ENTRADA (campo que o nativo não lê).

use serde_json::Value;

use adom_core::dedupe_names;
use adom_sources::{EpisodeAired, MediaType, MetaLookup};

use crate::internal_types::MetaResponse;
use crate::orchestrator::meta::{meta_from_response, MetaQuery};
use crate::orchestrator::meta_native::meta_from_lookup;

const CORPUS: &str = include_str!("../../../../../scripts/golden/corpus-search-name-helpers.json");

fn text_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// `valor || fallback` do JS para o ANO: número `0` é falsy (o corpus tem
/// `year:0`), mas a string `"0"` não é. O cliente Cinemeta normalizado nunca
/// grava número cru — o corpus exercita a colcha de retalhos do TS.
fn year_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) if number.as_f64() != Some(0.0) => Some(number.to_string()),
        _ => None,
    }
}

/// `MetaLookup` a partir do wire do corpus, com as MESMAS coerções dos clientes
/// (`cinemeta.ts`/`tmdb.ts`): nome não vazio, ano via `catalog_year_of`, aliases
/// BR na ordem publicada.
fn lookup_from(meta: Option<&Value>, titles: Option<&Value>, imdb: &str) -> MetaLookup {
    let meta_name = meta
        .and_then(|meta| meta.get("name").or_else(|| meta.get("title")))
        .and_then(|value| text_of(Some(value)));
    let pt = titles
        .and_then(|titles| titles.get("pt"))
        .and_then(|value| text_of(Some(value)));
    let en = titles
        .and_then(|titles| titles.get("en"))
        .and_then(|value| text_of(Some(value)));
    let original = titles
        .and_then(|titles| titles.get("original"))
        .and_then(|value| text_of(Some(value)));
    let titles_year = titles
        .and_then(|titles| titles.get("year"))
        .and_then(|value| year_of(Some(value)));
    let meta_year = meta
        .and_then(|meta| meta.get("year"))
        .and_then(|value| year_of(Some(value)));
    let aliases_br: Vec<String> = titles
        .and_then(|titles| titles.get("br"))
        .and_then(Value::as_array)
        .map(|list| {
            let mut out: Vec<String> = Vec::new();
            for alias in list.iter().filter_map(Value::as_str) {
                if !alias.is_empty() && !out.iter().any(|known| known == alias) {
                    out.push(alias.to_string());
                }
            }
            out
        })
        .unwrap_or_default();
    // Ordem do `resolveSearchNames`: meta, en, pt, original, aliases BR — com o
    // dedupe do núcleo (o corpus tem `["A", null, "A"]`).
    let mut raw_names: Vec<Option<&str>> = vec![
        meta_name.as_deref(),
        en.as_deref(),
        pt.as_deref(),
        original.as_deref(),
    ];
    raw_names.extend(aliases_br.iter().map(|alias| Some(alias.as_str())));
    let names = dedupe_names(&raw_names);
    let mut lookup = MetaLookup::empty(imdb, MediaType::Movie);
    lookup.year = adom_core::catalog_year_of(meta_year.as_deref(), titles_year.as_deref())
        .map(str::to_string);
    lookup.alt_year = adom_core::catalog_alt_year_of(meta_year.as_deref(), titles_year.as_deref());
    lookup.meta_name = meta_name;
    lookup.title_pt = pt;
    lookup.title_en = en;
    lookup.title_original = original;
    lookup.titles_year = titles_year;
    lookup.aliases_br = aliases_br;
    lookup.names = names;
    if let Some(aired) = meta
        .and_then(|meta| meta.get("episodeAired"))
        .and_then(Value::as_object)
    {
        lookup.episode_aired = aired
            .iter()
            .filter_map(|(key, date)| {
                let (season, episode) = key.split_once(':')?;
                Some(EpisodeAired {
                    season: season.parse().ok()?,
                    episode: episode.parse().ok()?,
                    date: date.as_str().filter(|date| !date.is_empty())?.to_string(),
                })
            })
            .collect();
    }
    if let Some(first_aired) = meta
        .and_then(|meta| meta.get("firstAired"))
        .and_then(|value| text_of(Some(value)))
    {
        lookup.first_aired = Some(first_aired);
    }
    lookup
}

#[test]
fn corpus_de_titulos_nativo_igual_ao_node() {
    let corpus: Value = serde_json::from_str(CORPUS).expect("corpus");
    let mut comparados = 0usize;
    let mut pulados = 0usize;
    for case in corpus["cases"].as_array().expect("cases") {
        let input: Value =
            serde_json::from_str(case["input"].as_str().expect("input")).expect("input JSON");
        if input["op"].as_str() != Some("resolveSearchNames") {
            continue;
        }
        let meta = input.get("meta").filter(|value| !value.is_null());
        let titles = input.get("titles").filter(|value| !value.is_null());
        // Só shapes simples: o corpus também cobre `buildSearchQuery` etc.
        if meta.is_some_and(|meta| !meta.is_object()) || titles.is_some_and(|t| !t.is_object()) {
            pulados += 1;
            continue;
        }
        let imdb = input
            .get("imdbId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .unwrap_or("tt0000000");
        let response: MetaResponse = serde_json::from_value(serde_json::json!({
            "ok": true,
            "type": "movie",
            "id": imdb,
            "imdb_id": imdb,
            "meta": meta.cloned().unwrap_or(Value::Null),
            "titles": titles.cloned().unwrap_or(Value::Null),
        }))
        .expect("resposta");
        let query = MetaQuery {
            encoded: "e30".into(),
            kind: "movie".into(),
            id: imdb.into(),
            include_multiwork: false,
            include_home_release: false,
            deadline_at_ms: None,
        };
        let via_node = meta_from_response(&response, &query);
        let via_native = meta_from_lookup(&lookup_from(meta, titles, imdb), &query);
        let caso = case["id"].as_str().unwrap_or("?");
        assert_eq!(via_native.name, via_node.name, "nome — caso {caso}");
        assert_eq!(via_native.names, via_node.names, "aliases — caso {caso}");
        assert_eq!(
            via_native.year_text(),
            via_node.year_text(),
            "ano — caso {caso}"
        );
        assert_eq!(
            via_native.alt_year, via_node.alt_year,
            "altYear — caso {caso}"
        );
        assert_eq!(via_native.query, via_node.query, "query — caso {caso}");
        assert_eq!(
            via_native.pt_query, via_node.pt_query,
            "query pt-BR — caso {caso}"
        );
        assert_eq!(
            via_native.sweep_query, via_node.sweep_query,
            "varredura pt — caso {caso}"
        );
        assert_eq!(
            via_native.original_query, via_node.original_query,
            "degrau original — caso {caso}"
        );
        comparados += 1;
    }
    assert!(
        comparados >= 20,
        "corpus pequeno demais: {comparados} comparados, {pulados} pulados"
    );
}
