//! Porte de `compactTracker` (`src/utils/audio-quality.ts`) e de
//! `streamDisplayName` (`src/utils/stream-display.ts`) — a coluna estreita do
//! stream.
//!
//! `streamDisplayName` compõe o nome do card: resolução, corte, fonte, áudio e
//! semente, com o tracker opcional. O que ele chama já tem porte próprio:
//! `compact_audio`/`source_from_title`/`edition_from_title` (`release_labels`),
//! `looks_pt_br` (`audio_presentation`), `UNKNOWN_QUALITY`
//! (`stream_quotas_extra`). Aqui entram só as duas funções que faltavam e a
//! composição.
//!
//! `compactTracker` fatia em UNIDADES UTF-16 (`label.slice(0, 14)`) e pode
//! partir um par surrogate astral ao meio. Por isso ele devolve [`JsText`] e
//! não `String`: o órfão é preservado e o `js_stringify` o escapa como o
//! `JSON.stringify`. Não há conversão lossy no caminho.
//!
//! Paridade de fronteira copiada do TS: `\s` é a classe JS_SPACE explícita
//! (o `\s` do crate não inclui o BOM), `[\s_-]+` e a transição camelCase
//! `(?<=[a-z0-9])(?=[A-Z])` são reavaliadas sobre as unidades UTF-16
//! (`matchAll` conta índices em unidades), e o corte seco é `slice(0, 14)`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::audio_presentation::looks_pt_br;
use crate::js_text::{js_number, js_to_string, js_trim};
use crate::js_text16::JsText;
use crate::matching_vocabulary::JS_SPACE;
use crate::release_labels::compact_audio;
use crate::stream_quotas_extra::UNKNOWN_QUALITY;

/// `TRACKER_LABEL_MAX`: acima disso o rótulo empurra o seeder para fora da coluna.
const TRACKER_LABEL_MAX: usize = 14;

/// Estilo do nome do stream (`STREAM_NAME_STYLE`). Só o literal `full` liga o
/// estilo longo; qualquer outro valor (inclusive ausente) é `compact`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamNameStyle {
    #[default]
    Compact,
    Full,
}

impl StreamNameStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            StreamNameStyle::Compact => "compact",
            StreamNameStyle::Full => "full",
        }
    }
}

/// Default de instância (`config.streamNameStyle`/`config.streamNameShowSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamDisplayConfig {
    pub stream_name_style: StreamNameStyle,
    pub stream_name_show_source: bool,
}

impl Default for StreamDisplayConfig {
    fn default() -> Self {
        Self {
            stream_name_style: StreamNameStyle::Compact,
            stream_name_show_source: true,
        }
    }
}

/// `opts()` por usuário JÁ normalizado pelo runtime (chaves `ns`/`st` do
/// SCHEMA). Igual ao TS: depois do `normalize` os dois campos estão sempre
/// presentes; `stream_name_style` vazio significa "cai no config".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserDisplayOptions {
    pub stream_name_style: String,
    pub stream_name_show_source: bool,
}

/// Entrada de `streamDisplayName` (subconjunto do stream que a coluna usa).
///
/// `seeders` é um `Value` porque o JS faz DUAS coerções do mesmo valor:
/// `Number(seeders) > 0` decide o chip e o template `${seeders}` usa `String`
/// crua (por isso `"7"` vira `👤 7`). `show_source` presente-mas-`null` conta
/// como falso (`showSource !== undefined`), então `None` é só ausência.
#[derive(Debug, Clone, Default)]
pub struct StreamDisplayOptions<'a> {
    pub title: Option<&'a str>,
    pub quality: Option<&'a str>,
    pub audio: Option<&'a str>,
    pub source: Option<&'a str>,
    pub edition: Option<&'a str>,
    pub tracker: Option<&'a str>,
    pub is_br: bool,
    pub seeders: Option<&'a Value>,
    pub from_fallback: bool,
    pub style: Option<&'a str>,
    pub show_source: Option<bool>,
}

// ─── compactTracker ─────────────────────────────────────────────────────

/// `/(?:\.[a-z]{2,})+$/i`: remove o sufixo de TLD(s) do fim.
fn tld_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:\.[a-z]{2,})+\z").expect("TLD do tracker compila"))
}

/// `[\s_-]` como classe: reaproveita os MESMOS bytes da classe JS_SPACE (só
/// troca as barras externas) para não divergir do `\s` do ECMAScript.
fn sep_class() -> String {
    format!("[{}_-]", &JS_SPACE[1..JS_SPACE.len() - 1])
}

/// `/[\s_-]*torrents?$/i`: todos os sites repetem "torrent(s)", a parte que
/// menos identifica.
fn torrent_suffix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!("(?i){}*torrents?\\z", sep_class())).expect("sufixo torrent compila")
    })
}

/// Nome da fonte para a coluna estreita. Corta em unidades UTF-16 (via
/// `js_slice`) e pode devolver um surrogate órfão.
pub fn compact_tracker(tracker: &str) -> JsText {
    let mut label: String = tld_re().replace(js_trim(tracker), "").into_owned();
    if units_of(&label) <= TRACKER_LABEL_MAX {
        return JsText::from_str(&label);
    }

    let without = torrent_suffix_re().replace(&label, "").into_owned();
    if units_of(&without) >= 4 {
        label = without;
    }
    if units_of(&label) <= TRACKER_LABEL_MAX {
        return JsText::from_str(&label);
    }

    // Última fronteira que ainda cabe: separador ou transição camelCase.
    let window = JsText::from_str(&label).js_slice(TRACKER_LABEL_MAX + 1);
    let last_boundary = boundary_indices(window.as_units())
        .into_iter()
        .rfind(|&i| i >= 4);
    match last_boundary {
        Some(index) => JsText::from_str(&label).js_slice(index),
        None => JsText::from_str(&label).js_slice(TRACKER_LABEL_MAX),
    }
}

fn units_of(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Índices (em unidades UTF-16) onde começa `[\s_-]+` ou a transição
/// `(?<=[a-z0-9])(?=[A-Z])`, na ordem do `matchAll` do TS. A transição é
/// zero-width; a corrida de separadores entra com o índice do primeiro.
fn boundary_indices(units: &[u16]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        if is_sep_unit(units[i]) {
            out.push(i);
            i += 1;
            while i < units.len() && is_sep_unit(units[i]) {
                i += 1;
            }
            continue;
        }
        if i > 0 && is_lower_or_digit(units[i - 1]) && is_upper(units[i]) {
            out.push(i);
        }
        i += 1;
    }
    out
}

fn is_sep_unit(u: u16) -> bool {
    u == b'_' as u16 || u == b'-' as u16 || is_js_space_unit(u)
}

/// O conjunto do `\s` do ECMAScript (tudo BMP, logo uma unidade por caractere).
fn is_js_space_unit(u: u16) -> bool {
    matches!(
        u,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

fn is_lower_or_digit(u: u16) -> bool {
    (0x30..=0x39).contains(&u) || (0x61..=0x7A).contains(&u)
}

fn is_upper(u: u16) -> bool {
    (0x41..=0x5A).contains(&u)
}

// ─── streamDisplayName ───────────────────────────────────────────────────

/// `streamDisplayName` do TS. O resultado é [`JsText`] porque o chip do tracker
/// pode carregar surrogate órfão; compare via `js_stringify`.
pub fn stream_display_name(
    opts: &StreamDisplayOptions,
    user: Option<&UserDisplayOptions>,
    config: &StreamDisplayConfig,
) -> JsText {
    let title = opts.title.unwrap_or("");

    // Precedência: parâmetro > userOpts > config, com `""` caindo para o próximo.
    let param_style = opts.style.filter(|s| !s.is_empty());
    let user_style = user
        .map(|u| u.stream_name_style.as_str())
        .filter(|s| !s.is_empty());
    let effective_style = param_style
        .or(user_style)
        .unwrap_or_else(|| config.stream_name_style.as_str());
    let is_full = effective_style == "full";

    let effective_show_source = match opts.show_source {
        Some(value) => value,
        None => user
            .map(|u| u.stream_name_show_source)
            .unwrap_or(config.stream_name_show_source),
    };

    // Chip DUAL só com prova PT: Dual Audio YTS sem PT não pode parecer dublado.
    let dual_has_pt_proof = opts.is_br || looks_pt_br(title);
    let audio = opts.audio.unwrap_or("");
    let audio_chip: &str = if audio == "Dual" && !dual_has_pt_proof {
        ""
    } else {
        compact_audio(audio)
    };

    let quality_chip = opts.quality.and_then(|q| {
        if q == UNKNOWN_QUALITY {
            None
        } else if q == "2160p" {
            Some("4K")
        } else {
            Some(q)
        }
    });

    let details = join_nonempty(
        &[
            opt_text(quality_chip),
            opt_text(non_empty(opts.edition)),
            opt_text(non_empty(opts.source)),
            opt_text(non_empty(Some(audio_chip))),
            if opts.is_br {
                JsText::from_str("BR")
            } else {
                JsText::default()
            },
        ],
        " ",
    );

    let tracker_chip = if effective_show_source {
        compact_tracker(opts.tracker.unwrap_or(""))
    } else {
        JsText::default()
    };
    let stats = join_nonempty(&[details.clone(), tracker_chip, seeders_chip(opts)], " · ");

    // Fallback (Etapa 4): o 📦 precede até uma stat vazia, como no TS.
    let body = if opts.from_fallback {
        let mut out = JsText::from_str("📦 · ");
        out.push(&stats);
        out
    } else {
        stats
    };

    if is_full || details.is_empty() {
        join_nonempty(&[JsText::from_str(title), body], "\n")
    } else {
        body
    }
}

/// `👤 ${seeders}` (ou `👤 ~${seeders}` no fallback). Usa `Number(seeders)` para
/// decidir e `String(seeders)` CRU para exibir, como o template literal.
fn seeders_chip(opts: &StreamDisplayOptions) -> JsText {
    let count = opts.seeders.map_or(0.0, js_number);
    // `Number(seeders) > 0`: NaN (valor não numérico) cai como "sem semente".
    let has_seeders = count > 0.0;
    if !has_seeders {
        return if opts.from_fallback {
            JsText::from_str("👤 ~")
        } else {
            JsText::default()
        };
    }
    let raw = opts.seeders.map(js_to_string).unwrap_or_default();
    let mut out = JsText::from_str(if opts.from_fallback {
        "👤 ~"
    } else {
        "👤 "
    });
    out.push_str(&raw);
    out
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

fn opt_text(s: Option<&str>) -> JsText {
    s.map(JsText::from_str).unwrap_or_default()
}

/// `[partes].filter(Boolean).join(sep)` do TS.
fn join_nonempty(parts: &[JsText], sep: &str) -> JsText {
    let mut out = JsText::default();
    let mut first = true;
    for part in parts {
        if part.is_empty() {
            continue;
        }
        if !first {
            out.push_str(sep);
        }
        first = false;
        out.push(part);
    }
    out
}
