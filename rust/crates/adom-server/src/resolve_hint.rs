//! Leitura da URL do play: `?s=S&e=E` e a dica `w` assinada pelo build. Mesma
//! régua do handler TS que saiu na fase C (comparações estritas). Separado do
//! `resolve_native.rs` pela catraca de 400 linhas.

use serde_json::Value;

/// `?s=<S>&e=<E>` (só existe quando os dois vieram). Números inválidos viram
/// `None`, como o `Number(x)` com `NaN` não casa o seletor.
pub(crate) fn ep_parts(ep: &str) -> (Option<i64>, Option<i64>) {
    let Some(rest) = ep.strip_prefix("?s=") else {
        return (None, None);
    };
    let Some((season, episode)) = rest.split_once("&e=") else {
        return (None, None);
    };
    (season.parse().ok(), episode.parse().ok())
}

/// Dica `w` do build: `{n:[...], y:ano, p:1, d:1}` — nomes limitados a 4, como
/// o `.slice(0, 4)` do Node.
pub(crate) fn parse_hint_json(raw: &str) -> (Vec<String>, Option<i64>, bool, bool) {
    let Some(map) = hint_object(raw) else {
        return (Vec::new(), None, false, false);
    };
    let names = map
        .get("n")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(4)
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let year = map.get("y").and_then(json_i64).filter(|year| *year != 0);
    let pack = is_one(map.get("p"));
    let dubbed = is_one(map.get("d"));
    (names, year, pack, dubbed)
}

/// `i` da dica (`/^tt\d+$/`): a obra que os efeitos do play invalidam e marcam
/// no índice. Sem ela o Node também não invalida nada (nunca limpa global).
pub(crate) fn hint_imdb(raw: &str) -> String {
    hint_object(raw)
        .and_then(|map| map.get("i").and_then(Value::as_str).map(str::to_string))
        .filter(|id| {
            id.strip_prefix("tt").is_some_and(|digits| {
                !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
            })
        })
        .unwrap_or_default()
}

fn hint_object(raw: &str) -> Option<serde_json::Map<String, Value>> {
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn is_one(value: Option<&Value>) -> bool {
    // `parsed.p === 1` / `parsed.d === 1` no TS: comparação ESTRITA. A dica é
    // gerada pelo build com número 1; string `"1"` não liga (e um hint forjado
    // assinado pelo próprio usuário não pode divergir do Node).
    match value {
        Some(Value::Number(number)) => number.as_i64() == Some(1) || number.as_f64() == Some(1.0),
        _ => false,
    }
}

fn json_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().filter(|n| n.is_finite()).map(|n| n as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hint_w_estrito_como_o_node() {
        let (names, year, pack, dubbed) =
            parse_hint_json(r#"{"n":["Filme"],"y":2024,"p":1,"d":1}"#);
        assert_eq!(names, vec!["Filme"]);
        assert_eq!(year, Some(2024));
        assert!(pack);
        assert!(dubbed);
        // `"1"` string não liga `p`/`d` (o TS compara `=== 1`).
        let (_, _, pack, dubbed) = parse_hint_json(r#"{"n":["Filme"],"p":"1","d":"1"}"#);
        assert!(!pack);
        assert!(!dubbed);
        // Dica ilegível é ausente, nunca erro de rota.
        assert_eq!(
            parse_hint_json("não-json"),
            (Vec::new(), None, false, false)
        );
    }

    #[test]
    fn s_e_so_existem_juntos() {
        assert_eq!(ep_parts("?s=2&e=5"), (Some(2), Some(5)));
        assert_eq!(ep_parts(""), (None, None));
        assert_eq!(ep_parts("?s=abc&e=5"), (None, Some(5)));
    }

    #[test]
    fn imdb_da_dica_so_no_formato_tt() {
        assert_eq!(hint_imdb(r#"{"n":["Filme"],"i":"tt0293007"}"#), "tt0293007");
        assert_eq!(hint_imdb(r#"{"i":"tt"}"#), "");
        assert_eq!(hint_imdb(r#"{"i":"tt12x"}"#), "");
        assert_eq!(hint_imdb(r#"{"i":123}"#), "");
        assert_eq!(hint_imdb(""), "");
        assert_eq!(hint_imdb("não-json"), "");
    }
}
