//! Porte de `sourceFromTitle`, `editionFromTitle` e `compactAudio`
//! (`src/utils/audio-quality.ts`).
//!
//! Escopo desta fatia: SÓ estas três funções. `qualityFromTitle` já tem porte
//! (stream_quotas_extra); `audioFromTitle`, `compactTracker`, `explicitPtAudio`
//! e `hasExplicitForeignAudio` ficam para fatias próprias.
//!
//! `sourceFromTitle` decide a FONTE da release (BluRay > WEB-DL > WEBRip >
//! HDTV > CAM/TS/TC/TeleSync/TeleCine/PreDVD). A precedência é o que importa:
//! uma linha "1080p WEB-DL BluRay" é BluRay. `editionFromTitle` rotula o CORTE
//! (Alt.End, Alt.Ver, DC, Extended, Cinema, Remaster, IMAX, Uncut) — release de
//! corte diferente é filme diferente e só o rótulo compacto o separa.
//! `compactAudio` traduz o balde de áudio para a coluna estreita.
//!
//! Semântica copiada do TS com as MESMAS decisões de fronteira:
//! - `\b` é ASCII no JS (sem flag `u`), por isso `(?-u:\b)`; o `\b` Unicode do
//!   crate divergiria com acento colado ("ÇBLURAY").
//! - `\s` é a classe explícita JS_SPACE de `matching_vocabulary` (inclui NBSP,
//!   separadores Unicode e o BOM U+FEFF), nunca o `\s` Unicode do crate.
//! - `_` vira espaço antes dos testes (é separador de release: "HDCAM_1080p").
//! - `toUpperCase` do JS e `str::to_uppercase` do Rust coincidem nas linhas
//!   observadas (tabelas Unicode do Node 22 e do Rust medidos no corpus); alias
//!   fora da tabela medida (ligaduras, turco) NÃO é reivindicado aqui.
//! - a remoção de extensão final usa `\z` (fim absoluto), como o `$` do JS sem
//!   flag `m`: um `.TS` de arquivo não é `TELESYNC`.

use std::sync::OnceLock;

use regex::Regex;

use crate::matching_vocabulary::JS_SPACE;

/// `\b` do JS sem flag `u`: fronteira ASCII, não a fronteira Unicode do crate.
const B: &str = r"(?-u:\b)";

fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("regex de rótulo de release compila")
}

/// `\.(?:TS|MKV|AVI|MP4|MOV|FLV|WMV|WEBM)$` do TS. O `/i` do original é
/// redundante: a entrada já passou por `to_uppercase`.
fn ext_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(r"\.(?:TS|MKV|AVI|MP4|MOV|FLV|WMV|WEBM)\z"))
}

// ── sourceFromTitle ─────────────────────────────────────────────────────
fn blu_ray_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}(?:BLURAY|BLU-RAY|BDREMUX|BD{B})")))
}
fn web_dl_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}WEB[-. ]?DL{B}")))
}
fn web_rip_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}WEB[-. ]?RIP{B}")))
}
fn hdtv_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}HDTV{B}")))
}
fn cam_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}(?:HD[-. ]?)?CAM(?:[-. ]?RIP)?{B}")))
}
/// `TS`/`TC` curtos exigem fronteira de token: sem `\b` casariam dentro de
/// "H264" ou "DDP5.1".
fn ts_tc_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}(?:HD[-. ]?)?(?:TS|TC){B}")))
}
fn telesync_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}TELESYNC{B}")))
}
fn telecine_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}TELECINE{B}")))
}
fn pre_dvd_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}PRE[-. ]?DVD{B}")))
}

/// Normaliza para os testes de fonte: caixa alta, extensão final removida e
/// `_` trocado por espaço. A ordem é a do TS (extensão antes do `_`).
fn normalize_source(title: &str) -> String {
    let upper = title.to_uppercase();
    let no_ext = ext_re().replace(&upper, "");
    no_ext.replace('_', " ")
}

/// Fonte da release, ou `""` quando nenhuma é reconhecida. Precedência:
/// BluRay, WEB-DL, WEBRip, HDTV, depois família CAM (CAM/TS/TC/TeleSync/
/// TeleCine/PreDVD).
pub fn source_from_title(title: &str) -> &'static str {
    let t = normalize_source(title);
    if blu_ray_re().is_match(&t) {
        return "BluRay";
    }
    if web_dl_re().is_match(&t) {
        return "WEB-DL";
    }
    if web_rip_re().is_match(&t) {
        return "WEBRip";
    }
    if hdtv_re().is_match(&t) {
        return "HDTV";
    }
    if cam_re().is_match(&t) {
        return "CAM";
    }
    if ts_tc_re().is_match(&t) {
        return "CAM";
    }
    if telesync_re().is_match(&t) {
        return "CAM";
    }
    if telecine_re().is_match(&t) {
        return "CAM";
    }
    if pre_dvd_re().is_match(&t) {
        return "CAM";
    }
    ""
}

// ── editionFromTitle ────────────────────────────────────────────────────
/// `ALTERNAT(E|IVO|IVA)\s+(ENDING|FINAL)`.
fn alt_end_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"{B}ALTERNAT(?:E|IVO|IVA){S}+(?:ENDING|FINAL){B}",
            S = JS_SPACE
        ))
    })
}
/// `ALTERNAT(E|IVO|IVA)\s+(VERSION|VERS[AÃ]O|CUT)` OU `VERS[AÃ]O\s+ALTERNATIVA`.
fn alt_ver_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"{B}ALTERNAT(?:E|IVO|IVA){S}+(?:VERSION|VERS[A\u{{c3}}]O|CUT){B}|{B}VERS[A\u{{c3}}]O{S}+ALTERNATIVA{B}",
            S = JS_SPACE
        ))
    })
}
/// `(DIRECTOR'?S\s+CUT|DIRECTORS\s+CUT)`.
fn dc_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"{B}(?:DIRECTOR'?S{S}+CUT|DIRECTORS{S}+CUT){B}",
            S = JS_SPACE
        ))
    })
}
/// `(EXTENDED|VERS[AÃ]O\s+ESTENDIDA)`.
fn extended_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"{B}(?:EXTENDED|VERS[A\u{{c3}}]O{S}+ESTENDIDA){B}",
            S = JS_SPACE
        ))
    })
}
/// `(THEATRICAL|VERS[AÃ]O\s+DE\s+CINEMA)`.
fn cinema_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"{B}(?:THEATRICAL|VERS[A\u{{c3}}]O{S}+DE{S}+CINEMA){B}",
            S = JS_SPACE
        ))
    })
}
/// `(REMASTER(ED)?|REMASTERIZAD[OA])`.
fn remaster_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}(?:REMASTER(?:ED)?|REMASTERIZAD[OA]){B}")))
}
fn imax_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| compile(&format!(r"{B}IMAX{B}")))
}
/// `(UNCUT|UNRATED|SEM\s+CORTES)`.
fn uncut_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        compile(&format!(
            r"{B}(?:UNCUT|UNRATED|SEM{S}+CORTES){B}",
            S = JS_SPACE
        ))
    })
}

/// Corte do filme anunciado na release, ou `""`. A ordem é a do TS e importa:
/// "Alternate Ending + Director's Cut" é Alt.End, "IMAX Uncut" é IMAX.
pub fn edition_from_title(title: &str) -> &'static str {
    let t = title.to_uppercase();
    if alt_end_re().is_match(&t) {
        return "Alt.End";
    }
    if alt_ver_re().is_match(&t) {
        return "Alt.Ver";
    }
    if dc_re().is_match(&t) {
        return "DC";
    }
    if extended_re().is_match(&t) {
        return "Extended";
    }
    if cinema_re().is_match(&t) {
        return "Cinema";
    }
    if remaster_re().is_match(&t) {
        return "Remaster";
    }
    if imax_re().is_match(&t) {
        return "IMAX";
    }
    if uncut_re().is_match(&t) {
        return "Uncut";
    }
    ""
}

// ── compactAudio ────────────────────────────────────────────────────────
/// Rótulo curto do áudio para a coluna estreita. Igualdade EXATA: qualquer
/// valor fora dos quatro baldes (inclusive caixa diferente) devolve `""`.
pub fn compact_audio(audio: &str) -> &'static str {
    match audio {
        "Dublado" => "DUB",
        "Legendado" => "LEG",
        "Dual" => "DUAL",
        "Nacional" => "NAC",
        _ => "",
    }
}
