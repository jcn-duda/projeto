//! Port de `resolvers/text.ts` — funções puras de manipulação de texto.
//!
//! Inclui remoção de tags HTML, escape XML e parsing de rótulos de tamanho.
//! Para decodificação de entidades HTML, reutiliza `adom_core::decode_entities`.

use regex::Regex;
use std::sync::LazyLock;

// ── Regex compiladas uma vez ─────────────────────────────────────────────────

/// Remove tags HTML: qualquer coisa entre `<` e `>`.
static RE_TAGS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]+>").expect("regex de tags válida"));

/// Captura rótulo de tamanho: número (com vírgula ou ponto) + unidade.
static RE_SIZE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([\d.,]+)\s*(TB|GB|MB|KB)").expect("regex de tamanho válida")
});

/// Normaliza espaços em branco (2+ espaços/tabs/newlines → 1 espaço).
static RE_WHITESPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("regex de whitespace válida"));

// ── Funções públicas ─────────────────────────────────────────────────────────

/// Remove tags HTML de um texto, decodifica entidades e normaliza espaços.
///
/// Equivalente a `stripTags` em `resolvers/text.ts:45-47`.
/// Usa `adom_core::decode_entities` como decodificador padrão.
pub fn strip_tags(html: &str) -> String {
    strip_tags_with(html, adom_core::decode_entities)
}

/// Remove tags HTML usando um decodificador de entidades personalizado.
///
/// Permite usar `decodeEntitiesBasic` (NerdFilmes/TorrentDosFilmes) quando
/// necessário, preservando a semântica histórica desses perfis.
pub fn strip_tags_with(html: &str, decode: fn(&str) -> String) -> String {
    // TS: String(value).replace(/<[^>]+>/g, ' ')
    let without_tags = RE_TAGS.replace_all(html, " ");
    // TS: decode(...).replace(/\s+/g, ' ').trim()
    let decoded = decode(&without_tags);
    let normalized = RE_WHITESPACE.replace_all(&decoded, " ");
    normalized.trim().to_string()
}

/// Escapa caracteres especiais para XML/HTML.
///
/// Equivalente a `escapeXml` em `resolvers/text.ts:57-63`.
/// Escapa: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`.
pub fn escape_xml(text: &str) -> String {
    // A ordem importa: `&` deve ser escapado primeiro para não double-escapar.
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Alias de [`escape_xml`] — no TS original, `escapeHtml = escapeXml`.
pub fn escape_html(text: &str) -> String {
    escape_xml(text)
}

/// Converte rótulo de tamanho ("1.5 GB", "700 MB") para bytes.
///
/// Equivalente a `parseSize` em `resolvers/text.ts:49-55` e
/// `parseSizeBytes` em `internal-crawl-result.ts:58-66`.
///
/// Suporta vírgula como separador decimal (ex: "1,5 GB").
/// Retorna `None` se o texto não contiver um rótulo reconhecível.
pub fn parse_size(text: &str) -> Option<u64> {
    let caps = RE_SIZE.captures(text)?;
    let num_str = caps.get(1)?.as_str().replace(',', ".");
    let value: f64 = num_str.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let unit = caps.get(2)?.as_str().to_uppercase();
    let multiplier: u64 = match unit.as_str() {
        "KB" => 1024,
        "MB" => 1024u64.pow(2),
        "GB" => 1024u64.pow(3),
        "TB" => 1024u64.pow(4),
        _ => return None,
    };
    Some((value * multiplier as f64).round() as u64)
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // strip_tags

    #[test]
    fn strip_tags_remove_html() {
        assert_eq!(strip_tags("<b>Filme</b> <i>2024</i>"), "Filme 2024");
    }

    #[test]
    fn strip_tags_normaliza_espacos() {
        assert_eq!(strip_tags("<p>  Olá   mundo  </p>"), "Olá mundo");
    }

    #[test]
    fn strip_tags_vazio() {
        assert_eq!(strip_tags(""), "");
    }

    #[test]
    fn strip_tags_sem_tags() {
        assert_eq!(strip_tags("texto simples"), "texto simples");
    }

    #[test]
    fn strip_tags_com_entidades() {
        // &amp; deve ser decodificado para &
        assert_eq!(strip_tags("A &amp; B"), "A & B");
    }

    // escape_xml

    #[test]
    fn escape_xml_caracteres_especiais() {
        assert_eq!(escape_xml("A & B <C>"), "A &amp; B &lt;C&gt;");
    }

    #[test]
    fn escape_xml_aspas() {
        assert_eq!(escape_xml(r#"dizer "olá""#), "dizer &quot;olá&quot;");
    }

    #[test]
    fn escape_xml_vazio() {
        assert_eq!(escape_xml(""), "");
    }

    #[test]
    fn escape_xml_sem_caracteres_especiais() {
        assert_eq!(escape_xml("texto simples"), "texto simples");
    }

    #[test]
    fn escape_html_eh_alias() {
        assert_eq!(escape_html("A & B"), escape_xml("A & B"));
    }

    // parse_size

    #[test]
    fn parse_size_gb() {
        // 1.5 * 1024³ = 1_610_612_736
        assert_eq!(parse_size("1.5 GB"), Some(1_610_612_736));
    }

    #[test]
    fn parse_size_mb_com_virgula() {
        // 700.5 * 1024² = 734_527_488 (arredondado)
        assert_eq!(parse_size("700,5 MB"), Some(734_527_488));
    }

    #[test]
    fn parse_size_kb() {
        assert_eq!(parse_size("512 KB"), Some(524_288));
    }

    #[test]
    fn parse_size_tb() {
        // 2 TB = 2 * 1024⁴ = 2_199_023_255_552
        assert_eq!(parse_size("2 TB"), Some(2_199_023_255_552));
    }

    #[test]
    fn parse_size_case_insensitive() {
        assert_eq!(parse_size("1.5 gb"), Some(1_610_612_736));
        assert_eq!(parse_size("500 mb"), Some(524_288_000));
    }

    #[test]
    fn parse_size_sem_match() {
        assert_eq!(parse_size("texto sem tamanho"), None);
    }

    #[test]
    fn parse_size_vazio() {
        assert_eq!(parse_size(""), None);
    }

    #[test]
    fn parse_size_com_texto_extra() {
        // Deve extrair mesmo com texto ao redor
        assert_eq!(parse_size("Tamanho: 700 MB aprox"), Some(734_003_200));
    }
}
