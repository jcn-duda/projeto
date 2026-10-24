//! Reconhecimento de forma e guardas de sitemap.

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use std::sync::LazyLock;

use crate::sitemap::types::{SitemapScopeError, SitemapShape};

static COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<!--.*?-->").unwrap());

static STRIP_COMMENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<!--.*?(?:-->|$)").unwrap());

/// Remove comentários HTML/XML sem substituir por espaço (`sitemap-guard.ts:7`).
pub fn without_html_comments(source: &str) -> String {
    COMMENT_RE.replace_all(source, "").to_string()
}

/// Remove comentários HTML com a semântica do navegador (`shared.ts:121`).
pub fn strip_html_comments(source: &str) -> String {
    STRIP_COMMENT_RE.replace_all(source, " ").to_string()
}

static XML_SHAPE_FANCY_RE: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r"(?i)<(?:urlset|sitemapindex|sitemap|url|loc)(?=[\s/>])").unwrap()
});

/// XML estrutural, sem confundir imagem isolada, comentário ou página HTML (`sitemap-guard.ts:11`).
pub fn is_xml_sitemap_shape(source: &str) -> bool {
    let clean = without_html_comments(source);
    XML_SHAPE_FANCY_RE.is_match(&clean).unwrap_or(false)
}

static VACA_TABLE_FANCY_RE: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(
        r#"(?is)<table\b(?=[^>]*\bid\s*=\s*["']sitemap["'])[^>]*>.*?<thead\b[^>]*>.*?<th\b[^>]*>\s*URL\s*</th>.*?<th\b[^>]*>\s*Images\s*</th>.*?<th\b[^>]*>\s*Last Modified\s*</th>.*?</thead>.*?<tbody\b[^>]*>.*?</tbody>.*?</table>"#
    ).unwrap()
});

/// O viewer Yoast do Vaca só é reconhecido pela tabela e cabeçalhos próprios (`sitemap-guard.ts:16`).
pub fn is_vaca_sitemap_shape(source: &str) -> bool {
    let text = without_html_comments(source);
    if is_xml_sitemap_shape(&text) {
        return true;
    }
    VACA_TABLE_FANCY_RE.is_match(&text).unwrap_or(false)
}

static XML_SHAPE_SIMPLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<(?:urlset|sitemapindex|sitemap|url)\b|<loc\b").unwrap());

static VIEWER_SHAPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<td\b[^>]*\bclass="[^"]*\bleft\b"#).unwrap());

/// Em que formato o site respondeu este sitemap (`redetorrent-discovery.ts:142`).
pub fn sitemap_shape(source: &str) -> SitemapShape {
    let text = without_html_comments(source);
    if is_xml_sitemap_shape(&text) || XML_SHAPE_SIMPLE_RE.is_match(&text) {
        SitemapShape::Xml
    } else if VIEWER_SHAPE_RE.is_match(&text) || is_vaca_sitemap_shape(&text) {
        SitemapShape::Viewer
    } else {
        SitemapShape::Unknown
    }
}

/// Uma resposta 200 só prova descoberta quando há estrutura reconhecida e uma
/// URL de obra no escopo (`sitemap-guard.ts:22`).
pub fn assert_sitemap_scope(
    parsed_rows: usize,
    scoped_work_rows: usize,
    shape_recognized: bool,
) -> Result<(), SitemapScopeError> {
    if parsed_rows == 0 && !shape_recognized {
        return Err(SitemapScopeError::FormatoDesconhecido);
    }
    if parsed_rows == 0 {
        return Err(SitemapScopeError::SemEntradasReconhecidas);
    }
    if scoped_work_rows == 0 {
        return Err(SitemapScopeError::SemObrasDoEscopo);
    }
    Ok(())
}

/// O erro de formato é fixo; não repita nele a URL nem o corpo do fetch (`sitemap-guard.ts:33`).
pub fn sitemap_failure_message(loc: &str, reason: &str) -> String {
    if reason == "sitemap_formato_desconhecido" {
        reason.to_string()
    } else {
        format!("{loc}: {reason}")
    }
}
