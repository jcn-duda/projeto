//! Texto JSON de terceiro antes do `serde_json`.
//!
//! O `JSON.parse` do Node aceita surrogate UTF-16 órfão num escape (`\ud83d`
//! sem o `\udcxx` logo depois); o `serde_json` recusa a resposta INTEIRA
//! ("unexpected end of hex escape"). A API do Mico corta título no meio do
//! emoji (`Douglasvip (brazilian) \ud83d…`, medido em 2026-10-26): no porte
//! para o Rust a página ia para `error` e a busca contava falha no breaker.
//! A metade órfã não tem caractere a representar, então ela SAI — trocar por
//! U+FFFD deixaria lixo no título, que a limpeza de emoji não remove.

use std::borrow::Cow;

/// Valor do escape `\uXXXX` que começa em `at`, ou `None` se não for um.
fn unicode_escape_at(bytes: &[u8], at: usize) -> Option<u16> {
    let esc = bytes.get(at..at + 6)?;
    if esc[0] != b'\\' || esc[1] != b'u' {
        return None;
    }
    let hex = std::str::from_utf8(&esc[2..]).ok()?;
    u16::from_str_radix(hex, 16).ok()
}

fn is_high_surrogate(unit: u16) -> bool {
    (0xD800..=0xDBFF).contains(&unit)
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&unit)
}

/// Tira do texto JSON os escapes `\uXXXX` de surrogate sem par. Par válido,
/// escape comum e `\\u` (barra escapada seguida de `u` literal) ficam como
/// estão; sem órfão nada é copiado.
pub fn drop_lone_surrogate_escapes(json: &str) -> Cow<'_, str> {
    let bytes = json.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        let lone = match unicode_escape_at(bytes, i) {
            // Outro escape (`\"`, `\\`, `\n`…) ou `\u` malformado: pula os dois
            // bytes e deixa o veredito para o parser.
            None => {
                i += 2;
                continue;
            }
            Some(unit) if is_high_surrogate(unit) => {
                if matches!(unicode_escape_at(bytes, i + 6), Some(low) if is_low_surrogate(low)) {
                    i += 12;
                    continue;
                }
                true
            }
            Some(unit) => is_low_surrogate(unit),
        };
        if lone {
            // `i` aponta para `\` (ASCII): fronteira de caractere garantida.
            out.get_or_insert_with(|| String::with_capacity(json.len()))
                .push_str(&json[copied..i]);
            copied = i + 6;
        }
        i += 6;
    }
    match out {
        None => Cow::Borrowed(json),
        Some(mut s) => {
            s.push_str(&json[copied..]);
            Cow::Owned(s)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::drop_lone_surrogate_escapes as clean;

    fn title_of(json: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(&clean(json)).expect("JSON válido");
        v["title"].as_str().unwrap().to_string()
    }

    #[test]
    fn surrogate_alto_orfao_sai_e_o_json_passa() {
        let raw = r#"{"title":"Douglasvip (brazilian) \ud83d…\n👥 0"}"#;
        assert!(
            serde_json::from_str::<serde_json::Value>(raw).is_err(),
            "o serde recusa o original"
        );
        assert_eq!(title_of(raw), "Douglasvip (brazilian) …\n👥 0");
    }

    #[test]
    fn orfao_no_fim_da_string_e_baixo_sozinho_tambem_saem() {
        assert_eq!(title_of(r#"{"title":"Filme \uD83D"}"#), "Filme ");
        assert_eq!(title_of(r#"{"title":"a\udc00b"}"#), "ab");
        // A barra vem de `bs` para o escape chegar ao JSON como texto cru.
        let bs = '\\';
        let alto_alto_baixo = format!(r#"{{"title":"{bs}ud83d{bs}ud83d{bs}ude00"}}"#);
        assert_eq!(
            title_of(&alto_alto_baixo),
            "\u{1F600}",
            "só a primeira metade alta é órfã"
        );
    }

    #[test]
    fn par_valido_escape_comum_e_barra_escapada_ficam() {
        let bs = '\\';
        let raw =
            format!(r#"{{"title":"{bs}ud83d{bs}ude00 {bs}u00e9 {bs}"x{bs}" {bs}{bs}ud83d"}}"#);
        assert!(
            matches!(clean(&raw), std::borrow::Cow::Borrowed(_)),
            "sem órfão nada é copiado"
        );
        assert_eq!(title_of(&raw), "\u{1F600} \u{e9} \"x\" \\ud83d");
    }
}
