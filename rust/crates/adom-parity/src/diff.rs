//! Comparador de respostas normalizadas com diff legível.
//!
//! A comparação é por **identidade** (`infoHash` → `/resolve/<hash>` → URL →
//! `externalUrl` → título), não por posição crua: um item que sumiu não deve
//! transformar os seguintes em divergência em cascata. Cada entrada carrega o
//! índice no lado esperado (Node), o campo e os dois valores; o `Display`
//! produz uma linha pronta para o log/CI.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;
use serde_json::Value;

use crate::normalize::{NormalizedResponse, NormalizedStream};

/// Uma diferença pontual. `index` é o índice do stream no lado esperado
/// (Node); para um item extra, é o índice no lado obtido.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffEntry {
    pub index: Option<usize>,
    pub field: String,
    pub expected: Value,
    pub actual: Value,
}

/// Lista ordenada de diferenças. Vazia = paridade.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Diff {
    pub entries: Vec<DiffEntry>,
}

impl Diff {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Quantos streams divergiram (não quantos campos): é a magnitude do diff.
    pub fn divergent_streams(&self) -> usize {
        self.entries
            .iter()
            .filter_map(|entry| entry.index)
            .collect::<BTreeSet<_>>()
            .len()
    }

    /// Compara duas respostas já normalizadas.
    pub fn compare(expected: &NormalizedResponse, actual: &NormalizedResponse) -> Self {
        let mut entries = Vec::new();
        compare_envelope(expected, actual, &mut entries);
        if expected.streams.len() != actual.streams.len() {
            entries.push(DiffEntry {
                index: None,
                field: "streams.length".to_string(),
                expected: Value::from(expected.streams.len()),
                actual: Value::from(actual.streams.len()),
            });
        }
        for (expected_index, actual_index) in align_streams(expected, actual) {
            match (expected_index, actual_index) {
                (Some(expected_index), Some(actual_index)) => {
                    compare_stream(
                        expected_index,
                        &expected.streams[expected_index],
                        &actual.streams[actual_index],
                        &mut entries,
                    );
                }
                (Some(expected_index), None) => entries.push(DiffEntry {
                    index: Some(expected_index),
                    field: format!("streams[{expected_index}]"),
                    expected: expected.streams[expected_index].to_value(),
                    actual: Value::Null,
                }),
                (None, Some(actual_index)) => entries.push(DiffEntry {
                    index: Some(actual_index),
                    field: format!("streams[{actual_index}]"),
                    expected: Value::Null,
                    actual: actual.streams[actual_index].to_value(),
                }),
                (None, None) => {}
            }
        }
        Self { entries }
    }
}

fn compare_envelope(
    expected: &NormalizedResponse,
    actual: &NormalizedResponse,
    entries: &mut Vec<DiffEntry>,
) {
    let keys: BTreeSet<&String> = expected.fields.keys().chain(actual.fields.keys()).collect();
    for key in keys {
        let left = expected.fields.get(key);
        let right = actual.fields.get(key);
        if left == right {
            continue;
        }
        entries.push(DiffEntry {
            index: None,
            field: key.clone(),
            expected: left.cloned().unwrap_or(Value::Null),
            actual: right.cloned().unwrap_or(Value::Null),
        });
    }
}

fn compare_stream(
    index: usize,
    expected: &NormalizedStream,
    actual: &NormalizedStream,
    entries: &mut Vec<DiffEntry>,
) {
    let keys: BTreeSet<&String> = expected.fields.keys().chain(actual.fields.keys()).collect();
    for key in keys {
        let left = expected.fields.get(key);
        let right = actual.fields.get(key);
        if left == right {
            continue;
        }
        entries.push(DiffEntry {
            index: Some(index),
            field: format!("streams[{index}].{key}"),
            expected: left.cloned().unwrap_or(Value::Null),
            actual: right.cloned().unwrap_or(Value::Null),
        });
    }
}

/// Casa os streams por identidade preservando duplicatas na ordem em que
/// aparecem. Identidade que só existe de um lado vira item ausente/extra.
fn align_streams(
    expected: &NormalizedResponse,
    actual: &NormalizedResponse,
) -> Vec<(Option<usize>, Option<usize>)> {
    let expected_groups = group_by_identity(&expected.streams);
    let actual_groups = group_by_identity(&actual.streams);
    let keys: BTreeSet<&String> = expected_groups.keys().chain(actual_groups.keys()).collect();
    let mut pairs = Vec::new();
    for key in keys {
        let left = expected_groups.get(key).map(Vec::as_slice).unwrap_or(&[]);
        let right = actual_groups.get(key).map(Vec::as_slice).unwrap_or(&[]);
        for index in 0..left.len().max(right.len()) {
            pairs.push((left.get(index).copied(), right.get(index).copied()));
        }
    }
    pairs
}

fn group_by_identity(streams: &[NormalizedStream]) -> BTreeMap<String, Vec<usize>> {
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, stream) in streams.iter().enumerate() {
        groups.entry(stream.identity()).or_default().push(index);
    }
    groups
}

impl fmt::Display for Diff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.entries.is_empty() {
            return f.write_str("sem diferenças");
        }
        for (index, entry) in self.entries.iter().enumerate() {
            if index > 0 {
                writeln!(f)?;
            }
            write!(f, "{}", entry)?;
        }
        Ok(())
    }
}

impl fmt::Display for DiffEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: esperado={} obtido={}",
            self.field,
            render_value(&self.expected),
            render_value(&self.actual)
        )
    }
}

fn render_value(value: &Value) -> String {
    if value.is_null() {
        return "<ausente>".to_string();
    }
    let text = serde_json::to_string(value).unwrap_or_else(|_| "<inválido>".to_string());
    const LIMIT: usize = 240;
    if text.chars().count() <= LIMIT {
        text
    } else {
        let mut truncated: String = text.chars().take(LIMIT).collect();
        truncated.push('…');
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::{normalize_body, NormalizeOptions};
    use serde_json::json;

    fn normalized(streams: Value, cache_max_age: u32) -> NormalizedResponse {
        normalize_body(
            &json!({"streams": streams, "cacheMaxAge": cache_max_age}),
            &NormalizeOptions::default(),
        )
        .expect("corpo de teste")
    }

    #[test]
    fn diff_por_identidade_e_campo_legivel() {
        let expected = normalized(
            json!([
                {"infoHash": "aa", "title": "A", "size": "1 GB"},
                {"infoHash": "bb", "title": "B", "size": "2 GB"}
            ]),
            0,
        );
        let actual = normalized(
            json!([
                {"infoHash": "bb", "title": "B", "size": "2 GB"},
                {"infoHash": "aa", "title": "A mudou", "size": "1 GB"}
            ]),
            0,
        );
        let diff = Diff::compare(&expected, &actual);
        assert_eq!(diff.len(), 1, "{diff}");
        assert_eq!(diff.entries[0].field, "streams[0].title");
        assert_eq!(diff.entries[0].expected, json!("A"));
        assert_eq!(diff.entries[0].actual, json!("A mudou"));
        assert_eq!(diff.divergent_streams(), 1);
    }

    #[test]
    fn item_ausente_nao_gera_cascata_nos_demais() {
        let expected = normalized(
            json!([
                {"infoHash": "aa", "title": "A"},
                {"infoHash": "bb", "title": "B"}
            ]),
            0,
        );
        let actual = normalized(json!([{"infoHash": "bb", "title": "B"}]), 0);
        let diff = Diff::compare(&expected, &actual);
        // Uma entrada de contagem + uma do item ausente; `bb` casa por identidade.
        assert_eq!(diff.len(), 2, "{diff}");
        assert!(diff.entries.iter().any(|e| e.field == "streams.length"));
        assert!(diff
            .entries
            .iter()
            .any(|e| e.field == "streams[0]" && e.actual.is_null()));
        assert!(!diff
            .entries
            .iter()
            .any(|e| e.field.starts_with("streams[1].")));
    }

    #[test]
    fn envelope_diferente_aparece() {
        let expected = normalized(json!([]), 0);
        let actual = normalized(json!([]), 900);
        let diff = Diff::compare(&expected, &actual);
        assert_eq!(diff.len(), 1, "{diff}");
        assert_eq!(diff.entries[0].field, "cacheMaxAge");
        assert!(diff.to_string().contains("cacheMaxAge"));
    }
}
