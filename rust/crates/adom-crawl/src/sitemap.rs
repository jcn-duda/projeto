//! Parsers de sitemap genérico + opções por site (parseSitemapEntries, parseSitemapIndexLocs, etc).
//!
//! Porte direto das regras de descoberta por sitemap do TypeScript:
//! - `sitemap-guard.ts` (`isXmlSitemapShape`, `isVacaSitemapShape`, `assertSitemapScope`, `sitemapFailureMessage`)
//! - `vaca-sitemap-viewer.ts` (`parseViewerEntries`)
//! - Adaptadores de site (`bludv-discovery.ts`, `nerdfilmes-discovery.ts`, `comandotorrents-discovery.ts`,
//!   `torrentdosfilmes-discovery.ts`, `redetorrent-discovery.ts`, `vaca.ts`).

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;
use url::Url;

// ── Tipos ───────────────────────────────────────────────────────────────────

/// Tipo da página descoberta (filme ou série).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrawlPageKind {
    Movie,
    TvShow,
}

impl CrawlPageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::TvShow => "tv_show",
        }
    }
}

/// Um par `<loc>` / `<lastmod>` extraído do sitemap ou do visualizador.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SitemapEntry {
    pub loc: String,
    pub lastmod: String,
}

/// Erro de escopo ou reconhecimento do sitemap (`assertSitemapScope`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SitemapScopeError {
    FormatoDesconhecido,
    SemEntradasReconhecidas,
    SemObrasDoEscopo,
}

impl std::fmt::Display for SitemapScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FormatoDesconhecido => write!(f, "sitemap_formato_desconhecido"),
            Self::SemEntradasReconhecidas => write!(f, "sitemap_sem_entradas_reconhecidas"),
            Self::SemObrasDoEscopo => write!(f, "sitemap_sem_obras_do_escopo"),
        }
    }
}

impl std::error::Error for SitemapScopeError {}

/// Formato da resposta de sitemap (`redetorrent-discovery.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SitemapShape {
    Xml,
    Viewer,
    Unknown,
}

impl SitemapShape {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Xml => "xml",
            Self::Viewer => "viewer",
            Self::Unknown => "unknown",
        }
    }
}

/// Opções de parsing de sitemap.
#[derive(Debug, Clone)]
pub struct SitemapParseOptions {
    /// Se `true`, tenta ler a tabela do visualizador (Yoast do Vaca ou AIOSEO do RedeTorrent)
    /// quando o XML não contiver blocos `<loc>`.
    pub fallback_to_viewer: bool,
    /// Se `true`, valida que a data é válida e zera `0000-00-00`.
    pub validate_date: bool,
}

impl Default for SitemapParseOptions {
    fn default() -> Self {
        Self {
            fallback_to_viewer: true,
            validate_date: true,
        }
    }
}

/// Configuração e regras de sitemap específicas por site.
#[derive(Debug, Clone)]
pub struct SitemapSiteConfig {
    pub site_id: &'static str,
    pub index_paths: &'static [&'static str],
    pub post_sitemap_pattern: &'static str,
    pub work_path_regex: Option<&'static str>,
    pub not_work_segments: &'static [&'static str],
    pub season_slug_patterns: &'static [&'static str],
    pub supports_viewer: bool,
}

impl SitemapSiteConfig {
    pub fn vaca() -> Self {
        Self {
            site_id: "vacatorrent",
            index_paths: &["sitemap_index.xml"],
            post_sitemap_pattern: r"(?i)/(?:movie|tv_show)-sitemap\d*\.xml$",
            work_path_regex: Some(r"(?i)/(?:pt/)?(?:movie|tv-shows)/[^/]+/$"),
            not_work_segments: &[],
            season_slug_patterns: &["tv-shows"],
            supports_viewer: true,
        }
    }

    pub fn bludv() -> Self {
        Self {
            site_id: "bludv-cardigann",
            index_paths: &["sitemap_index.xml", "sitemap.xml", "wp-sitemap.xml"],
            post_sitemap_pattern: r"(?i)/post-sitemap\d*\.xml$",
            work_path_regex: None,
            not_work_segments: &[
                "filmes",
                "series",
                "anime",
                "novela",
                "generos",
                "genero",
                "lancamento",
                "qualidades",
                "resolucao",
                "m2ts",
                "mkv",
                "mp4",
                "uncategorized",
                "tag",
                "author",
                "page",
                "feed",
                "wp-json",
                "wp-admin",
                "robots.txt",
                "sitemap.xml",
                "sitemap_index.xml",
                "wp-sitemap.xml",
            ],
            season_slug_patterns: &["temporada", "minis+erie", "serie-completa"],
            supports_viewer: false,
        }
    }

    pub fn nerdfilmes() -> Self {
        Self {
            site_id: "nerdfilmes",
            index_paths: &["sitemap.xml", "sitemap_index.xml"],
            post_sitemap_pattern: r"(?i)/post-sitemap\d*\.xml$",
            work_path_regex: None,
            not_work_segments: &["link.php", "feed", "wp-json", "wp-admin", "robots.txt"],
            season_slug_patterns: &["-1a-temporada-", "-1-temporada-", "temporada"],
            supports_viewer: false,
        }
    }

    pub fn comandotorrents() -> Self {
        Self {
            site_id: "comandotorrents",
            index_paths: &["sitemap.xml", "sitemap_index.xml"],
            post_sitemap_pattern: r"(?i)/post-sitemap\d*\.xml$",
            work_path_regex: None,
            not_work_segments: &["link.php", "feed", "wp-json", "wp-admin", "robots.txt"],
            season_slug_patterns: &["temporada"],
            supports_viewer: false,
        }
    }

    pub fn torrentdosfilmes() -> Self {
        Self {
            site_id: "torrentdosfilmes",
            index_paths: &["sitemap_index.xml", "sitemap.xml"],
            post_sitemap_pattern: r"(?i)/post-sitemap\d*\.xml$",
            work_path_regex: None,
            not_work_segments: &["link.php", "feed", "wp-json", "wp-admin", "robots.txt"],
            season_slug_patterns: &["temporada"],
            supports_viewer: false,
        }
    }

    pub fn redetorrent() -> Self {
        Self {
            site_id: "redetorrent",
            index_paths: &["sitemap.xml", "sitemap_index.xml"],
            post_sitemap_pattern: r"(?i)/(?:movies|tvshows)-sitemap\d*\.xml$",
            work_path_regex: Some(r"(?i)/(?:filmes|series)/[^/]+/$"),
            not_work_segments: &[],
            season_slug_patterns: &["series"],
            supports_viewer: true,
        }
    }

    pub fn default_wordpress() -> Self {
        Self {
            site_id: "wordpress",
            index_paths: &["sitemap_index.xml", "sitemap.xml"],
            post_sitemap_pattern: r"(?i)/post-sitemap\d*\.xml$",
            work_path_regex: None,
            not_work_segments: DEFAULT_NOT_WORK_SEGMENTS,
            season_slug_patterns: &["temporada"],
            supports_viewer: false,
        }
    }

    pub fn is_work_path(&self, path: &str) -> bool {
        if let Some(re_str) = self.work_path_regex {
            if let Ok(re) = Regex::new(re_str) {
                return re.is_match(path);
            }
        }
        is_work_path(path, Some(self.not_work_segments))
    }

    pub fn to_work_url(
        &self,
        loc: &str,
        base: &str,
        is_detail_host: impl Fn(&str) -> bool,
    ) -> Option<Url> {
        let base_url = Url::parse(base).ok()?;
        let href = base_url.join(loc).ok()?;
        let host = href.host_str()?;
        if !is_detail_host(host) {
            return None;
        }
        if self.is_work_path(href.path()) {
            Some(href)
        } else {
            None
        }
    }

    pub fn kind_from_slug(&self, href: &str) -> CrawlPageKind {
        kind_from_slug_with_patterns(href, self.season_slug_patterns)
    }

    pub fn is_season_slug(&self, href: &str) -> bool {
        self.kind_from_slug(href) == CrawlPageKind::TvShow
    }

    pub fn parse_sitemap_index_locs(
        &self,
        xml: &str,
        base: &str,
        is_detail_host: impl Fn(&str) -> bool,
    ) -> Vec<String> {
        let pattern = self.post_sitemap_pattern;
        let re = Regex::new(pattern).ok();
        parse_sitemap_index_locs_matching(xml, base, is_detail_host, move |path| {
            if let Some(ref r) = re {
                r.is_match(path)
            } else {
                path.ends_with(".xml")
            }
        })
    }

    pub fn parse_imdb_id(&self, html: &str) -> Option<String> {
        match self.site_id {
            "vacatorrent" => parse_vaca_imdb_id(html),
            "bludv" | "bludv-cardigann" => parse_bludv_imdb_id(html),
            _ => parse_imdb_id(html),
        }
    }
}

// ── Reconhecimento de Forma e Guardas ───────────────────────────────────────

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

// ── Parsers do Visualizador (HTML) ──────────────────────────────────────────

static VIEWER_ROW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)<tr>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>[^<]*</a>\s*</td>(?:\s*<td>\s*\d+\s*</td>)?\s*<td>\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s*([+-]\d{2}:?\d{2}|Z)?\s*</td>\s*</tr>"#
    ).unwrap()
});

/// Pares loc/lastmod da tabela do viewer do Yoast (`vaca-sitemap-viewer.ts:11`).
pub fn parse_viewer_entries(html: &str) -> Vec<SitemapEntry> {
    let mut out = Vec::new();
    for caps in VIEWER_ROW_RE.captures_iter(html) {
        let href = caps.get(1).map_or("", |m| m.as_str());
        let date = caps.get(2).map_or("", |m| m.as_str());
        let time = caps.get(3).map_or("", |m| m.as_str());
        let tz = match caps.get(4).map(|m| m.as_str()) {
            Some(s) if s != "Z" => {
                if s.contains(':') {
                    s.to_string()
                } else if s.len() >= 5 {
                    format!("{}:{}", &s[..3], &s[3..])
                } else {
                    "+00:00".to_string()
                }
            }
            _ => "+00:00".to_string(),
        };
        let loc = href.replace("&amp;", "&");
        let lastmod = format!("{date}T{time}:00{tz}");
        out.push(SitemapEntry { loc, lastmod });
    }
    out
}

static ISO_DATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$").unwrap());

static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(\d{1,2})\s+(?:de\s+)?([A-Za-z]{3,9})\.?,?\s+(?:de\s+)?(\d{4})$").unwrap()
});

static TIME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$").unwrap());

/// Converte data do visualizador AIOSEO para ISO UTC (`redetorrent-discovery.ts:278`).
pub fn parse_rendered_lastmod(date_raw: &str, time_raw: Option<&str>) -> String {
    let raw = date_raw.trim();
    if raw.is_empty() || raw == "0000-00-00" {
        return String::new();
    }

    let (year, month, day) = if let Some(caps) = ISO_DATE_RE.captures(raw) {
        let y = caps[1].parse::<u32>().unwrap_or(0);
        let m = caps[2].parse::<u32>().unwrap_or(0);
        let d = caps[3].parse::<u32>().unwrap_or(0);
        (y, m, d)
    } else if let Some(caps) = DATE_RE.captures(raw) {
        let d = caps[1].parse::<u32>().unwrap_or(0);
        let m_str = caps[2].to_lowercase();
        let m = match m_str.as_str() {
            "january" | "jan" => 1,
            "february" | "feb" => 2,
            "march" | "mar" => 3,
            "april" | "apr" => 4,
            "may" => 5,
            "june" | "jun" => 6,
            "july" | "jul" => 7,
            "august" | "aug" => 8,
            "september" | "sep" => 9,
            "october" | "oct" => 10,
            "november" | "nov" => 11,
            "december" | "dec" => 12,
            _ => 0,
        };
        let y = caps[3].parse::<u32>().unwrap_or(0);
        (y, m, d)
    } else {
        return String::new();
    };

    if month == 0 || month > 12 || day == 0 || day > 31 || !(1900..=2100).contains(&year) {
        return String::new();
    }

    let (hh, mm, ss) = if let Some(t_str) = time_raw {
        let trimmed = t_str.trim();
        if let Some(caps) = TIME_RE.captures(trimmed) {
            let h = caps[1].parse::<u32>().unwrap_or(0).min(23);
            let m = caps[2].parse::<u32>().unwrap_or(0).min(59);
            let s = caps
                .get(3)
                .and_then(|c| c.as_str().parse::<u32>().ok())
                .unwrap_or(0)
                .min(59);
            (h, m, s)
        } else {
            (0, 0, 0)
        }
    } else {
        (0, 0, 0)
    };

    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

static REDE_ROW_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>").unwrap());
static REDE_URL_CELL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<td\b[^>]*\bclass="[^"]*\bleft\b[^"]*"[^>]*>(.*?)</td>"#).unwrap()
});
static REDE_HREF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']"#).unwrap());
static REDE_DATE_DIV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div\b[^>]*\bclass="[^"]*\bdate\b[^"]*"[^>]*>(.*?)</div>"#).unwrap()
});
static REDE_TIME_DIV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div\b[^>]*\bclass="[^"]*\btime\b[^"]*"[^>]*>(.*?)</div>"#).unwrap()
});

/// Pares loc/lastmod da tabela do visualizador do RedeTorrent (`redetorrent-discovery.ts:207`).
pub fn parse_redetorrent_viewer_entries(html: &str) -> Vec<SitemapEntry> {
    let mut out = Vec::new();
    for row_cap in REDE_ROW_RE.captures_iter(html) {
        let body = row_cap.get(1).map_or("", |m| m.as_str());
        let cell = REDE_URL_CELL_RE
            .captures(body)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let href = REDE_HREF_RE
            .captures(cell)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let url = adom_core::decode_entities(href).trim().to_string();
        if url.is_empty() {
            continue;
        }

        let date_div = REDE_DATE_DIV_RE
            .captures(body)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let time_div = REDE_TIME_DIV_RE
            .captures(body)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());

        let date_text = cell_text(date_div);
        let time_text = cell_text(time_div);
        let lastmod = parse_rendered_lastmod(&date_text, Some(&time_text));

        out.push(SitemapEntry { loc: url, lastmod });
    }
    out
}

fn cell_text(raw: &str) -> String {
    static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    let stripped = TAG_RE.replace_all(raw, " ");
    let decoded = adom_core::decode_entities(&stripped);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ── Parsers de XML ──────────────────────────────────────────────────────────

static CDATA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$").unwrap());

fn xml_text(raw: &str) -> String {
    let trimmed = raw.trim();
    let text = if let Some(caps) = CDATA_RE.captures(trimmed) {
        caps.get(1).map_or("", |m| m.as_str())
    } else {
        trimmed
    };
    adom_core::decode_entities(text).trim().to_string()
}

fn normalize_lastmod(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0000-00-00" || trimmed.starts_with("0000-") {
        return String::new();
    }
    if trimmed.len() >= 4 {
        if let Ok(year) = trimmed[..4].parse::<u32>() {
            if (1900..=2100).contains(&year) {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

static BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<(?:url|sitemap)\b[^>]*>(.*?)</(?:url|sitemap)>").unwrap());
static LOC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<loc\b[^>]*>(.*?)</loc>").unwrap());
static LASTMOD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<lastmod\b[^>]*>(.*?)</lastmod>").unwrap());

/// Pares loc/lastmod de um sitemap (XML ou viewer Yoast do Vaca como fallback).
pub fn parse_sitemap_entries(xml: &str) -> Vec<SitemapEntry> {
    parse_sitemap_entries_with_options(xml, &SitemapParseOptions::default())
}

/// Parsing configurável de entradas de sitemap.
pub fn parse_sitemap_entries_with_options(
    xml: &str,
    options: &SitemapParseOptions,
) -> Vec<SitemapEntry> {
    let mut out = Vec::new();
    for block in BLOCK_RE.find_iter(xml) {
        let block_str = block.as_str();
        let loc_raw = match LOC_RE.captures(block_str) {
            Some(caps) => caps.get(1).map_or("", |m| m.as_str()),
            None => continue,
        };
        let loc = xml_text(loc_raw);
        if loc.is_empty() {
            continue;
        }

        let lastmod_raw = LASTMOD_RE
            .captures(block_str)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let lastmod = if options.validate_date {
            normalize_lastmod(&xml_text(lastmod_raw))
        } else {
            xml_text(lastmod_raw)
        };

        out.push(SitemapEntry { loc, lastmod });
    }

    if out.is_empty() && options.fallback_to_viewer {
        let viewer_rows = parse_viewer_entries(xml);
        if !viewer_rows.is_empty() {
            return viewer_rows;
        }
        let rede_rows = parse_redetorrent_viewer_entries(xml);
        if !rede_rows.is_empty() {
            return rede_rows;
        }
    }

    out
}

/// Fusão de XML e visualizador para o RedeTorrent (`redetorrent-discovery.ts:236`).
pub fn parse_sitemap_rows(html: &str) -> Vec<SitemapEntry> {
    let mut by_url: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut order: Vec<String> = Vec::new();

    let mut xml_entries = parse_sitemap_entries_with_options(
        html,
        &SitemapParseOptions {
            fallback_to_viewer: false,
            validate_date: true,
        },
    );
    // Canonicaliza XML lastmod para formato UTC `Z` caso venha com `+00:00`
    for e in &mut xml_entries {
        if e.lastmod.ends_with("+00:00") {
            e.lastmod = format!("{}Z", &e.lastmod[..e.lastmod.len() - 6]);
        }
    }

    let viewer_entries = parse_redetorrent_viewer_entries(html);

    for entry in xml_entries.into_iter().chain(viewer_entries) {
        if let Some(existing_lastmod) = by_url.get_mut(&entry.loc) {
            if entry.lastmod > *existing_lastmod {
                *existing_lastmod = entry.lastmod;
            }
        } else {
            order.push(entry.loc.clone());
            by_url.insert(entry.loc, entry.lastmod);
        }
    }

    order
        .into_iter()
        .map(|loc| {
            let lastmod = by_url.remove(&loc).unwrap_or_default();
            SitemapEntry { loc, lastmod }
        })
        .collect()
}

static POST_SITEMAP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)/post-sitemap\d*\.xml$").unwrap());

/// Locs de `post-sitemap*` do índice, ignorando host alheio e deduplicando.
pub fn parse_sitemap_index_locs(
    xml: &str,
    base: &str,
    is_detail_host: impl Fn(&str) -> bool,
) -> Vec<String> {
    parse_sitemap_index_locs_matching(xml, base, is_detail_host, |path| {
        POST_SITEMAP_RE.is_match(path)
    })
}

/// Locs do índice que casem um filtro customizado de caminho.
pub fn parse_sitemap_index_locs_matching(
    xml: &str,
    base: &str,
    is_detail_host: impl Fn(&str) -> bool,
    path_filter: impl Fn(&str) -> bool,
) -> Vec<String> {
    let entries = parse_sitemap_entries(xml);
    let base_url = Url::parse(base).ok();
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for entry in entries {
        let resolved = if let Some(ref b) = base_url {
            b.join(&entry.loc).ok()
        } else {
            Url::parse(&entry.loc).ok()
        };
        if let Some(href) = resolved {
            if path_filter(href.path()) {
                if let Some(host) = href.host_str() {
                    if is_detail_host(host) {
                        let full = href.to_string();
                        if seen.insert(full.clone()) {
                            out.push(full);
                        }
                    }
                }
            }
        }
    }
    out
}

// ── Validação de Caminho de Obra e URLs ─────────────────────────────────────

const DEFAULT_NOT_WORK_SEGMENTS: &[&str] = &[
    "link.php",
    "feed",
    "wp-json",
    "wp-admin",
    "robots.txt",
    "sitemap.xml",
    "sitemap_index.xml",
    "wp-sitemap.xml",
];

/// O caminho É de página de obra (um segmento com barra final, sem taxonomias conhecidas).
pub fn is_work_path(href: &str, custom_not_work: Option<&[&str]>) -> bool {
    let path = if let Ok(u) = Url::parse(href) {
        u.path().to_string()
    } else {
        href.to_string()
    };

    if !path.starts_with('/') || !path.ends_with('/') || path.len() < 3 {
        return false;
    }
    let inner = &path[1..path.len() - 1];
    if inner.is_empty() || inner.contains('/') {
        return false;
    }

    let segment = decode_uri_component(inner).to_lowercase();
    let not_work = custom_not_work.unwrap_or(DEFAULT_NOT_WORK_SEGMENTS);
    !not_work.iter().any(|&s| s.eq_ignore_ascii_case(&segment))
}

/// Loc de post → URL de obra, ou `None` se não for página do site ou não for obra.
pub fn to_work_url(loc: &str, base: &str, is_detail_host: impl Fn(&str) -> bool) -> Option<Url> {
    to_work_url_with_options(loc, base, is_detail_host, None)
}

/// Loc de post → URL de obra com segmentos customizados excluídos.
pub fn to_work_url_with_options(
    loc: &str,
    base: &str,
    is_detail_host: impl Fn(&str) -> bool,
    not_work_segments: Option<&[&str]>,
) -> Option<Url> {
    let base_url = Url::parse(base).ok()?;
    let href = base_url.join(loc).ok()?;
    let host = href.host_str()?;
    if !is_detail_host(host) {
        return None;
    }
    if is_work_path(href.path(), not_work_segments) {
        Some(href)
    } else {
        None
    }
}

/// Determina o tipo da página pelo slug (filme vs série).
pub fn kind_from_slug(href: &str) -> CrawlPageKind {
    kind_from_slug_with_patterns(href, &["temporada"])
}

/// Determina o tipo da página usando padrões de temporada configuráveis.
pub fn kind_from_slug_with_patterns(href: &str, season_patterns: &[&str]) -> CrawlPageKind {
    let path = if let Ok(u) = Url::parse(href) {
        u.path().to_string()
    } else {
        href.to_string()
    };
    let slug = decode_uri_component(&path);
    for pat in season_patterns {
        if let Ok(re) = Regex::new(&format!("(?i){pat}")) {
            if re.is_match(&slug) {
                return CrawlPageKind::TvShow;
            }
        } else if slug.to_lowercase().contains(&pat.to_lowercase()) {
            return CrawlPageKind::TvShow;
        }
    }
    CrawlPageKind::Movie
}

/// `true` quando o slug é de página de temporada.
pub fn is_season_slug(href: &str) -> bool {
    kind_from_slug(href) == CrawlPageKind::TvShow
}

// ── IMDb Parsing ────────────────────────────────────────────────────────────

static IMDB_WIDGET_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)/(?:ref_[^/?]*|list|listicle)(?:[/?]|$)").unwrap());
static IMDB_PLG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^tt_plg(?:_|$)").unwrap());
static IMDB_WIDGET_QUERY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)[?&]ref_=tt_").unwrap());
static IMDB_TITLE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)imdb\.com/title/(tt\d{5,})([^"'\s<>]*)"#).unwrap());

/// O sufixo depois de `title/tt…` é de widget de recomendação? (`shared.ts:132`).
pub fn is_imdb_widget_reference(suffix: &str) -> bool {
    if IMDB_WIDGET_PATH_RE.is_match(suffix) || IMDB_WIDGET_QUERY_RE.is_match(suffix) {
        return true;
    }
    let dummy = format!(
        "https://www.imdb.com/title/tt0000000{}",
        suffix.replace("&amp;", "&")
    );
    if let Ok(url) = Url::parse(&dummy) {
        for (key, val) in url.query_pairs() {
            if key.eq_ignore_ascii_case("ref_") && IMDB_PLG_RE.is_match(&val) {
                return true;
            }
        }
    }
    false
}

/// IMDb da obra pelo tt único na página inteira, filtrando widgets de recomendação
/// e comentários HTML (`nerdfilmes`, `comandotorrents`, `redetorrent`, `hdrtorrents`).
pub fn parse_imdb_id(html: &str) -> Option<String> {
    let clean = strip_html_comments(html);
    let mut found = HashSet::new();
    for caps in IMDB_TITLE_RE.captures_iter(&clean) {
        let id = caps.get(1).map_or("", |m| m.as_str());
        let suffix = caps.get(2).map_or("", |m| m.as_str());
        if !is_imdb_widget_reference(suffix) {
            found.insert(id.to_string());
        }
    }
    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}

/// IMDb da obra pelo âncora da ficha técnica do Vaca (`vaca.ts:114`).
pub fn parse_vaca_imdb_id(html: &str) -> Option<String> {
    static IMDB_ANCHOR_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?is)Avalia[^<]{0,16}IMDb.{0,120}?imdb\.com/title/(tt\d{5,})").unwrap()
    });
    let mut found = HashSet::new();
    for cap in IMDB_ANCHOR_RE.captures_iter(html) {
        if let Some(m) = cap.get(1) {
            found.insert(m.as_str().to_string());
        }
    }
    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}

/// IMDb da obra com rótulo "IMDb" dentro da janela de 200 caracteres (`bludv-discovery.ts:272`).
pub fn parse_bludv_imdb_id(html: &str) -> Option<String> {
    static IMDB_ID_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)imdb\.com/title/(tt\d{5,})").unwrap());
    static IMDB_LABEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)IMDb").unwrap());
    const IMDB_LABEL_WINDOW: usize = 200;

    let mut found = HashSet::new();
    for m in IMDB_ID_RE.find_iter(html) {
        let match_start = m.start();
        let before = &html[..match_start];
        if let Some(last_label) = IMDB_LABEL_RE.find_iter(before).last() {
            if match_start - last_label.start() <= IMDB_LABEL_WINDOW {
                if let Some(cap) = IMDB_ID_RE.captures(m.as_str()) {
                    if let Some(id) = cap.get(1) {
                        found.insert(id.as_str().to_string());
                    }
                }
            }
        }
    }
    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}

// ── Auxiliares ──────────────────────────────────────────────────────────────

fn decode_uri_component(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                decoded.push(byte);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(decoded)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

// ── Testes Unitários ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fixture_path(subpath: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures")
            .join(subpath)
    }

    fn read_fixture(subpath: &str) -> String {
        let path = fixture_path(subpath);
        fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("falha ao ler fixture {}: {:?}", path.display(), err))
    }

    #[test]
    fn test_is_xml_sitemap_shape() {
        assert!(is_xml_sitemap_shape(
            "<URLSET><url><loc><![CDATA[https://site.test/]]></loc></url></URLSET>"
        ));
        assert!(is_xml_sitemap_shape(
            "<sitemapindex><sitemap><loc>https://site.test/post.xml</loc></sitemap></sitemapindex>"
        ));
        assert!(is_xml_sitemap_shape(
            "<url><loc>https://site.test/</loc></url>"
        ));
        assert!(is_xml_sitemap_shape("<loc>https://site.test/</loc>"));

        // Comentários são ignorados
        assert!(!is_xml_sitemap_shape(
            "<html><!-- <urlset><url/></urlset> --></html>"
        ));
        // <image:loc> não é sitemap XML
        assert!(!is_xml_sitemap_shape(
            "<image:loc>https://site.test/image.jpg</image:loc>"
        ));
        // Lookahead exige [\s/>]: <location> não casa
        assert!(!is_xml_sitemap_shape(
            "<location>https://site.test/</location>"
        ));
        // HTML genérico não é XML
        assert!(!is_xml_sitemap_shape(
            "<html><body>Just a moment... <table><tr><td>challenge</td></tr></table></body></html>"
        ));
    }

    #[test]
    fn test_is_vaca_sitemap_shape() {
        let empty_viewer = r#"<table id="sitemap"><thead><tr><th>URL</th><th>Images</th><th>Last Modified</th></tr></thead><tbody></tbody></table>"#;
        assert!(is_vaca_sitemap_shape(empty_viewer));

        let xml = "<urlset><url><loc>https://site.test/</loc></url></urlset>";
        assert!(is_vaca_sitemap_shape(xml));

        // HTML genérico não casa
        assert!(!is_vaca_sitemap_shape(
            "<html><table><tr><td>challenge</td></tr></table></html>"
        ));
    }

    #[test]
    fn test_assert_sitemap_scope() {
        assert_eq!(
            assert_sitemap_scope(0, 0, false),
            Err(SitemapScopeError::FormatoDesconhecido)
        );
        assert_eq!(
            assert_sitemap_scope(0, 0, true),
            Err(SitemapScopeError::SemEntradasReconhecidas)
        );
        assert_eq!(
            assert_sitemap_scope(1, 0, true),
            Err(SitemapScopeError::SemObrasDoEscopo)
        );
        assert_eq!(assert_sitemap_scope(1, 1, true), Ok(()));

        assert_eq!(
            sitemap_failure_message("https://site/sitemap.xml", "sitemap_formato_desconhecido"),
            "sitemap_formato_desconhecido"
        );
        assert_eq!(
            sitemap_failure_message(
                "https://site/sitemap.xml",
                "sitemap_sem_entradas_reconhecidas"
            ),
            "https://site/sitemap.xml: sitemap_sem_entradas_reconhecidas"
        );
    }

    #[test]
    fn test_parse_viewer_entries() {
        let sample = r#"<tr>
          <td><a href="https://vaqueirofilmes.com/pt/movie/maquina-de-guerra/">obra</a></td>
          <td>1</td>
          <td>2026-03-15 01:36 +00:00</td>
        </tr>
        <tr>
          <td><a href="https://vaqueirofilmes.com/pt/movie/outro/?a=1&amp;b=2">outro</a></td>
          <td>2026-04-10 10:20Z</td>
        </tr>"#;

        let entries = parse_viewer_entries(sample);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries[0].loc,
            "https://vaqueirofilmes.com/pt/movie/maquina-de-guerra/"
        );
        assert_eq!(entries[0].lastmod, "2026-03-15T01:36:00+00:00");

        assert_eq!(
            entries[1].loc,
            "https://vaqueirofilmes.com/pt/movie/outro/?a=1&b=2"
        );
        assert_eq!(entries[1].lastmod, "2026-04-10T10:20:00+00:00");
    }

    #[test]
    fn test_parse_rendered_lastmod() {
        assert_eq!(
            parse_rendered_lastmod("6 de February de 2026", Some("14:22")),
            "2026-02-06T14:22:00Z"
        );
        assert_eq!(
            parse_rendered_lastmod("2026-02-06", Some("14:22:15")),
            "2026-02-06T14:22:15Z"
        );
        assert_eq!(parse_rendered_lastmod("0000-00-00", Some("00:00")), "");
        assert_eq!(parse_rendered_lastmod("", None), "");
    }

    #[test]
    fn test_parse_sitemap_entries_xml() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc><![CDATA[https://site.test/filme-a/?x=1&amp;y=2]]></loc>
            <lastmod><![CDATA[2026-01-02T03:04:05+00:00]]></lastmod>
          </url>
          <url>
            <loc>https://site.test/sem-data/</loc>
            <lastmod>0000-00-00</lastmod>
          </url>
        </urlset>"#;

        let entries = parse_sitemap_entries(xml);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].loc, "https://site.test/filme-a/?x=1&y=2");
        assert_eq!(entries[0].lastmod, "2026-01-02T03:04:05+00:00");

        assert_eq!(entries[1].loc, "https://site.test/sem-data/");
        assert_eq!(entries[1].lastmod, ""); // 0000-00-00 vira vazio
    }

    #[test]
    fn test_parse_sitemap_index_locs() {
        let index = r#"<sitemapindex>
          <sitemap><loc>https://bludv.xyz/post-sitemap.xml</loc></sitemap>
          <sitemap><loc>https://bludv.xyz/post-sitemap2.xml</loc></sitemap>
          <sitemap><loc>https://evil.example/post-sitemap3.xml</loc></sitemap>
          <sitemap><loc>https://bludv.xyz/category-sitemap.xml</loc></sitemap>
        </sitemapindex>"#;

        let locs = parse_sitemap_index_locs(index, "https://bludv.xyz", |h| h == "bludv.xyz");
        assert_eq!(
            locs,
            vec![
                "https://bludv.xyz/post-sitemap.xml".to_string(),
                "https://bludv.xyz/post-sitemap2.xml".to_string(),
            ]
        );
    }

    #[test]
    fn test_is_work_path_and_to_work_url() {
        assert!(is_work_path("/furiosa-uma-saga-mad-max/", None));
        assert!(is_work_path("/bancarios-2020/", None));
        assert!(!is_work_path("/", None));
        assert!(!is_work_path("/feed/", None));
        assert!(!is_work_path("/link.php/", None));
        assert!(!is_work_path("/genero/acao/", None));

        let is_host = |h: &str| h == "comandotorrents.to";
        assert_eq!(
            to_work_url(
                "https://comandotorrents.to/furiosa/",
                "https://comandotorrents.to",
                is_host
            ),
            Some(Url::parse("https://comandotorrents.to/furiosa/").unwrap())
        );
        assert_eq!(
            to_work_url(
                "https://evil.example/furiosa/",
                "https://comandotorrents.to",
                is_host
            ),
            None
        );
        assert_eq!(
            to_work_url(
                "https://comandotorrents.to/feed/",
                "https://comandotorrents.to",
                is_host
            ),
            None
        );
    }

    #[test]
    fn test_kind_from_slug() {
        assert_eq!(
            kind_from_slug("https://site.test/smallville-10a-temporada/"),
            CrawlPageKind::TvShow
        );
        assert_eq!(
            kind_from_slug("https://site.test/filme-normal-2024/"),
            CrawlPageKind::Movie
        );
        assert!(is_season_slug("/lanternas-1a-temporada-2026/"));
        assert!(!is_season_slug("/filme-antigo/"));

        let bludv_patterns = &["temporada", "minis+erie", "serie-completa"];
        assert_eq!(
            kind_from_slug_with_patterns("/redencao-minisserie-completa/", bludv_patterns),
            CrawlPageKind::TvShow
        );
        assert_eq!(
            kind_from_slug_with_patterns("/mr-bean-serie-completa/", bludv_patterns),
            CrawlPageKind::TvShow
        );
        assert_eq!(
            kind_from_slug_with_patterns("/uma-noite-fora-de-serie/", bludv_patterns),
            CrawlPageKind::Movie
        );
    }

    #[test]
    fn test_is_imdb_widget_reference() {
        assert!(is_imdb_widget_reference("?ref_=tt_plg_rt"));
        assert!(is_imdb_widget_reference("/ref_=tt_123"));
        assert!(is_imdb_widget_reference("/list/ls1234/"));
        assert!(!is_imdb_widget_reference(""));
        assert!(!is_imdb_widget_reference("/"));
    }

    #[test]
    fn test_parse_imdb_id() {
        let html_single = r#"<div>
          <a href="https://www.imdb.com/title/tt1234567/">IMDb</a>
        </div>"#;
        assert_eq!(parse_imdb_id(html_single), Some("tt1234567".to_string()));

        // Em comentário não conta
        let html_comment = r#"<div>
          <!-- <a href="https://www.imdb.com/title/tt9999999/">IMDb</a> -->
        </div>"#;
        assert_eq!(parse_imdb_id(html_comment), None);

        // Com widget de recomendação não conta
        let html_widget = r#"<div>
          <a href="https://www.imdb.com/title/tt1234567/?ref_=tt_plg_rt">IMDb</a>
        </div>"#;
        assert_eq!(parse_imdb_id(html_widget), None);

        // Múltiplos distintos é ambíguo
        let html_multi = r#"<div>
          <a href="https://www.imdb.com/title/tt1111111/">IMDb</a>
          <a href="https://www.imdb.com/title/tt2222222/">IMDb</a>
        </div>"#;
        assert_eq!(parse_imdb_id(html_multi), None);
    }

    #[test]
    fn test_parse_vaca_imdb_id() {
        let html = r#"<li><b>Avaliação da IMDb:</b> <a href="https://www.imdb.com/title/tt1706620/" target="_blank">7.1</a></li>"#;
        assert_eq!(parse_vaca_imdb_id(html), Some("tt1706620".to_string()));

        let no_anchor = r#"<li><b>Classificação:</b> 16</li>"#;
        assert_eq!(parse_vaca_imdb_id(no_anchor), None);
    }

    #[test]
    fn test_parse_bludv_imdb_id() {
        let html =
            r#"<strong>IMDb:</strong> <a href="https://www.imdb.com/title/tt3416744/">7.4</a>"#;
        assert_eq!(parse_bludv_imdb_id(html), Some("tt3416744".to_string()));
    }

    // ── Testes com Fixtures Reais ───────────────────────────────────────────

    #[test]
    fn test_fixture_bludv_post_sitemap() {
        let xml = read_fixture("crawl/bludv/post-sitemap.xml");
        let entries = parse_sitemap_entries(&xml);
        assert_eq!(entries.len(), 1001);
        assert_eq!(entries[0].loc, "https://bludvfilmes1.xyz/");
        // Nenhuma entrada contém upload de imagem
        assert!(!entries
            .iter()
            .any(|e| e.loc.contains("/wp-content/uploads/")));

        let config = SitemapSiteConfig::bludv();
        let is_host = |h: &str| h == "bludvfilmes1.xyz";
        // A primeira linha é a home '/' e é recusada como obra
        assert_eq!(
            config.to_work_url(&entries[0].loc, "https://bludvfilmes1.xyz", is_host),
            None
        );

        // Obra real é aceita
        let work_entry = entries
            .iter()
            .find(|e| e.loc.contains("espirito-de-lobo"))
            .expect("espirito-de-lobo deve estar presente");
        assert!(config
            .to_work_url(&work_entry.loc, "https://bludvfilmes1.xyz", is_host)
            .is_some());
    }

    #[test]
    fn test_fixture_bludv_sitemap_index() {
        let xml = read_fixture("crawl/bludv/sitemap-index.xml");
        let config = SitemapSiteConfig::bludv();
        let is_host = |h: &str| h == "bludvfilmes1.xyz";
        let locs = config.parse_sitemap_index_locs(&xml, "https://bludvfilmes1.xyz", is_host);
        assert_eq!(locs.len(), 18);
        assert_eq!(locs[0], "https://bludvfilmes1.xyz/post-sitemap.xml");
        assert_eq!(locs[17], "https://bludvfilmes1.xyz/post-sitemap18.xml");
    }

    #[test]
    fn test_fixture_vaca_movie_sitemap11() {
        let xml = read_fixture("crawl/vaca/movie-sitemap11.xml");
        let entries = parse_sitemap_entries(&xml);
        assert_eq!(entries.len(), 118);
        assert!(entries.iter().all(|e| !e.lastmod.is_empty()));
    }

    #[test]
    fn test_fixture_vaca_pages_imdb() {
        let torrent_page = read_fixture("crawl/vaca/movie-page-torrent.html");
        assert_eq!(
            parse_vaca_imdb_id(&torrent_page),
            Some("tt1706620".to_string())
        );

        let no_imdb_page = read_fixture("crawl/vaca/movie-page-no-imdb.html");
        assert_eq!(parse_vaca_imdb_id(&no_imdb_page), None);
    }

    #[test]
    fn test_fixture_bludv_post_movie_imdb() {
        let post_movie = read_fixture("crawl/bludv/post-movie.html");
        assert_eq!(
            parse_bludv_imdb_id(&post_movie),
            Some("tt3416744".to_string())
        );
    }

    #[test]
    fn test_fixture_comandotorrents_sitemaps() {
        let xml = read_fixture("crawl/comandotorrents/post-sitemap.xml");
        let entries = parse_sitemap_entries(&xml);
        assert_eq!(entries.len(), 6);

        let config = SitemapSiteConfig::comandotorrents();
        let is_host = |h: &str| h == "comandotorrents.to";

        let work_urls: Vec<_> = entries
            .iter()
            .filter_map(|e| config.to_work_url(&e.loc, "https://comandotorrents.to", is_host))
            .collect();
        // Das 6 entradas: home '/', evil host e feed saem -> sobram 3 obras
        assert_eq!(work_urls.len(), 3);
    }

    #[test]
    fn test_fixture_nerdfilmes_post_sitemap() {
        let xml = read_fixture("crawl/nerdfilmes/post-sitemap.xml");
        let entries = parse_sitemap_entries(&xml);
        assert_eq!(entries.len(), 40);
        assert_eq!(
            entries[0].loc,
            "https://www.filmesviatorrenthd.net/lanternas-1a-temporada-2026/"
        );
        assert_eq!(entries[0].lastmod, "2026-09-28T01:15:24+00:00");
    }

    #[test]
    fn test_fixture_redetorrent_dual_format() {
        let xml = read_fixture("redetorrent/movies-sitemap-cdata.xml");
        let html = read_fixture("redetorrent/movies-sitemap.html");

        let from_xml = parse_sitemap_rows(&xml);
        let from_html = parse_sitemap_rows(&html);

        assert_eq!(from_xml.len(), 11);
        assert_eq!(from_html.len(), 11);
        assert_eq!(
            from_xml[0].loc,
            "https://www.redetorrent.xyz/filmes/coringa-delirio-a-dois/"
        );
        assert_eq!(from_xml[0].lastmod, "2026-02-06T14:22:00Z");
        assert_eq!(
            from_html[0].loc,
            "https://www.redetorrent.xyz/filmes/coringa-delirio-a-dois/"
        );
        assert_eq!(from_html[0].lastmod, "2026-02-06T14:22:00Z");

        // Ambas as leituras devem ser equivalentes
        assert_eq!(from_xml, from_html);
    }
}
