//! Chave de identidade da página no `crawl.db`: o CAMINHO, não a URL.
//!
//! Os sites BR trocam de domínio com frequência. Com a URL inteira como
//! chave, cada migração de host nasceria uma fila nova: o acervo duplica
//! e o teto por hora queima relendo página que já existe. O caminho faz a
//! redescoberta no host novo cair na mesma linha.

use url::Url;

/// Espelho de `crawlUrlKey` (`src/utils/crawl-url-key.ts`).
///
/// Sem esquema/host, sem query, sem fragmento, `//` colapsada e barra
/// final fora (a raiz `/` permanece). Nunca lança. Nunca devolve vazio
/// para entrada não vazia: chave vazia colapsaria a fila do site.
///
/// URL absoluta usa o pathname do parser WHATWG (`url`, o mesmo modelo
/// do `new URL` do Node). `Url::path` nesta versão é percent-encoded:
/// `%2F` não vira barra. Sem host, o caminho é puro. `scheme://host` que
/// o parser recusa também perde o host — é a intenção da chave.
pub fn crawl_url_key(raw: &str) -> String {
    let text = raw.trim_matches(is_js_whitespace);
    if text.is_empty() {
        return String::new();
    }
    match Url::parse(text) {
        Ok(url) => normalize_path(url.path()),
        Err(_) => fallback_path(text),
    }
}

/// `String.prototype.trim` do JS: tab, separadores de linha, BOM e Zs.
/// O `trim` do Rust também come U+0085, que o JS deixa.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// Corta query e fragmento — o que não é identidade de página.
fn strip_query(url: &str) -> &str {
    let no_hash = url.split_once('#').map(|(head, _)| head).unwrap_or(url);
    no_hash.split_once('?').map(|(head, _)| head).unwrap_or(no_hash)
}

fn collapse_slashes(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut prev_slash = false;
    for c in path.chars() {
        if c == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(c);
    }
    out
}

fn normalize_path(path: &str) -> String {
    let cut = strip_query(path);
    if cut.is_empty() {
        return "/".to_string();
    }
    let collapsed = collapse_slashes(cut);
    // `length` do JS é em code units. `/` sozinha tem tamanho 1 e fica;
    // qualquer caminho mais longo que termina em barra perde a barra.
    if collapsed.chars().count() > 1 && collapsed.ends_with('/') {
        let trimmed = collapsed.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    } else {
        collapsed
    }
}

/// Sem host: caminho puro. `scheme://host` que não passou no parser
/// também perde o host.
fn fallback_path(text: &str) -> String {
    let cut = strip_query(text);
    let Some(scheme_at) = cut.find("://") else {
        return normalize_path(cut);
    };
    let after_host = &cut[scheme_at + 3..];
    match after_host.find('/') {
        Some(slash_at) => normalize_path(&after_host[slash_at..]),
        None => normalize_path("/"),
    }
}
