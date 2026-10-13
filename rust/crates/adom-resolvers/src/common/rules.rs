//! `resolvers/release-rules.ts`: classificadores de qualidade/fonte, ganchos de
//! áudio, regras e passo de episódio e o resolver de href de protetor. As
//! diferenças vivas entre sites entram como parâmetro, nunca como conserto.
//!
//! Paridade com o JS: `\b` é ASCII (`(?-u:\b)`), `\d` é `[0-9]`, `\w` é
//! `[A-Za-z0-9_]`. Índices de match são bytes (o TS usa UTF-16), mas só são
//! comparados entre si na mesma string, então a ordem é a mesma.

use std::sync::LazyLock;

use crate::common::text::decode_entities;
use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use url::Url;

use super::collector::Resolved;

const B: &str = r"(?-u:\b)";

fn rx(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{B}", B)).expect("regex de release-rules")
}

fn fx(pattern: &str) -> FancyRegex {
    FancyRegex::new(&pattern.replace("{B}", super::release::FB))
        .expect("regex de release-rules (fancy)")
}

// ─── qualidade ───────────────────────────────────────────────────────────

static QUALITY_MATCH: LazyLock<FancyRegex> = LazyLock::new(|| {
    fx(
        r"(?i){B}(2160\s*P|4K|UHD|1080\s*P|FULL\s*HD|720\s*P|{B}HD{B}(?!\s*TV)|576\s*P|480\s*P|{B}SD{B}|[0-9]{3,4}\s*P){B}",
    )
});
static Q2160: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:2160\s*P|4K|UHD){B}"));
static Q1080: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:1080\s*P|FULL\s*HD){B}"));
static Q720: LazyLock<FancyRegex> = LazyLock::new(|| fx(r"{B}(?:720\s*P|{B}HD{B}(?!\s*TV)){B}"));
static Q576: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:576\s*P){B}"));
static Q480: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:480\s*P|{B}SD{B}){B}"));
static QNUM: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}([0-9]{3,4})\s*P{B}"));

/// `extractQualityToken` da factory comum.
pub fn extract_quality_token(raw: &str) -> Option<u32> {
    let token = raw.to_uppercase();
    let token = token.trim();
    if Q2160.is_match(token) {
        return Some(2160);
    }
    if Q1080.is_match(token) {
        return Some(1080);
    }
    if Q720.is_match(token).unwrap_or(false) {
        return Some(720);
    }
    if Q576.is_match(token) {
        return Some(576);
    }
    if Q480.is_match(token) {
        return Some(480);
    }
    QNUM.captures(token).and_then(|c| c[1].parse().ok())
}

/// `normalizeQuality`: vale o ÚLTIMO token do contexto (o mais perto do botão).
pub fn normalize_quality(context: &str) -> Option<u32> {
    let upper = context.to_uppercase();
    let last = QUALITY_MATCH
        .find_iter(&upper)
        .filter_map(Result::ok)
        .last()?;
    extract_quality_token(last.as_str())
}

// ─── fonte ───────────────────────────────────────────────────────────────

/// `DEFAULT_SOURCE_MATCH_RE`.
pub static DEFAULT_SOURCE_MATCH: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r"(?i){B}(BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BD{B}|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM){B}",
    )
});
/// `VACA_SOURCE_MATCH_RE` — o typo BLRAY é comportamento vivo do card (R-4).
pub static VACA_SOURCE_MATCH: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r"(?i){B}(BDREMUX|REMUX|BLU[- ]?RAY|BLRAY|BD{B}|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM){B}",
    )
});
static S_REMUX: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:BDREMUX|REMUX){B}"));
static S_BLURAY: LazyLock<Regex> =
    LazyLock::new(|| rx(r"{B}(?:BLU[- ]?RAY|BLURAY|BD{B}|BDRIP){B}"));
static S_WEBDL: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:WEB[-. ]?DL){B}"));
static S_WEBRIP: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:WEB[-. ]?RIP|WEBRIP){B}"));
static S_HDTV: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}HDTV{B}"));
static S_CAM: LazyLock<Regex> = LazyLock::new(|| rx(r"{B}(?:CAMRIP|CAM){B}"));

/// `extractSourceToken` da factory comum.
pub fn extract_source_token(raw: &str) -> Option<String> {
    let token = raw.to_uppercase();
    let token = token.trim();
    let label = if S_REMUX.is_match(token) {
        "REMUX"
    } else if S_BLURAY.is_match(token) {
        "BLU-RAY"
    } else if S_WEBDL.is_match(token) {
        "WEB-DL"
    } else if S_WEBRIP.is_match(token) {
        "WEBRIP"
    } else if S_HDTV.is_match(token) {
        "HDTV"
    } else if S_CAM.is_match(token) {
        "CAM"
    } else {
        return None;
    };
    Some(label.to_string())
}

/// `normalizeSource` com o padrão de descoberta do site.
pub fn normalize_source_with(context: &str, match_pattern: &Regex) -> Option<String> {
    let upper = context.to_uppercase();
    let last = match_pattern.find_iter(&upper).last()?;
    extract_source_token(last.as_str())
}

/// `normalizeSource` com o padrão default.
pub fn normalize_source(context: &str) -> Option<String> {
    normalize_source_with(context, &DEFAULT_SOURCE_MATCH)
}

// ─── áudio ───────────────────────────────────────────────────────────────

static AUDIO_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r"(?i)(?:VERS[AÃ]O\s+)?(?:MKV\s+|MP4\s+)?(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD[A-Za-z0-9_]*|LEGENDAD[A-Za-z0-9_]*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|{B}DUB{B}|\[\s*LEG\s*\]|\(\s*LEG\s*\)|{B}LEG{B})",
    )
});
static AUDIO_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r"(?i)(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD[A-Za-z0-9_]*|LEGENDAD[A-Za-z0-9_]*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|{B}DUB{B}|\[\s*LEG\s*\]|\(\s*LEG\s*\)|{B}LEG{B})",
    )
});
static LEGENDADO: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(?i)LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)|{B}LEG{B}"));
/// `NERD_AUDIO_RE` (sem `/i`: o texto já chega em maiúsculas).
pub static NERD_AUDIO: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(DUAL\s+ÁUDIO|DUBLAD[A-Za-z0-9_]*|LEGENDAD[A-Za-z0-9_]*|PORTUGU[ÊE]S)"));
/// `NERD_LEGENDADO_RE`.
pub static NERD_LEGENDADO: LazyLock<Regex> = LazyLock::new(|| rx(r"LEGENDAD"));

/// `lastAudioMarker`: último marcador do texto → legendado/dublado.
pub fn last_audio_marker(text: &str, re: &Regex, legendado_re: &Regex) -> Option<String> {
    let marker = re.captures_iter(text).last()?;
    let group = marker.get(1).map(|m| m.as_str()).unwrap_or("");
    Some(
        if legendado_re.is_match(group) {
            "legendado"
        } else {
            "dublado"
        }
        .to_string(),
    )
}

/// `createBrAudioHooks().audioFromSegment` (bludv/comandotorrents).
pub fn br_audio_from_segment(segment: &str) -> Option<String> {
    last_audio_marker(segment, &AUDIO_SEGMENT, &LEGENDADO)
}

/// `createBrAudioHooks().audioFromAnchor`.
pub fn br_audio_from_anchor(anchor_text: &str) -> Option<String> {
    last_audio_marker(anchor_text, &AUDIO_ANCHOR, &LEGENDADO)
}

// ─── texto e href ────────────────────────────────────────────────────────

/// `attribute(tag, name)` de `resolvers/text.ts` (sem espaço em volta do `=`).
pub fn attribute(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?i){B}{}=["']([^"']*)["']"#, regex::escape(name));
    let re = Regex::new(&pattern).ok()?;
    re.captures(tag).map(|c| c[1].to_string())
}

/// Compila um padrão com `{B}` (fronteira ASCII do JS).
pub fn compile(pattern: &str) -> Regex {
    rx(pattern)
}

static MAGNET_PREFIX: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^magnet:\?"));

/// `createProtectorHrefResolver` (comandotorrents/vacatorrent): magnet cru por
/// prefixo; http(s) só com host de protetor, lendo o `to=` antes da checagem.
pub fn resolve_protector_href(
    attrs: &str,
    base_url: Option<&str>,
    is_protector_host: &dyn Fn(&str) -> bool,
) -> Resolved {
    let raw = attribute(attrs, "href").unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return Resolved::Skip { advance: false };
    }
    if MAGNET_PREFIX.is_match(raw) {
        return Resolved::Url(raw.to_string());
    }
    let parsed = match base_url {
        Some(base) => Url::parse(base).and_then(|b| b.join(raw)),
        None => Url::parse(raw),
    };
    let Ok(resolved) = parsed else {
        return Resolved::Skip { advance: true };
    };
    let mut target_host = resolved.host_str().unwrap_or("").to_string();
    if let Some((_, to)) = resolved.query_pairs().find(|(k, _)| k == "to") {
        if !to.is_empty() {
            if let Ok(target) = Url::parse(&decode_entities(&to)) {
                target_host = target.host_str().unwrap_or("").to_string();
            }
        }
    }
    if !is_protector_host(&target_host) {
        return Resolved::Skip { advance: true };
    }
    Resolved::Url(resolved.to_string())
}
