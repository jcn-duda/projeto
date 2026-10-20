//! Título/áudio do BLUDV como o Node (`resolvers/release-format.ts` +
//! `resolvers/release-rules.ts`).
//!
//! O `bludv.ts` NÃO usa o título do post cru: `releaseTitle(post, link)`
//! limpa o post em 7 passos e anexa os atributos do BOTÃO numa tag
//! (`[1080p WEB-DL DUBLADO]`). Sem essa tag o build perde a qualidade/áudio do
//! botão (o título do post cita a vitrine inteira) e o chip DUB não sai.
//!
//! O que é portado aqui:
//!
//! - `clean_post_title` (as 7 remoções, com `\b` ASCII como o JS sem flag `u`);
//! - `normalize_quality` / `normalize_source` por ÚLTIMA ocorrência no contexto
//!   (segmento + texto da âncora), como o `createLinkCollector`;
//! - marcadores de áudio (DUAL ÁUDIO/DUBLADO/LEGENDADO/NACIONAL/PORTUGUÊS/
//!   `[DUB]`/`[LEG]`), no segmento e na âncora — a âncora vence no botão;
//! - `release_title` = post limpo + `[qualidade fonte ÁUDIO]`, SEM tamanho
//!   (`withSize:false` do BLUDV).
//!
//! Fora: o `episodeOf` do `createReleaseTitle` (o BLUDV usa o passo de episódio
//! do `createLinkCollector`, que exige o estado âncora-local e a faixa
//! `episodeLast`). O título do post continua carregando a temporada/episódio;
//! só o sufixo `E01` que o Node acrescenta fica de fora — o build ainda casa o
//! episódio pelo título.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use adom_core::decode_entities;

use super::types::BludvDownloadLink;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("regex fixa do BLUDV")
}

static TORRENT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*"));
// Sem `\bHD\b`: ele é removido num passo próprio para respeitar
// `\bHD\b(?!\s*TV)` (o `regex` não tem lookahead).
static RESOLUTION: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(?-u:\b)(?:2160p|1080p|720p|576p|480p|[0-9]{3,4}p|4K|8K|UHD|ULTRA\s*HD|FULL\s*HD|SD)(?-u:\b)",
    )
});
static CODEC: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(?-u:\b)(?:BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BDRIP|BRRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM|IMAX|3D|REMASTERED|REMASTER|HDR(?:10\+?)?|DOLBY\s*VISION|DV)(?-u:\b)",
    )
});
static CHANNELS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(?-u:\b)(?:5\.1|7\.1|2\.0|7\.2|DDP\s*5\.1|ATMOS)(?-u:\b)"));
static AUDIO_TAGS: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(?-u:\b)(?:Dublado|Dublada|Legendado|Legendada|Dual\s*[AÁ]udio|Nacional|Multi\s*[AÁ]udio|Tri\s*[AÁ]udio|[AÁ]udio\s*Original)(?-u:\b)",
    )
});
static SEO: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)(?-u:\b)(?:Download|Baixar|Gr[áa]tis|Online|Completo|Completa|Assistir)(?-u:\b)")
});
static ORPHAN_SEPS: LazyLock<Regex> = LazyLock::new(|| re(r"\s*[/|–\-—:&+]\s*([/|–\-—:&+]\s*)+"));
static LEADING_SEPS: LazyLock<Regex> = LazyLock::new(|| re(r"^[–\-—/|:&+\s]+"));
static TRAILING_SEPS: LazyLock<Regex> = LazyLock::new(|| re(r"[–\-—/|:&+\s]+$"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));

/// `\bHD\b` isolado (o lookahead do TS é aplicado no fecho do `replace_all`).
static HD: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)HD(?-u:\b)"));

/// Limpeza do título do post em 7 passos (bludv/comandotorrents).
pub fn clean_post_title(title: &str) -> String {
    let mut clean = decode_entities(title);
    clean = TORRENT.replace_all(&clean, " ").into_owned();
    clean = RESOLUTION.replace_all(&clean, " ").into_owned();
    clean = HD
        .replace_all(&clean, |caps: &Captures| {
            if hd_is_tv(&clean, caps.get(0).map(|m| m.start()).unwrap_or(0)) {
                caps[0].to_string()
            } else {
                " ".to_string()
            }
        })
        .into_owned();
    clean = CODEC.replace_all(&clean, " ").into_owned();
    clean = CHANNELS.replace_all(&clean, " ").into_owned();
    clean = AUDIO_TAGS.replace_all(&clean, " ").into_owned();
    clean = SEO.replace_all(&clean, " ").into_owned();
    clean = ORPHAN_SEPS.replace_all(&clean, " ").into_owned();
    clean = LEADING_SEPS.replace_all(&clean, "").into_owned();
    clean = TRAILING_SEPS.replace_all(&clean, "").into_owned();
    SPACES.replace_all(&clean, " ").trim().to_string()
}

/// O `HD` em `at` é seguido de espaços + "TV"? (o `(?!\s*TV)` do JS).
fn hd_is_tv(text: &str, at: usize) -> bool {
    let rest = &text[at + 2..];
    let mut chars = rest.chars().peekable();
    while chars.peek().is_some_and(|c| c.is_whitespace()) {
        chars.next();
    }
    let tail: String = chars.take(2).collect();
    tail.eq_ignore_ascii_case("tv")
}

static QUALITY_2160: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(?-u:\b)(?:2160\s*P|4K|UHD)(?-u:\b)"));
static QUALITY_1080: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)(?-u:\b)(?:1080\s*P|FULL\s*HD)(?-u:\b)"));
static QUALITY_720: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)720\s*P(?-u:\b)"));
static QUALITY_576: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)576\s*P(?-u:\b)"));
static QUALITY_480: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)(?:480\s*P|SD)(?-u:\b)"));
static QUALITY_NUM: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)([0-9]{3,4})\s*P(?-u:\b)"));
static HD_QUALITY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)(?-u:\b)HD(?-u:\b)"));

/// `normalizeQuality(context)` do TS: ÚLTIMA ocorrência do contexto.
pub fn normalize_quality(context: &str) -> Option<u32> {
    let mut best: Option<(usize, u32)> = None;
    let mut take = |start: usize, value: u32| {
        if best.is_none_or(|(at, _)| start >= at) {
            best = Some((start, value));
        }
    };
    for m in QUALITY_2160.find_iter(context) {
        take(m.start(), 2160);
    }
    for m in QUALITY_1080.find_iter(context) {
        take(m.start(), 1080);
    }
    for m in QUALITY_720.find_iter(context) {
        take(m.start(), 720);
    }
    for m in QUALITY_576.find_iter(context) {
        take(m.start(), 576);
    }
    for m in QUALITY_480.find_iter(context) {
        take(m.start(), 480);
    }
    for caps in QUALITY_NUM.captures_iter(context) {
        if let Some(value) = caps.get(1).and_then(|m| m.as_str().parse::<u32>().ok()) {
            take(caps.get(0).map(|m| m.start()).unwrap_or(0), value);
        }
    }
    // `\bHD\b(?!\s*TV)`: pula o HD de "FULL HD"/"ULTRA HD" (já casados acima).
    for m in HD_QUALITY.find_iter(context) {
        let before = &context[..m.start()];
        let last = before
            .trim_end()
            .rsplit(|c: char| c.is_whitespace())
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        if last == "FULL" || last == "ULTRA" {
            continue;
        }
        if hd_is_tv(context, m.start()) {
            continue;
        }
        take(m.start(), 720);
    }
    best.map(|(_, value)| value)
}

static SOURCE_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(?-u:\b)(BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BD|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM)(?-u:\b)",
    )
});

/// `extractSourceToken`: a classificação por categoria (a ordem importa).
fn source_token(token: &str) -> Option<&'static str> {
    let token = token.to_ascii_uppercase();
    let has = |pattern: &str| Regex::new(pattern).is_ok_and(|re| re.is_match(&token));
    if has(r"(?-u:\b)(?:BDREMUX|REMUX)(?-u:\b)") {
        return Some("REMUX");
    }
    if has(r"(?-u:\b)(?:BLU[- ]?RAY|BLURAY|BD|BDRIP)(?-u:\b)") {
        return Some("BLU-RAY");
    }
    if has(r"(?-u:\b)(?:WEB[-. ]?DL)(?-u:\b)") {
        return Some("WEB-DL");
    }
    if has(r"(?-u:\b)(?:WEB[-. ]?RIP|WEBRIP)(?-u:\b)") {
        return Some("WEBRIP");
    }
    if has(r"(?-u:\b)HDTV(?-u:\b)") {
        return Some("HDTV");
    }
    if has(r"(?-u:\b)(?:CAMRIP|CAM)(?-u:\b)") {
        return Some("CAM");
    }
    None
}

/// `normalizeSource(context)` do TS: classifica a ÚLTIMA ocorrência.
pub fn normalize_source(context: &str) -> Option<&'static str> {
    let mut best: Option<(usize, &'static str)> = None;
    for caps in SOURCE_RE.captures_iter(context) {
        let Some(token) = caps.get(1) else { continue };
        let Some(kind) = source_token(token.as_str()) else {
            continue;
        };
        let start = token.start();
        if best.is_none_or(|(at, _)| start >= at) {
            best = Some((start, kind));
        }
    }
    best.map(|(_, kind)| kind)
}

/// `AUDIO_SEGMENT_RE` de `release-rules.ts` (seção do post).
static AUDIO_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(?:VERS[ÃA]O\s+)?(?:MKV\s+|MP4\s+)?(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD[A-Za-z0-9_]*|LEGENDAD[A-Za-z0-9_]*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|(?-u:\b)DUB(?-u:\b)|\[\s*LEG\s*\]|\(\s*LEG\s*\)|(?-u:\b)LEG(?-u:\b))",
    )
});
/// `AUDIO_ANCHOR_RE`: a mesma lista, sem o prefixo "VERSÃO MKV/MP4".
static AUDIO_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(DUAL[-\s]+[AÁ]UDIO|AUDIO[-\s]+DUPLO|DUPLO[-\s]+AUDIO|DUBLAD[A-Za-z0-9_]*|LEGENDAD[A-Za-z0-9_]*|NACIONAL|PORTUGU[ÊE]S|PORTUGUES|\[\s*DUB\s*\]|\(\s*DUB\s*\)|(?-u:\b)DUB(?-u:\b)|\[\s*LEG\s*\]|\(\s*LEG\s*\)|(?-u:\b)LEG(?-u:\b))",
    )
});
static LEGENDADO: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)|(?-u:\b)LEG(?-u:\b)"));

fn last_audio_marker(text: &str, re: &Regex) -> Option<&'static str> {
    let marker = re.captures_iter(text).last()?;
    let body = marker.get(1).map(|m| m.as_str()).unwrap_or("");
    Some(if LEGENDADO.is_match(body) {
        "legendado"
    } else {
        "dublado"
    })
}

/// Marcador de áudio da SEÇÃO (o estado que vale para os botões seguintes).
pub fn audio_from_segment(segment: &str) -> Option<&'static str> {
    last_audio_marker(segment, &AUDIO_SEGMENT)
}

/// Marcador de áudio LOCAL à âncora (vence o da seção no botão).
pub fn audio_from_anchor(anchor_text: &str) -> Option<&'static str> {
    last_audio_marker(anchor_text, &AUDIO_ANCHOR)
}

/// Título da release: post limpo + atributos do BOTÃO na tag.
///
/// `withSize:false` (BLUDV): o tamanho fica no `<div class="size">`, não no
/// título. O `stripSource` do TS é redundante aqui — o `clean_post_title` já
/// remove todas as fontes que o classificador reconhece.
pub fn release_title(post_title: &str, link: &BludvDownloadLink) -> String {
    let base = clean_post_title(post_title);
    let mut tags: Vec<String> = Vec::new();
    if let Some(quality) = link.quality {
        tags.push(format!("{quality}p"));
    }
    if let Some(source) = link.source.as_deref().filter(|s| !s.is_empty()) {
        tags.push(source.to_string());
    }
    match link.audio.as_str() {
        "dublado" => tags.push("DUBLADO".into()),
        "legendado" => tags.push("LEGENDADO".into()),
        _ => {}
    }
    if tags.is_empty() {
        base
    } else {
        format!("{base} [{}]", tags.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(audio: &str, quality: Option<u32>, source: Option<&str>) -> BludvDownloadLink {
        BludvDownloadLink {
            url: "https://systemads.example/a".into(),
            label: String::new(),
            size: None,
            audio: audio.into(),
            quality,
            source: source.map(str::to_string),
        }
    }

    #[test]
    fn limpa_vitrine_do_post() {
        assert_eq!(
            clean_post_title("Coringa (2019) Torrent Dublado 1080p WEB-DL"),
            "Coringa (2019)"
        );
        assert_eq!(
            clean_post_title("O Poderoso Chefão: Parte II – 4K UHD Dual Áudio"),
            "O Poderoso Chefão: Parte II"
        );
        assert_eq!(clean_post_title("Filme Completo Online Grátis"), "Filme");
    }

    #[test]
    fn hd_isola_a_palavra_sem_matar_hd_tv() {
        assert_eq!(clean_post_title("Canal HD"), "Canal");
        assert_eq!(clean_post_title("Canal HD TV"), "Canal HD TV");
        assert_eq!(clean_post_title("Canal FULL HD"), "Canal");
    }

    #[test]
    fn release_title_anexa_qualidade_fonte_e_audio() {
        let post = "Coringa (2019) Torrent Dublado 1080p WEB-DL";
        assert_eq!(
            release_title(post, &link("dublado", Some(1080), Some("WEB-DL"))),
            "Coringa (2019) [1080p WEB-DL DUBLADO]"
        );
        assert_eq!(
            release_title(post, &link("legendado", Some(720), None)),
            "Coringa (2019) [720p LEGENDADO]"
        );
        assert_eq!(
            release_title("Coringa (2019)", &link("desconhecido", None, None)),
            "Coringa (2019)"
        );
    }

    #[test]
    fn normalize_quality_pega_a_ultima_do_contexto() {
        assert_eq!(normalize_quality("WEB-DL 1080p x265"), Some(1080));
        assert_eq!(normalize_quality("POST 4K / BOTÃO 720p"), Some(720));
        assert_eq!(normalize_quality("FULL HD"), Some(1080));
        assert_eq!(normalize_quality("HD"), Some(720));
        assert_eq!(normalize_quality("HD TV"), None);
        assert_eq!(normalize_quality("sem resolução"), None);
    }

    #[test]
    fn normalize_source_classifica_a_ultima() {
        assert_eq!(normalize_source("WEB-DL"), Some("WEB-DL"));
        assert_eq!(normalize_source("BLURAY 1080p WEB-DL"), Some("WEB-DL"));
        assert_eq!(normalize_source("BDREMUX"), Some("REMUX"));
        assert_eq!(normalize_source("BDRIP"), Some("BLU-RAY"));
        assert_eq!(normalize_source("nada"), None);
    }

    #[test]
    fn audio_do_segmento_e_da_ancora() {
        assert_eq!(audio_from_segment("VERSÃO MKV DUAL ÁUDIO"), Some("dublado"));
        assert_eq!(
            audio_from_segment("VERSÃO MP4 LEGENDADO"),
            Some("legendado")
        );
        assert_eq!(audio_from_segment("NACIONAL"), Some("dublado"));
        assert_eq!(audio_from_segment("[LEG]"), Some("legendado"));
        assert_eq!(audio_from_segment("WEB-DL 1080p"), None);
        assert_eq!(audio_from_anchor("DUBLADO"), Some("dublado"));
        assert_eq!(audio_from_anchor("LEG"), Some("legendado"));
    }
}
