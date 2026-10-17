//! Porte de `stripQualityTagBlob`, `audioFromTitle` e `looksPtBr`
//! (`src/utils/audio-quality.ts`) — a leitura de ÁUDIO a partir do título.
//!
//! `strip_quality_tag_blob` corta a cauda de qualidade/fonte que os posts BR
//! colam no fim do título (blob com 2+ tags separadas por vírgula). O
//! vocabulário do blob é DERIVADO do `TECH_NOISE` já portado em
//! `matching_vocabulary` e filtrado pela mesma régua do TS — nada de lista nova
//! que possa divergir.
//!
//! `audio_from_title` reusa `explicit_pt_audio` (já portado em `pt_audio_guards`)
//! e implementa a convenção de nome do HDRTorrent (prefixo "Dublada e Dual" ×
//! marcador LEGENDADA do botão). `looks_pt_br` reusa `audio_from_title`,
//! `explicit_pt_audio` e `has_pt_signs` (`br_origin`) — nenhuma lista de idioma
//! duplicada.
//!
//! Regras de paridade com o JS (sem a flag `u`):
//! - `\b` é ASCII (`(?-u:\b)`), como em `audio_lang`/`pt_audio_guards`.
//! - `\s` é `JS_SPACE` (o conjunto do `\s` do ECMAScript, com o BOM U+FEFF).
//! - `\d` vira `[0-9]` (o `\d` do crate aceita dígitos de outros scripts).
//! - `trimEnd` é `js_trim_end` (mesmo conjunto do `js_trim`; NÃO remove o NEL
//!   U+0085, que o `str::trim` do Rust tiraria e o JS não).

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::br_origin::has_pt_signs;
use crate::js_text::js_trim;
use crate::matching_vocabulary::{vocabulary_contents, JS_SPACE};
use crate::pt_audio_guards::explicit_pt_audio;

/// `\b` do JS sem flag `u`: fronteira ASCII, não a Unicode do crate.
fn bounded(alts: &str) -> String {
    format!(r"(?-u:\b)(?:{alts})(?-u:\b)")
}

// ─── trimEnd do JS ───────────────────────────────────────────────────

/// Espaço no sentido do `String.prototype.trim` do JS (mesmo conjunto do
/// `js_trim`): WhiteSpace + LineTerminator, com o BOM e SEM o NEL U+0085.
fn is_js_space(c: char) -> bool {
    js_trim(c.encode_utf8(&mut [0; 4])).is_empty()
}

/// `String.prototype.trimEnd` do JS.
fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

// ─── Vocabulário do blob de qualidade/fonte ──────────────────────────

/// `/^(?:\d{3,4}p|4k|…|blu|ray)$/` do TS, com `\d` explícito em `[0-9]`.
fn blob_tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(concat!(
            r"^(?:[0-9]{3,4}p|4k|uhd|sd|hd|hdrip|fullhd|webdl|webrip|bluray|bdrip|brrip|",
            r"hdtv|remux|hybrid|x264|x265|h264|h265|avc|hevc|av1|xvid|divx|10bit|8bit|",
            r"hdr|hdr10|imax|mkv|mp4|avi|web|dl|blu|ray)$",
        ))
        .expect("vocabulário do blob compila")
    })
}

/// `normalizeBlobTag`: minúsculas e só `[a-z0-9+]` sobrevivem.
fn normalize_blob_tag(tag: &str) -> String {
    tag.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+')
        .collect()
}

/// `TAG_BLOB_VOCAB`: recorte do `TECH_NOISE` já portado, com o MESMO filtro e a
/// MESMA normalização do TS. Derivar do vocabulário existente evita lista nova.
fn tag_blob_vocab() -> &'static HashSet<String> {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        vocabulary_contents("TECH_NOISE")
            .expect("TECH_NOISE portado em matching_vocabulary")
            .split(' ')
            .filter(|w| blob_tag_re().is_match(w))
            .map(normalize_blob_tag)
            .collect()
    })
}

// ─── Blob de tags no fim do título ───────────────────────────────────

/// `/[,;]\s*([A-Za-z0-9][A-Za-z0-9+.\-]*)\s*$/`.
fn tag_tail_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"[,;]{s}*([A-Za-z0-9][A-Za-z0-9+.\-]*){s}*$",
            s = JS_SPACE
        ))
        .expect("cauda do blob compila")
    })
}

/// `/(?:^|\s)([A-Za-z0-9][A-Za-z0-9+.\-]*)$/`.
fn blob_head_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?:^|{s})([A-Za-z0-9][A-Za-z0-9+.\-]*)$",
            s = JS_SPACE
        ))
        .expect("cabeça do blob compila")
    })
}

/// `stripQualityTagBlob`: corta a cauda de tags de qualidade/fonte (2+ tags
/// separadas por vírgula/ponto-e-vírgula NO FIM) e a cabeça colada sem vírgula.
pub fn strip_quality_tag_blob(title: &str) -> &str {
    if !title.contains(',') {
        return title;
    }
    let mut cut = title.len();
    let mut tags = 0u32;
    loop {
        let prefix = &title[..cut];
        let Some(caps) = tag_tail_re().captures(prefix) else {
            break;
        };
        let tag = caps.get(1).map_or("", |m| m.as_str());
        if !tag_blob_vocab().contains(&normalize_blob_tag(tag)) {
            break;
        }
        let Some(full) = caps.get(0) else { break };
        cut = full.start();
        tags += 1;
    }
    if tags < 2 {
        return title;
    }
    // A cabeça é medida sobre o corpo NÃO aparado, como no TS: se houver espaço
    // sobrando antes da vírgula, a régua `…$` falha e só o trimEnd se aplica.
    let before = &title[..cut];
    if let Some(caps) = blob_head_re().captures(before) {
        let head = caps.get(1).map_or("", |m| m.as_str());
        if tag_blob_vocab().contains(&normalize_blob_tag(head)) {
            return js_trim_end(&before[..before.len() - head.len()]);
        }
    }
    js_trim_end(before)
}

// ─── Classificação de áudio do título ────────────────────────────────

/// `\bDUBLAD[OA]\s+E\s+DUAL\b` (convenção de prefixo do HDRTorrent).
fn convencao_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?-u:\b)DUBLAD[OA]{s}+E{s}+DUAL(?-u:\b)",
            s = JS_SPACE
        ))
        .expect("convenção DUBLADA E DUAL compila")
    })
}

/// `LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB`.
fn sub_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&bounded(
            r"LEGENDAD[OA]|LEGENDAS?|LEG[-.]?PT[-.]?BR|SUB[-.]?PT[-.]?BR|SOFT[- ]?SUB",
        ))
        .expect("marcador de legenda compila")
    })
}

/// `\[\s*LEG\s*\]|\(\s*LEG\s*\)|\bLEG\b`, com `\s` do JS e `\b` ASCII.
fn leg_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let pattern = format!(
            r"\[{s}*LEG{s}*\]|\({s}*LEG{s}*\)|{word}",
            s = JS_SPACE,
            word = bounded("LEG"),
        );
        Regex::new(&pattern).expect("marcador LEG compila")
    })
}

/// `\b(DUAL|DOUBLE|MULTI|…|MULTIAUDIO)\b`.
fn dual_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&bounded(
            r"DUAL|DOUBLE|MULTI|DUAL[- ]?AUDIO|AUDIO[- ]?DUPLO|DUPLO[- ]?AUDIO|MULTI[- ]?AUDIO|MULTIAUDIO",
        ))
        .expect("marcador de dual compila")
    })
}

/// `\b(NACIONAL|NAC)\b`.
fn nacional_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&bounded("NACIONAL|NAC")).expect("marcador NACIONAL compila"))
}

/// `\b(LEG|LEGENDAD[OA]|SUB|SUBBED)\b` (a guarda curta do NACIONAL).
fn leg_simple_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&bounded("LEG|LEGENDAD[OA]|SUB|SUBBED")).expect("marcador LEG curto compila")
    })
}

/// `audioFromTitle`: rótulo de áudio do título (`Dublado`/`Legendado`/`Dual`/
/// `Nacional`, ou `""`).
pub fn audio_from_title(title: &str) -> &'static str {
    // O blob do fim não descreve áudio, mas pode citar "DUAL": classifica sobre
    // o título sem a cauda. `_` é separador de fato nos posts BR.
    let t = strip_quality_tag_blob(title)
        .to_uppercase()
        .replace('_', " ");

    // A convenção "Dublada e Dual" é prefixo do post e não prova o botão: o
    // marcador LEGENDADA fora dela vence, e um DUBLADO/DUAL fora dela mantém o
    // comportamento de sempre.
    let sem_convencao = convencao_re().replace_all(&t, " ").into_owned();
    let is_explicit_sub =
        sub_mark_re().is_match(&sem_convencao) || leg_re().is_match(&sem_convencao);
    let is_explicit_dub = explicit_pt_audio(&sem_convencao);

    if is_explicit_sub && explicit_pt_audio(&t) && !is_explicit_dub {
        return "Legendado";
    }
    // MULTI sozinho carrega a faixa original e não prova conteúdo estrangeiro.
    if dual_re().is_match(&t) {
        return "Dual";
    }
    // Produções nacionais (áudio original em PT-BR).
    if nacional_re().is_match(&t) && !leg_simple_re().is_match(&t) {
        return "Nacional";
    }
    if is_explicit_dub && is_explicit_sub {
        return "Dual";
    }
    if is_explicit_dub {
        return "Dublado";
    }
    if is_explicit_sub {
        return "Legendado";
    }
    ""
}

/// `looks_pt_br` sobre um rótulo de áudio JÁ calculado: mesma composição, sem
/// recalcular `audio_from_title` (é a parte caríssima da função).
fn looks_pt_br_with_audio(title: &str, audio: &str) -> bool {
    if audio == "Dublado" || audio == "Nacional" {
        return true;
    }
    audio == "Dual" && (explicit_pt_audio(title) || has_pt_signs(title))
}

/// `looksPtBr`: dublado PT-BR visível no TÍTULO, independente do indexer.
/// `Dual` sozinho segue ambíguo: só conta com PT explícito ao lado ou sinal de
/// português — `has_pt_signs` entra em CONJUNÇÃO, nunca no lugar da marca.
pub fn looks_pt_br(title: &str) -> bool {
    looks_pt_br_with_audio(title, audio_from_title(title))
}

/// Sondas de áudio de UM título, para a ponte classificar LISTAS (o inventário
/// da conta tem 1203 itens medidos): o rótulo e o `looksPtBr` saem da MESMA
/// passada. Chamar `audio_from_title` e `looks_pt_br` separados recalcularia o
/// rótulo inteiro (duas passadas) dentro do laço.
pub struct AudioSignals {
    pub audio: &'static str,
    pub looks_pt_br: bool,
}

/// `audioFromTitle` + `looksPtBr` numa passada só — sem regra nova: a
/// composição é a de `looks_pt_br`, sobre o rótulo que ele mesmo usaria.
pub fn audio_signals(title: &str) -> AudioSignals {
    let audio = audio_from_title(title);
    AudioSignals {
        audio,
        looks_pt_br: looks_pt_br_with_audio(title, audio),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O lote não pode divergir das funções avulsas: é a MESMA composição.
    #[test]
    fn audio_signals_espelha_as_funcoes_avulsas() {
        for titulo in [
            "Filme Dublado 1080p",
            "Filme Dual Áudio",
            "Filme DUAL",
            "Filme DUAL_Misso 1080p",
            "Filme Legendado",
            "Filme NACIONAL",
            "Movie 1080p WEB-DL",
            "Filme Dublada e Dual LEGENDADA 1080P",
            "Filme 1080p, 2160p, 720p, HD, WEB-DL",
            "Dual",
            "",
        ] {
            let sinais = audio_signals(titulo);
            assert_eq!(sinais.audio, audio_from_title(titulo), "{titulo}");
            assert_eq!(sinais.looks_pt_br, looks_pt_br(titulo), "{titulo}");
        }
    }
}
