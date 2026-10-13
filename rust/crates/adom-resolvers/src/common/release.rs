//! `cleanPostTitle` e `createReleaseTitle` de `resolvers/release-format.ts`.
//!
//! Paridade com o JS: `\b` é a fronteira ASCII (`(?-u:\b)`), porque o JS sem a
//! flag `u` trata letra acentuada como não-letra — `\b[AÁ]udio` NÃO casa antes
//! de "Á". `\d` vira `[0-9]`.

use std::sync::LazyLock;

use adom_core::decode_entities;
use adom_crawl::profile_parsers::ResolverLink;
use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use super::page::SitePost;

/// Fronteira de palavra do JS sem flag `u`.
const B: &str = r"(?-u:\b)";
/// A mesma fronteira para o fancy-regex, que não aceita `(?-u:...)`.
pub const FB: &str = r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";

fn re(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{B}", B)).expect("regex do cleanPostTitle")
}

static TORRENT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*"));
// `\bHD\b(?!\s*TV)` precisa de lookahead: única regex do arquivo no fancy-regex.
static RESOLUTION: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(
        &r"(?i){B}(?:2160p|1080p|720p|576p|480p|[0-9]{3,4}p|4K|8K|UHD|ULTRA\s*HD|FULL\s*HD|{B}HD{B}(?!\s*TV)|{B}SD{B}){B}"
            .replace("{B}", FB),
    )
    .expect("regex de resolução")
});
static CODEC: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i){B}(?:BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BDRIP|BRRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM|IMAX|3D|REMASTERED|REMASTER|HDR(?:10\+?)?|DOLBY\s*VISION|DV){B}",
    )
});
static CHANNELS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i){B}(?:5\.1|7\.1|2\.0|7\.2|DDP\s*5\.1|ATMOS){B}"));
static AUDIO_TAGS: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i){B}(?:Dublado|Dublada|Legendado|Legendada|Dual\s*[AÁ]udio|Nacional|Multi\s*[AÁ]udio|Tri\s*[AÁ]udio|[AÁ]udio\s*Original){B}",
    )
});
static SEO: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i){B}(?:Download|Baixar|Gr[áa]tis|Online|Completo|Completa|Assistir){B}")
});
static ORPHAN_SEPS: LazyLock<Regex> = LazyLock::new(|| re(r"\s*[/|–\-—:&+]\s*([/|–\-—:&+]\s*)+"));
static LEADING_SEPS: LazyLock<Regex> = LazyLock::new(|| re(r"^[–\-—/|:&+\s]+"));
static TRAILING_SEPS: LazyLock<Regex> = LazyLock::new(|| re(r"[–\-—/|:&+\s]+$"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));

/// Limpeza do título do post em 7 passos (bludv/comandotorrents).
pub fn clean_post_title(title: &str) -> String {
    let mut clean = decode_entities(title);
    clean = TORRENT.replace_all(&clean, " ").into_owned();
    clean = RESOLUTION.replace_all(&clean, " ").into_owned();
    clean = CODEC.replace_all(&clean, " ").into_owned();
    clean = CHANNELS.replace_all(&clean, " ").into_owned();
    clean = AUDIO_TAGS.replace_all(&clean, " ").into_owned();
    clean = SEO.replace_all(&clean, " ").into_owned();
    clean = ORPHAN_SEPS.replace_all(&clean, " ").into_owned();
    clean = LEADING_SEPS.replace_all(&clean, "").into_owned();
    clean = TRAILING_SEPS.replace_all(&clean, "").into_owned();
    SPACES.replace_all(&clean, " ").trim().to_string()
}

/// "E01-E02": o addon lê o intervalo; "E01E02" ele não reconhece.
pub fn episode_tag(first: u32, last: Option<u32>) -> String {
    match last {
        Some(l) if l > first => format!("E{first:02}-E{l:02}"),
        _ => format!("E{first:02}"),
    }
}

type PostHook = fn(&SitePost, &ResolverLink) -> String;

/// Configuração do `createReleaseTitle`. Os ganchos opcionais são do Vaca
/// (`seasonOf`/`yearOf`/`episodeOf`, `audioTagOf` com DUAL).
#[derive(Clone, Copy)]
pub struct ReleaseTitleConfig {
    pub clean_title: fn(&str) -> String,
    pub title_of: Option<PostHook>,
    pub audio_tag_of: Option<fn(&ResolverLink) -> Option<String>>,
    pub with_size: bool,
    pub strip_source: bool,
    pub season_of: Option<PostHook>,
    pub year_of: Option<PostHook>,
    pub episode_of: Option<PostHook>,
}

impl ReleaseTitleConfig {
    /// Defaults do TS: só `cleanTitle` obrigatório.
    pub const fn new(clean_title: fn(&str) -> String) -> Self {
        Self {
            clean_title,
            title_of: None,
            audio_tag_of: None,
            with_size: true,
            strip_source: false,
            season_of: None,
            year_of: None,
            episode_of: None,
        }
    }
}

fn default_audio_tag(link: &ResolverLink) -> Option<String> {
    match link.audio.as_deref() {
        Some("dublado") => Some("DUBLADO".into()),
        Some("legendado") => Some("LEGENDADO".into()),
        _ => None,
    }
}

/// Escape de regex do JS (`/[.*+?^${}()|[\]\\]/g`) seguido de `-` → `[-. ]?`.
fn source_pattern(source: &str) -> String {
    let mut out = String::new();
    for ch in source.chars() {
        match ch {
            '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            '-' => out.push_str("[-. ]?"),
            _ => out.push(ch),
        }
    }
    out
}

/// Título da release: título do post limpo + atributos do botão na tag.
pub fn release_title(
    cfg: &ReleaseTitleConfig,
    post: &SitePost,
    link: &ResolverLink,
    index: Option<usize>,
) -> String {
    let raw_title = match cfg.title_of {
        Some(f) => f(post, link),
        None => post.title.clone(),
    };
    let mut clean = (cfg.clean_title)(&raw_title);
    let ep_part = match cfg.episode_of {
        Some(f) => f(post, link),
        None => link
            .episode
            .map(|e| episode_tag(e, link.episode_last))
            .unwrap_or_default(),
    };
    let audio_tag = match cfg.audio_tag_of {
        Some(f) => f(link),
        None => default_audio_tag(link),
    };
    let mut tags: Vec<String> = Vec::new();
    if let Some(q) = link.quality.filter(|q| *q != 0) {
        tags.push(format!("{q}p"));
    }
    if let Some(s) = link.source.as_ref().filter(|s| !s.is_empty()) {
        tags.push(s.clone());
    }
    if let Some(a) = audio_tag.filter(|a| !a.is_empty()) {
        tags.push(a);
    }
    if cfg.with_size {
        match link.size.as_ref().filter(|s| !s.is_empty()) {
            Some(size) => tags.push(size.clone()),
            None => {
                if let Some(i) = index {
                    tags.push(format!("opção {}", i + 1));
                }
            }
        }
    }

    if cfg.strip_source {
        if let Some(source) = link.source.as_ref().filter(|s| !s.is_empty()) {
            let pattern = format!("(?i){B}{}{B}", source_pattern(source));
            if let Ok(re) = Regex::new(&pattern) {
                clean = re.replace_all(&clean, "").into_owned();
            }
            clean = TRAILING_SEPS.replace_all(&clean, "").into_owned();
            clean = SPACES.replace_all(&clean, " ").trim().to_string();
        }
    }

    let season = cfg.season_of.map(|f| f(post, link)).unwrap_or_default();
    let se_part = format!("{season}{ep_part}");
    let year = cfg.year_of.map(|f| f(post, link)).unwrap_or_default();
    let base = if se_part.is_empty() {
        format!("{clean}{year}")
    } else {
        format!("{clean}{year} {se_part}")
    };
    if tags.is_empty() {
        base
    } else {
        format!("{base} [{}]", tags.join(" "))
    }
}
