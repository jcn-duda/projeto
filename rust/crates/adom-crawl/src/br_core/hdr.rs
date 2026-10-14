//! Núcleo compartilhado do HDRTorrents (`resolvers/profiles/hdrtorrents-parsers.ts`).
//!
//! Implementação fiel do `parseContentMagnets`: linhas `.download-row` com
//! magnet direto, áudio próprio do HDR (DUAL vence DUBLADO), magnet SEM
//! normalização (só decode de entidades) e `dn` via regex do PRIMEIRO match
//! (paridade com `decodeURIComponent` do TS).
//!
//! Autoridade TS: `resolvers/profiles/hdrtorrents-parsers.ts`.
//! Consumido pelo resolver (`sites/hdrtorrents.rs`) E pelo raspador
//! (`profile_parsers/parsers_hdr.rs`).

use std::sync::LazyLock;

use regex::Regex;

use super::rules::{normalize_quality, normalize_source};
use super::text::{decode_entities, strip_tags};
use crate::profile_parsers::ResolverLink;

// ─── regex (paridade com o JS: `\b` ASCII via `(?-u:\b)`, `\d` = `[0-9]`) ──

/// Split por `.download-row` — mesma regex do TS (linhas 117).
static ROW_SPLIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<div[^>]*class=["'][^"']*download-row[^"']*["'][^>]*>"#).expect("linha")
});

/// Nome da linha: `.download-name` até o `</div>` (TS linha 119).
static ROW_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*download-name[^"']*"[^>]*>([\s\S]*?)</div"#)
        .expect("nome da linha")
});

/// Magnet direto da linha: `<a href="magnet:...">` (TS linha 121).
static ROW_MAGNET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<a(?-u:\b)[^>]*href=["'](magnet:[^"']+)["']"#).expect("magnet da linha")
});

/// `extractSizeFromTechSheet` (TS linha 178): `[\s\S]{0,40}` atravessa as tags
/// `<dt>`/`<dd>` da ficha técnica do site.
static TECH_SIZE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Tamanho[\s\S]{0,40}?([0-9.,]+\s*(?:TB|GB|MB|KB))").expect("tamanho")
});

// classifyAudio: roda sobre o texto em caixa-alta, como no TS.
// Ordem: LEGENDADO > DUAL > DUBLADO (TS linhas 157-163).
static AUDIO_LEG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)").expect("legendado"));
static AUDIO_DUAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"DUAL[-\s]*[AÁ]UDIO|AUDIO[-\s]*DUPLO").expect("dual"));
static AUDIO_DUB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"DUBLAD|(?-u:\b)DUB(?-u:\b)|NACIONAL|PORTUGU[ÊE]S").expect("dublado")
});

// extractEpisodeFromName (TS linha 166): E01 solto, senão EPISÓDIO 12.
static EP_SHORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[Ee]([0-9]{1,3})(?-u:\b)").expect("ep"));
static EP_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)EPIS[ÓO]DIO\s*([0-9]+)").expect("episódio"));

// isValidMagnetUri (TS bludv-parsers.ts linha 76-89): xt=urn:btih: com hash
// válido (40 hex ou 32 base32) em qualquer posição da query.
static XT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)").expect("xt"));

// dn do magnet via regex (TS linha 130): /[?&]dn=([^&]+)/i — PRIMEIRO match.
static DN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[?&]dn=([^&]+)").expect("dn"));

// ─── helpers ──────────────────────────────────────────────────────────────

/// `isValidBtihHash` do `bludv-parsers.ts`: 40 hex ou 32 base32.
fn is_valid_btih(hash: &str) -> bool {
    let h = hash.trim();
    (h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        || (h.len() == 32
            && h.bytes()
                .all(|b| b.is_ascii_alphabetic() || (b'2'..=b'7').contains(&b)))
}

/// `isValidMagnetUri` do `bludv-parsers.ts`: `xt=urn:btih:` válido em qualquer
/// posição da query; `xt` e `urn:btih:` sem diferença de caixa.
fn is_valid_magnet(value: &str) -> bool {
    if !value
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("magnet:"))
    {
        return false;
    }
    let Some(q) = value.find('?') else {
        return false;
    };
    let mut found = false;
    for param in value[q + 1..].split('&') {
        let Some(caps) = XT.captures(param) else {
            continue;
        };
        if !is_valid_btih(&caps[1]) {
            return false;
        }
        found = true;
    }
    found
}

/// `classifyAudio` do HDR (TS linha 157): DUAL vence DUBLADO ("DUBLADO DUAL
/// AUDIO").
fn classify_audio(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    if AUDIO_LEG.is_match(&text) {
        Some("legendado")
    } else if AUDIO_DUAL.is_match(&text) {
        Some("dual")
    } else if AUDIO_DUB.is_match(&text) {
        Some("dublado")
    } else {
        None
    }
}

/// `extractEpisodeFromName` (TS linha 165): `E01` solto, senão `EPISÓDIO 12`.
fn extract_episode(name: &str) -> Option<u32> {
    EP_SHORT
        .captures(name)
        .or_else(|| EP_WORD.captures(name))
        .and_then(|c| c[1].parse::<u32>().ok())
}

/// `dn=` do magnet, decodificado via regex do PRIMEIRO match (TS linha 130).
/// Ausente ou decode com falha vira string vazia.
fn magnet_dn(magnet: &str) -> String {
    DN.captures(magnet)
        .and_then(|c| crate::shared::decode_uri_component(&c[1]))
        .unwrap_or_default()
}

/// `extractSizeFromTechSheet` (TS linha 177): a ficha publica uma vez por obra,
/// em `<dd>`. A primeira vírgula do número vira ponto (padrão BR).
fn tech_sheet_size(html: &str) -> Option<String> {
    TECH_SIZE.captures(html).map(|c| c[1].replacen(',', ".", 1))
}

// ─── parser público ───────────────────────────────────────────────────────

/// `parseContentMagnets(html, baseUrl)` do TS (linha 114).
///
/// Uma linha `.download-row` por magnet direto. O magnet NÃO é normalizado
/// (só decode de entidades), o áudio é o `classifyAudio` próprio do HDR
/// (DUAL vence DUBLADO), e o `dn` sai da regex do PRIMEIRO match.
pub fn parse_content_magnets(html: &str) -> Vec<ResolverLink> {
    if html.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for row in ROW_SPLIT.split(html).skip(1) {
        let name = match ROW_NAME.captures(row) {
            Some(c) => strip_tags(&c[1]),
            None => String::new(),
        };
        let Some(caps) = ROW_MAGNET.captures(row) else {
            continue;
        };
        let magnet = decode_entities(&caps[1]);
        if !is_valid_magnet(&magnet) {
            continue;
        }
        let dn = magnet_dn(&magnet);
        out.push(ResolverLink {
            url: magnet,
            quality: normalize_quality(&name).or_else(|| normalize_quality(&dn)),
            size: None,
            audio: classify_audio(&name).map(String::from),
            source: normalize_source(&name).or_else(|| normalize_source(&dn)),
            episode: extract_episode(&name),
            episode_last: None,
            season: None,
            real_title: None,
            description: if name.is_empty() { None } else { Some(name) },
        });
    }
    // Preenche o tamanho da ficha técnica em todos os links (é o mesmo para
    // todos os episódios do post — o site publica um tamanho por obra).
    if let Some(size) = tech_sheet_size(html) {
        for link in &mut out {
            if link.size.is_none() {
                link.size = Some(size.clone());
            }
        }
    }
    out
}
