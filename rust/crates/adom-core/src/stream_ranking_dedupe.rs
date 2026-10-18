//! Porte de `dedupeByHash` (`src/utils/stream-ranking.ts`, linhas 70-170).
//!
//! Mesma release aparece em vários indexers: agrupa por `infoHash` (a chave é
//! a string CRUA, como no `Map` do TS — sem caixa normalizada) e funde cada
//! grupo num vencedor. Os tipos são os de [`crate::stream_ranking_types`],
//! compartilhados com a Parte 3 (`sortAndLimit`).
//!
//! Paridades ansiosas do porte:
//! - `Boolean(x)` do JS para os selos: `None`/`Some(false)` são falsy.
//! - `Number(x) || 0` para seeders e `a || b || 0` para tamanho: `NaN`/`0`/
//!   `undefined` são falsy no `||` — tamanho 0 do vencedor DELEGA ao perdedor.
//! - O corte do perdedor é registrado ANTES da fusão, com o estado DELE (o
//!   trace do TS recebe o objeto perdedor intacto).
//! - `relabel` só roda quando a qualidade mudou na fusão ou houve herança BR,
//!   com o config DEFAULT (o TS chama `relabel(merged, opts)` sem opts de
//!   usuário).
//! - `GENERIC_DUB` do TS usa lookahead; aqui é varredura explícita de
//!   separadores (`dub`/`dubbed` delimitados por espaço/`._-[]()`), com o
//!   conjunto do `\s` do ECMAScript no lugar da classe.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

use crate::audio_lang::names_foreign_dub_language;
use crate::audio_presentation::audio_from_title;
use crate::indexer_priority::{compare_indexer_priority, priority_map};
use crate::js_text16::JsText;
use crate::pt_audio_guards::{explicit_pt_audio, has_explicit_foreign_audio};
use crate::stream_display::StreamDisplayConfig;
use crate::stream_quotas_extra::UNKNOWN_QUALITY;
use crate::stream_ranking_types::{RankingStream, TraceDrop};
use crate::stream_relabel::{relabel, RelabelOptions, RelabelStream};

#[derive(Debug, Clone, Default)]
pub struct DedupeInput {
    pub streams: Vec<RankingStream>,
    pub indexer_priority: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct DedupeOutput {
    pub streams: Vec<RankingStream>,
    pub drops: Vec<TraceDrop>,
}

/// `Boolean(v)` do JS sobre um `Value` (campos livres do `extra`).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `Boolean(x)` do JS sobre um selo tipado: `None` é `undefined`.
fn bool_of(v: Option<bool>) -> bool {
    v.unwrap_or(false)
}

/// `(s._seeders || 0)` com `Number` aplicado na fronteira.
fn num_or_zero(v: Option<f64>) -> f64 {
    v.filter(|n| n.is_finite()).unwrap_or(0.0)
}

/// `a || b || 0`: só valor finito > 0 conta (NaN/0/undefined são falsy).
fn or_size(a: Option<f64>, b: Option<f64>) -> f64 {
    a.filter(|n| n.is_finite() && *n > 0.0)
        .or_else(|| b.filter(|n| n.is_finite() && *n > 0.0))
        .unwrap_or(0.0)
}

/// `a || b || ''` para strings (o `_magnetDn` do TS).
fn or_text<'a>(a: Option<&'a str>, b: Option<&'a str>) -> String {
    a.filter(|s| !s.is_empty())
        .or_else(|| b.filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string()
}

/// `String(x || '').split('\n')[0]` com o `||` do JS entre title e name.
fn title_line(s: &RankingStream) -> String {
    let title = s.title.clone().unwrap_or_default();
    if !title.is_empty() {
        return first_line(&title);
    }
    first_line(&s.name.clone().unwrap_or_default())
}

fn first_line(text: &str) -> String {
    text.split('\n').next().unwrap_or("").to_string()
}

/// O `\s` do ECMAScript (mesmo conjunto de `JS_SPACE`, em `char`).
const JS_SPACE_CHARS: &[char] = &[
    '\t', '\n', '\u{0B}', '\u{0C}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{2001}',
    '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}',
    '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
];

/// Separadores ANTES do token (o `(?:^|[\s._\-[(])` do TS).
fn dub_opens(c: char) -> bool {
    matches!(c, '.' | '_' | '-' | '[' | '(') || JS_SPACE_CHARS.contains(&c)
}

/// Separadores DEPOIS do token (o `(?=$|[\s._\-\])])` do TS).
fn dub_closes(c: Option<char>) -> bool {
    match c {
        None => true,
        Some(c) => matches!(c, '.' | '_' | '-' | ']' | ')') || JS_SPACE_CHARS.contains(&c),
    }
}

fn starts_with_ci(text: &[char], at: usize, word: &str) -> bool {
    let word: Vec<char> = word.chars().collect();
    text.len() - at >= word.len()
        && text[at..at + word.len()]
            .iter()
            .zip(&word)
            .all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()))
}

/// `GENERIC_DUB.test(title)`: token `dub`/`dubbed` (sem idioma) delimitado.
/// Sem lookahead: testa o sufixo alternativo explícito (`dubbed` primeiro,
/// porque `dub` é prefixo próprio dele).
pub fn is_generic_dub_token(title: &str) -> bool {
    let chars: Vec<char> = title.chars().collect();
    for i in 0..chars.len() {
        if i > 0 && !dub_opens(chars[i - 1]) {
            continue;
        }
        for word in ["dubbed", "dub"] {
            if starts_with_ci(&chars, i, word) && dub_closes(chars.get(i + word.len()).copied()) {
                return true;
            }
        }
    }
    false
}

/// A guarda mínima-OR-ampla do TS: `hasExplicitForeignAudio(t) ||
/// (!explicitPtAudio(t) && namesForeignDubLanguage(t))`.
fn foreign_dub(title: &str) -> bool {
    has_explicit_foreign_audio(title)
        || (!explicit_pt_audio(title) && names_foreign_dub_language(title))
}

/// Corte do perdedor no formato do `dropTrace` (sem o `id` posicional, que é
/// do trace e não do item).
fn trace_drop_of(s: &RankingStream) -> TraceDrop {
    // `raw._br ?? raw.isBr` (nullish): `Some(false)` presente vence.
    let br = s.br.unwrap_or_else(|| truthy(s.extra.get("isBr")));
    TraceDrop {
        reason: "dedupe".to_string(),
        label: title_line(s),
        br,
        dubbed: s.dubbed,
        quality: s.quality.clone().filter(|q| !q.is_empty()),
    }
}

/// O `relabel(merged, { isBr, dubbedFrom })` do TS, com config default.
fn relabel_merged(merged: &RankingStream, loser: &RankingStream) -> String {
    let name = JsText::from_str(merged.name.as_deref().unwrap_or(""));
    let tracker = JsText::from_str(merged.tracker.as_deref().unwrap_or(""));
    let magnet_dn = JsText::from_str(merged.magnet_dn.as_deref().unwrap_or(""));
    let dubbed_from = JsText::from_str(&first_line(loser.name.as_deref().unwrap_or("")));
    let seeders = merged
        .seeders
        .and_then(serde_json::Number::from_f64)
        .map(Value::Number);
    let stream = RelabelStream {
        name: &name,
        seeders: seeders.as_ref(),
        quality: merged.quality.as_deref(),
        tracker: Some(&tracker),
        magnet_dn: Some(&magnet_dn),
        from_fallback: merged.extra.get("_fromFallback"),
        from_snapshot: merged.extra.get("_fromSnapshot"),
    };
    let options = RelabelOptions {
        is_br: bool_of(merged.br),
        dubbed_from: Some(&dubbed_from),
    };
    // `String(JsText)` — o corpus não tem surrogate órfão (limitação
    // documentada em `stream_ranking_types`).
    String::from_utf16_lossy(relabel(&stream, &options, None, default_display_config()).as_units())
}

fn default_display_config() -> &'static StreamDisplayConfig {
    static CONFIG: OnceLock<StreamDisplayConfig> = OnceLock::new();
    CONFIG.get_or_init(StreamDisplayConfig::default)
}

/// Funde streams do mesmo hash e registra os perdedores. Ordem de saída =
/// ordem de 1ª ocorrência de cada hash (o `Map` do TS preserva inserção).
pub fn dedupe_by_hash(input: &DedupeInput) -> DedupeOutput {
    let ids: Vec<Option<&str>> = input
        .indexer_priority
        .iter()
        .map(|s| Some(s.as_str()))
        .collect();
    let ranks = priority_map(&ids);
    let mut best: Vec<RankingStream> = Vec::new();
    let mut index_of: HashMap<Option<String>, usize> = HashMap::new();
    let mut has_clean_winner: HashMap<Option<String>, bool> = HashMap::new();
    let mut drops: Vec<TraceDrop> = Vec::new();

    for s in &input.streams {
        let key = s.info_hash.clone();
        let Some(&i) = index_of.get(&key) else {
            index_of.insert(key.clone(), best.len());
            has_clean_winner.insert(key, !bool_of(s.lied));
            best.push(s.clone());
            continue;
        };
        let prev = best[i].clone();
        let s_clean = !bool_of(s.lied);
        let prev_clean = has_clean_winner.get(&key).copied().unwrap_or(false);
        let seed_diff = num_or_zero(s.seeders) - num_or_zero(prev.seeders);
        let s_dubbed = bool_of(s.dubbed);
        let prev_dubbed = bool_of(prev.dubbed);
        let s_claim = bool_of(s.dub_claim);
        let prev_claim = bool_of(prev.dub_claim);
        // Hash idêntico é a mesma release: release sem mentira vence (título e
        // metadados íntegros); depois seeders; no empate, áudio PT declarado;
        // por fim a prioridade do indexer.
        let take_new = if s_clean != prev_clean {
            s_clean
        } else if seed_diff > 0.0 {
            true
        } else if seed_diff < 0.0 {
            false
        } else if s_dubbed != prev_dubbed {
            s_dubbed
        } else if s_claim != prev_claim {
            s_claim
        } else {
            compare_indexer_priority(s.indexer.as_deref(), prev.indexer.as_deref(), &ranks) < 0
        };
        has_clean_winner.insert(key, s_clean || prev_clean);
        let (winner, loser) = if take_new { (s, &prev) } else { (&prev, s) };
        drops.push(trace_drop_of(loser));

        // Prioridade escolhe o rótulo, mas não degrada qualidade conhecida.
        let richer = if winner.quality.as_deref() == Some(UNKNOWN_QUALITY)
            && loser.quality.as_deref() != Some(UNKNOWN_QUALITY)
        {
            loser
        } else {
            winner
        };
        let is_lied = bool_of(winner.lied) || bool_of(loser.lied);
        let winner_title = title_line(winner);
        let loser_title = title_line(loser);
        let winner_audio = audio_from_title(&winner_title);
        // Espelho global vencendo post BR por seeders: herda a marca BR só
        // quando o PRÓPRIO título corrobora (Dual ou dub genérico) e nenhum
        // lado tem prova de mentira ou idioma estrangeiro.
        let corroborates = winner_audio == "Dual"
            || (winner_audio.is_empty() && is_generic_dub_token(&winner_title));
        let inherits_br = !is_lied
            && !bool_of(winner.br)
            && bool_of(loser.br)
            && (bool_of(loser.dub_claim) || bool_of(loser.dubbed))
            && corroborates
            && !foreign_dub(&winner_title)
            && !foreign_dub(&loser_title);

        let mut merged = winner.clone();
        let quality_changed = richer.quality != winner.quality;
        merged.quality = richer.quality.clone();
        merged.seeders = Some(num_or_zero(winner.seeders).max(num_or_zero(loser.seeders)));
        merged.size = Some(or_size(winner.size, loser.size));
        merged.bytes = Some(or_size(winner.bytes, loser.bytes));
        merged.behavior_hints = if truthy(richer.behavior_hints.as_ref()) {
            richer.behavior_hints.clone()
        } else {
            winner.behavior_hints.clone()
        };
        merged.br = Some(bool_of(winner.br) || inherits_br);
        // Herança de espelho é PROMESSA do post BR, não prova de arquivo.
        merged.dub_claim = Some(if is_lied {
            false
        } else {
            bool_of(winner.dub_claim) || inherits_br
        });
        merged.dubbed = Some(if is_lied {
            false
        } else {
            bool_of(winner.dubbed)
        });
        merged.tracker = winner.tracker.clone();
        merged.magnet_dn = Some(or_text(
            winner.magnet_dn.as_deref(),
            loser.magnet_dn.as_deref(),
        ));
        // Mesmo conteúdo: marca de pack e admissão sobrevivem de QUALQUER lado.
        merged.multi_work = Some(bool_of(winner.multi_work) || bool_of(loser.multi_work));
        merged.multi_work_admitted =
            Some(bool_of(winner.multi_work_admitted) || bool_of(loser.multi_work_admitted));
        merged.lied = Some(is_lied);
        if quality_changed || inherits_br {
            merged.name = Some(relabel_merged(&merged, loser));
        }
        best[i] = merged;
    }
    DedupeOutput {
        streams: best,
        drops,
    }
}

#[cfg(test)]
#[path = "stream_ranking_dedupe_tests.rs"]
mod tests;
