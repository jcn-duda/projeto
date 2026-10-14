//! Núcleo compartilhado do ApacheTorrent
//! (`resolvers/profiles/apachetorrent-parsers.ts`).
//!
//! Implementação fiel do `parsePostMagnets`: blocos `div.download-block` com
//! âncoras de magnet direto, áudio próprio (DUAL vence DUBLADO, com o padrão
//! `DUPLO[-\s]*AUDIO` do TS), magnet SEM normalização e `dn` do PRIMEIRO match
//! (paridade com `searchParams.get('dn')` do JS).
//!
//! Autoridade TS: `resolvers/profiles/apachetorrent-parsers.ts`.
//! Consumido pelo resolver (`sites/apachetorrent_parse.rs`) E pelo raspador
//! (`profile_parsers/parsers_apache.rs`).

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use super::rules::{normalize_quality, normalize_source};
use super::text::{decode_entities, strip_tags};
use crate::profile_parsers::ResolverLink;

const B: &str = r"(?-u:\b)";

fn rx(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{B}", B)).expect("regex do apache core")
}

// ─── regex (paridade com o JS: `\b` ASCII via `(?-u:\b)`, `\d` = `[0-9]`) ──

/// Split por `div.download-block` (TS linha 159).
static BLOCK_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)<div[^>]*class=["'][^"']*download-block[^"']*["'][^>]*>"#));

/// `p.download-versao` — cabeçalho do bloco ("VERSÃO DUBLADA"/"VERSÃO LEGENDADA").
static VERSAO: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)class=["']download-versao["'][^>]*>([\s\S]*?)</p>"#));

/// `p.download-desc` — descrição do bloco (contexto de áudio/qualidade).
static DESC: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)class=["']download-desc["'][^>]*>([\s\S]*?)</p>"#));

/// Âncoras do bloco (para remover do desc antes do stripTags — TS linha 165).
static ANCHOR_BLOCK: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)<a{B}[\s\S]*?</a>"));

/// `href` de cada âncora do bloco (TS linha 170).
static HREF_ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)<a{B}[^>]*{B}href=["']([^"']+)["']"#));

// ─── áudio, qualidade e magnet ───────────────────────────────────────────

static LEG: LazyLock<Regex> = LazyLock::new(|| rx(r"LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)"));
static DUAL: LazyLock<Regex> =
    LazyLock::new(|| rx(r"DUAL[-\s]*[AÁ]UDIO|AUDIO[-\s]*DUPLO|DUPLO[-\s]*AUDIO"));
static DUB: LazyLock<Regex> = LazyLock::new(|| rx(r"DUBLAD|{B}DUB{B}|NACIONAL|PORTUGU[ÊE]S"));
static QUALITY_TEXT: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i){B}[0-9]{3,4}\s*p{B}"));
static MAGNET_PREFIX: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^magnet:"));
static XT_PARAM: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)"));
static HASH_HEX40: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^[0-9a-f]{40}$"));
static HASH_B32: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^[a-z2-7]{32}$"));
static HAS_SCHEME: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^[a-z][a-z0-9+.-]*:"));

/// `dn=` do magnet via regex do PRIMEIRO match (TS linha 130 / 178).
static DN: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)[?&]dn=([^&]+)"));

// ─── helpers ──────────────────────────────────────────────────────────────

/// `classifyAudio` do Apache (TS linha 135): "LEGENDADO" vence; "DUAL ÁUDIO"
/// vence "DUBLADA"; sem marcador, None.
fn classify_audio(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    if LEG.is_match(&text) {
        return Some("legendado");
    }
    if DUAL.is_match(&text) {
        return Some("dual");
    }
    if DUB.is_match(&text) {
        return Some("dublado");
    }
    None
}

/// `qualityFromText` (TS linha 127): primeiro `NNNp` do texto → `normalizeQuality`.
fn quality_from_text(text: &str) -> Option<u32> {
    QUALITY_TEXT
        .find(text)
        .and_then(|m| normalize_quality(m.as_str()))
}

fn is_valid_btih_hash(hash: &str) -> bool {
    HASH_HEX40.is_match(hash) || HASH_B32.is_match(hash)
}

/// `isValidMagnetUri` do `bludv-parsers.ts` (TS linha 76): começa com `magnet:`
/// e tem `xt=urn:btih:` de hash válido (40 hex ou 32 base32) em qualquer
/// posição da query.
fn is_valid_magnet(value: &str) -> bool {
    if !MAGNET_PREFIX.is_match(value) {
        return false;
    }
    let query = value.find('?').map_or("", |q| &value[q + 1..]);
    let mut found = false;
    for param in query.split('&') {
        let Some(caps) = XT_PARAM.captures(param) else {
            continue;
        };
        if !is_valid_btih_hash(&caps[1]) {
            return false;
        }
        found = true;
    }
    found
}

/// `decodeURIComponent` estrito: `%` sem dois hex ou UTF-8 inválido → None.
fn decode_uri_component(value: &str) -> Option<String> {
    crate::shared::decode_uri_component(value)
}

/// `magnetParams(magnet).dn` (TS linha 119): PRIMEIRO `dn=` via regex,
/// decodificado com `decodeURIComponent`. Falha vira string vazia.
fn magnet_dn(magnet: &str) -> String {
    DN.captures(magnet)
        .and_then(|c| decode_uri_component(&c[1]))
        .unwrap_or_default()
}

/// Resolve `href` contra `base` como `new URL(href, base)` do JS.
fn resolve_url(href: &str, base: &str) -> Option<String> {
    if base.is_empty() {
        return Url::parse(href).ok().map(String::from);
    }
    Url::parse(base).ok()?.join(href).ok().map(String::from)
}

// ─── parser público ───────────────────────────────────────────────────────

/// `parsePostMagnets(html, postUrl)` do TS (linha 152).
///
/// Cada `div.download-block` tem um grupo de âncoras magnet com o contexto de
/// áudio/qualidade em `p.download-desc` (e `p.download-versao`). Só magnet
/// válido entra; o href vira o próprio magnet (relativo resolve contra a URL
/// do post, sem normalizar o magnet).
pub fn parse_post_magnets(html: &str, post_url: &str) -> Vec<ResolverLink> {
    let mut out = Vec::new();
    if html.is_empty() {
        return out;
    }
    for block in BLOCK_SPLIT.split(html).skip(1) {
        let version = VERSAO
            .captures(block)
            .map(|c| strip_tags(&c[1]))
            .unwrap_or_default();
        let desc_raw = DESC
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
        let desc = strip_tags(&ANCHOR_BLOCK.replace_all(&desc_raw, " "));
        let context = format!("{version} {desc}");
        let audio = classify_audio(&context);
        let quality = normalize_quality(&context);
        let source = normalize_source(&context);
        let description = [version.as_str(), desc.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" — ");
        let description = (!description.is_empty()).then_some(description);

        for caps in HREF_ANCHOR.captures_iter(block) {
            let mut href = decode_entities(&caps[1]);
            if !post_url.is_empty() && !HAS_SCHEME.is_match(&href) {
                if let Some(joined) = resolve_url(&href, post_url) {
                    href = joined;
                }
            }
            if !is_valid_magnet(&href) {
                continue;
            }
            let dn = magnet_dn(&href);
            out.push(ResolverLink {
                url: href,
                quality: quality.or_else(|| quality_from_text(&dn)),
                size: None,
                audio: audio.map(String::from),
                source: source.clone().or_else(|| normalize_source(&dn)),
                episode: None,
                episode_last: None,
                season: None,
                real_title: None,
                description: description.clone(),
            });
        }
    }
    out
}
