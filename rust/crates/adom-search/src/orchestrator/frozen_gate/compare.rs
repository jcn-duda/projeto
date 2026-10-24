//! Comparador e mascara do corpus (`stream-frozen-store.maskString`).

use serde_json::Value;

pub(super) fn compare(
    got: &Value,
    expected: &Value,
    origin: &str,
    encoded: &str,
) -> Result<(), String> {
    let got = normalize(got, origin, encoded);
    let expected = normalize(expected, origin, encoded);
    if got == expected {
        return Ok(());
    }
    let got_streams = streams_of(&got);
    let want_streams = streams_of(&expected);
    let mut lines = vec![format!(
        "total got={} want={}; cacheMaxAge got={} want={}",
        got_streams.len(),
        want_streams.len(),
        got.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
        expected.get("cacheMaxAge").cloned().unwrap_or(Value::Null),
    )];
    lines.extend(stream_diff_lines(&got_streams, &want_streams));
    Err(lines.join("\n"))
}

/// Comparador da sombra: só `streams`, mesma máscara/ordenação do gate.
pub(super) fn compare_streams(
    got: &Value,
    expected: &Value,
    origin: &str,
    encoded: &str,
) -> Result<(), String> {
    let got_streams = streams_of(&normalize(got, origin, encoded));
    let want_streams = streams_of(&normalize(expected, origin, encoded));
    if got_streams == want_streams {
        return Ok(());
    }
    let mut lines = vec![format!(
        "streams divergentes: got={} want={}",
        got_streams.len(),
        want_streams.len(),
    )];
    lines.extend(stream_diff_lines(&got_streams, &want_streams));
    Err(lines.join("\n"))
}

pub(super) fn streams_of(value: &Value) -> Vec<Value> {
    value
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Diff item a item (uma linha `#<índice>` por divergência).
pub(super) fn stream_diff_lines(got_streams: &[Value], want_streams: &[Value]) -> Vec<String> {
    let mut lines = Vec::new();
    for (index, want) in want_streams.iter().enumerate() {
        let have = got_streams.get(index);
        if have == Some(want) {
            continue;
        }
        lines.push(format!(
            "#{index} want={} got={}",
            short(want),
            have.map(short).unwrap_or_else(|| "<ausente>".to_string())
        ));
        if let Some(have) = have {
            lines.push(format!("  want_json={want}"));
            lines.push(format!("  got_json ={have}"));
        }
    }
    for (index, have) in got_streams.iter().enumerate().skip(want_streams.len()) {
        lines.push(format!("#{index} extra got={}", short(have)));
    }
    lines
}

pub(super) fn normalize(value: &Value, origin: &str, encoded: &str) -> Value {
    let mut out = value.clone();
    if let Some(object) = out.as_object_mut() {
        if let Some(Value::Array(streams)) = object.get_mut("streams") {
            for stream in streams.iter_mut() {
                mask(stream, origin, encoded);
                if let Some(sources) = stream.get_mut("sources").and_then(Value::as_array_mut) {
                    sources.sort_by_key(|value| value.as_str().unwrap_or("").to_string());
                }
            }
            streams.sort_by_key(stream_key);
        }
    }
    out
}

pub(super) fn stream_key(value: &Value) -> String {
    for field in ["infoHash", "url", "externalUrl", "name"] {
        if let Some(text) = value.get(field).and_then(Value::as_str) {
            return format!("{field}:{text}");
        }
    }
    String::new()
}

pub(super) fn mask(value: &mut Value, origin: &str, encoded: &str) {
    match value {
        Value::String(text) => *text = mask_text(text, origin, encoded),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| mask(item, origin, encoded)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| mask(item, origin, encoded)),
        _ => {}
    }
}

/// O corpus é gravado mascarado (`{{base}}/{{config}}`), mas o Rust monta a URL
/// com o origin/encoded do replay; normaliza os dois lados antes do diff.
pub(super) fn mask_text(text: &str, origin: &str, encoded: &str) -> String {
    // MESMA ordem do `stream-frozen-store.maskString` do Node: `sig` PRIMEIRO,
    // depois encoded, depois origin. Mascarar o encoded antes do sig substitui
    // `e30` que apareça DENTRO da assinatura e cria `sig={{sig}}{{config}}…`
    // no lado Rust (falso positivo medido no gate: Breaking Bad/GOT).
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("sig=") {
        out.push_str(&rest[..index + 4]);
        out.push_str("{{sig}}");
        let after = &rest[index + 4..];
        let end = after
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    if !encoded.is_empty() {
        // O record do Node mascara o segmento por SUBSTITUIÇÃO GLOBAL
        // (`stream-frozen-store.maskString`: `split(encoded).join(...)`), então
        // um hash que contém `e30` chega no `expected` já como
        // `…{{config}}…`. O lado Rust nasce cru: mascarar só `/{encoded}/`
        // deixava esses itens divergentes sem nenhuma diferença real (medido
        // nos 512: `90d327…e30…` virava falso positivo).
        out = out.replace(encoded, "{{config}}");
    }
    if !origin.is_empty() {
        out = out.replace(origin, "{{base}}");
    }
    // O corpus gravou `sig={{sig}}` e o envelope mascara de novo; idempotência
    // vale para os dois lados do diff.
    out.replace("{{sig}}{{sig}}", "{{sig}}")
}

pub(super) fn short(value: &Value) -> String {
    let hash = value
        .get("infoHash")
        .and_then(Value::as_str)
        .map(|text| &text[..text.len().min(10)])
        .unwrap_or("-");
    let name = value.get("name").and_then(Value::as_str).unwrap_or("-");
    format!("{hash} | {name}")
}
