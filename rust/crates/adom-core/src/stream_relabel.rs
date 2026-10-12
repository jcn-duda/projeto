//! Porte de `relabel` (`src/utils/stream-relabel.ts`).
//!
//! Remontagem do nome do vencedor do dedupe: a linha BR herda do perdedor o
//! título scene (áudio, fonte, corte) sem perder o próprio post. A composição
//! reusa o porte já feito — `audio_from_title` (áudio), `source_from_title`/
//! `edition_from_title` (fonte/corte) e `stream_display_name` (a coluna).
//!
//! # Texto astral e surrogate órfão
//!
//! O `name` e o `_tracker` viajam como [`JsText`]: podem carregar unidade
//! surrogate órfã (o oráculo congela `\ud800` em `expected`). O
//! `stream_display_name` recebe `&str` — o modelo do Rust não representa o
//! órfão — então aqui cada unidade órfã é trocada, na ENTRADA, por um BMP da
//! Área de Uso Privado e restaurada na unidade órfã na SAÍDA. O placeholder é
//! escolhido sem colisão com o texto de entrada e é, como o órfão, não-letra,
//! não-espaço, sem caixa e de uma única unidade UTF-16: as réguas `&str`
//! (fronteira `\b`, classe `\s`, corte por unidade, `to_uppercase`) o tratam
//! igual ao órfão. Nada é descartado nem virou U+FFFD.
//!
//! # Sem coerção de não-string
//!
//! O contrato é tipado: `name`/`_tracker`/`_magnetDn` são `JsText`; `_seeders`
//! e os selos de foto viajam como `Value` só porque o `stream_display_name` já
//! tem essa assinatura (o `Number`/`String` do chip é dele). `relabel` não
//! converte campo não-string para texto.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::audio_presentation::audio_from_title;
use crate::js_text::{js_number, js_number_of_str};
use crate::js_text16::JsText;
use crate::matching_vocabulary::JS_SPACE;
use crate::release_labels::{edition_from_title, source_from_title};
use crate::stream_display::{
    stream_display_name, StreamDisplayConfig, StreamDisplayOptions, UserDisplayOptions,
};

/// Campos do stream que `relabel` lê. Herdado do TS `stream: any`, mas tipado:
/// o que é texto astral/órfão é [`JsText`], o resto mantém o tipo do dado.
#[derive(Debug, Clone)]
pub struct RelabelStream<'a> {
    pub name: &'a JsText,
    pub seeders: Option<&'a Value>,
    pub quality: Option<&'a str>,
    pub tracker: Option<&'a JsText>,
    pub magnet_dn: Option<&'a JsText>,
    pub from_fallback: Option<&'a Value>,
    pub from_snapshot: Option<&'a Value>,
}

/// O segundo argumento do TS: `{ isBr, dubbedFrom }`.
#[derive(Debug, Clone)]
pub struct RelabelOptions<'a> {
    pub is_br: bool,
    pub dubbed_from: Option<&'a JsText>,
}

/// Reescreve a linha do vencedor BR quando o perdedor traz metadados melhores.
///
/// Origem e áudio pertencem ao post vencedor; só o post BR aproveita o título
/// scene do perdedor (`dubbed_from`), que costuma ser esparso nesses campos.
/// Fonte e corte saem do mesmo texto, pela mesma razão do áudio.
pub fn relabel(
    stream: &RelabelStream,
    options: &RelabelOptions,
    user: Option<&UserDisplayOptions>,
    config: &StreamDisplayConfig,
) -> JsText {
    let (title, stats) = split_name(stream.name);
    let empty = JsText::default();
    let magnet_text = stream.magnet_dn.unwrap_or(&empty);
    let tracker_text = stream.tracker.unwrap_or(&empty);
    // `isBr ? dubbedFrom : ''` — sem dublado, o perdedor não é fonte de nada.
    let borrowed_text = if options.is_br {
        options.dubbed_from.unwrap_or(&empty)
    } else {
        &empty
    };

    let codec = OrphanCodec::new(&[&title, &stats, magnet_text, tracker_text, borrowed_text]);
    let title_str = codec.stand_in(&title);
    let stats_str = codec.stand_in(&stats);
    let magnet_str = codec.stand_in(magnet_text);
    let borrowed_str = if options.is_br {
        codec.stand_in(borrowed_text)
    } else {
        String::new()
    };
    let tracker_str = codec.stand_in(tracker_text);

    let seeders = seeders_value(seeders_of(&stats_str, stream.seeders));

    // Mesma precedência de `search-names`: magnet CAM vence título limpo.
    let audio_title = audio_from_title(&title_str);
    let audio = if audio_title.is_empty() {
        audio_from_title(&borrowed_str)
    } else {
        audio_title
    };
    let title_source = source_from_title(&title_str);
    let magnet_source = source_from_title(&magnet_str);
    let source = if magnet_source == "CAM" && title_source != "CAM" {
        "CAM"
    } else if !title_source.is_empty() {
        title_source
    } else if !magnet_source.is_empty() {
        magnet_source
    } else {
        source_from_title(&borrowed_str)
    };
    let edition_title = edition_from_title(&title_str);
    let edition = if edition_title.is_empty() {
        edition_from_title(&borrowed_str)
    } else {
        edition_title
    };
    // Remontar o nome não pode apagar o selo 📦/~N de quem é foto salva.
    let from_fallback = truthy_opt(stream.from_fallback) || truthy_opt(stream.from_snapshot);

    let display = StreamDisplayOptions {
        title: Some(&title_str),
        quality: stream.quality,
        audio: Some(audio),
        source: Some(source),
        edition: Some(edition),
        tracker: Some(&tracker_str),
        is_br: options.is_br,
        seeders: Some(&seeders),
        from_fallback,
        style: None,
        show_source: None,
    };
    codec.restore(&stream_display_name(&display, user, config))
}

/// `String(stream.name || '').split('\n')` com desestruturação `[title, stats]`:
/// só o primeiro e o segundo segmento contam.
fn split_name(name: &JsText) -> (JsText, JsText) {
    let units = name.as_units();
    let (title, rest) = match units.iter().position(|&u| u == 0x0A) {
        Some(i) => (&units[..i], &units[i + 1..]),
        None => (units, &[][..]),
    };
    let stats = match rest.iter().position(|&u| u == 0x0A) {
        Some(i) => &rest[..i],
        None => rest,
    };
    (
        JsText::from_units(title.to_vec()),
        JsText::from_units(stats.to_vec()),
    )
}

// ── seeders ──────────────────────────────────────────────────────────────

/// `/👤\s*(\d+)/` do TS: `\s` é a classe JS_SPACE explícita e `\d` é `[0-9]`.
fn seeders_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!("👤{S}*([0-9]+)", S = JS_SPACE)).expect("regex de seeders compila")
    })
}

/// `Number(String(stats).match(/👤\s*(\d+)/)?.[1] || stream._seeders || 0)`.
fn seeders_of(stats: &str, fallback: Option<&Value>) -> f64 {
    if let Some(caps) = seeders_re().captures(stats) {
        if let Some(m) = caps.get(1) {
            return js_number_of_str(m.as_str());
        }
    }
    fallback.map(js_number).unwrap_or(0.0)
}

/// `Value` que reproduz o `Number`/`String` do JS para o chip de semente: o
/// número computado (não o `_seeders` cru) é o que o template exibe.
fn seeders_value(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n <= i64::MAX as f64 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// `Boolean(v)` do JS.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn truthy_opt(v: Option<&Value>) -> bool {
    v.is_some_and(truthy)
}

// ── surrogate órfão ↔ placeholder BMP ───────────────────────────────────

fn is_high(u: u16) -> bool {
    (0xD800..=0xDBFF).contains(&u)
}

fn is_low(u: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&u)
}

/// Bijeta cada unidade surrogate órfã das entradas para um BMP da PUA livre no
/// texto e desfaz na saída. O órfão só existe em `name`/`_tracker` (e no título
/// herdado); as demais colunas já são `&str` puros.
struct OrphanCodec {
    /// placeholder -> unidade órfã
    to_orphan: Vec<(char, u16)>,
    /// unidade órfã -> placeholder
    to_placeholder: Vec<(u16, char)>,
}

impl OrphanCodec {
    fn new(texts: &[&JsText]) -> Self {
        let mut used: Vec<u16> = Vec::new();
        for text in texts {
            used.extend_from_slice(text.as_units());
        }
        let mut to_orphan = Vec::new();
        let mut to_placeholder = Vec::new();
        let mut next = 0xE000u32;
        for text in texts {
            let units = text.as_units();
            let mut i = 0;
            while i < units.len() {
                if is_high(units[i]) && i + 1 < units.len() && is_low(units[i + 1]) {
                    i += 2;
                    continue;
                }
                if is_high(units[i]) || is_low(units[i]) {
                    let orphan = units[i];
                    if !to_placeholder.iter().any(|(k, _)| *k == orphan) {
                        while next <= 0xF8FF && used.contains(&(next as u16)) {
                            next += 1;
                        }
                        let placeholder = char::from_u32(next).expect("PUA é escalar");
                        used.push(next as u16);
                        next += 1;
                        to_placeholder.push((orphan, placeholder));
                        to_orphan.push((placeholder, orphan));
                    }
                }
                i += 1;
            }
        }
        Self {
            to_orphan,
            to_placeholder,
        }
    }

    fn placeholder(&self, orphan: u16) -> Option<char> {
        self.to_placeholder
            .iter()
            .find(|(k, _)| *k == orphan)
            .map(|(_, c)| *c)
    }

    /// `JsText` -> `&str` válido, com o órfão trocado pelo placeholder.
    fn stand_in(&self, text: &JsText) -> String {
        let units = text.as_units();
        let mut out = String::new();
        let mut i = 0;
        while i < units.len() {
            if is_high(units[i]) && i + 1 < units.len() && is_low(units[i + 1]) {
                let cp =
                    0x1_0000 + ((units[i] as u32 - 0xD800) << 10) + (units[i + 1] as u32 - 0xDC00);
                if let Some(c) = char::from_u32(cp) {
                    out.push(c);
                }
                i += 2;
                continue;
            }
            match self.placeholder(units[i]) {
                Some(placeholder) => out.push(placeholder),
                None => {
                    if let Some(c) = char::from_u32(units[i] as u32) {
                        out.push(c);
                    }
                }
            }
            i += 1;
        }
        out
    }

    /// Restaura o placeholder na unidade órfã no `JsText` de saída.
    fn restore(&self, text: &JsText) -> JsText {
        JsText::from_units(
            text.as_units()
                .iter()
                .map(|&u| {
                    self.to_orphan
                        .iter()
                        .find(|(p, _)| *p as u32 == u as u32)
                        .map(|(_, o)| *o)
                        .unwrap_or(u)
                })
                .collect(),
        )
    }
}
