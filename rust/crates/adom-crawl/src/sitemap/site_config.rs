//! Configuração e regras de sitemap específicas por site.

use regex::Regex;
use url::Url;

use crate::sitemap::imdb_parsers::{parse_bludv_imdb_id, parse_imdb_id, parse_vaca_imdb_id};
use crate::sitemap::types::CrawlPageKind;
use crate::sitemap::xml_parsers::parse_sitemap_index_locs_matching;

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

// Default not-work segments for WordPress sites.
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

// Helper function for URI decoding.
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
