//! Plano do efeito de erro, lido do JSON plano do núcleo
//! (`adom_debrid::resolve_effects::resolve_effect`: `mark`, `unprotect`,
//! `invalidate`, `index`, `noteBlocked`).
//!
//! O núcleo é a régua; aqui só se obedece. Valor fora do vocabulário vira
//! "nada", igual ao `takeResolveEffect` do TS.

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Mark {
    Bad,
    Lie,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Invalidate {
    /// Só as listas desta obra.
    Obra,
    /// A lista inteira (bloqueio legal), com cooldown.
    Streams,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IndexMark {
    Missing,
    MissingSeason,
    Lied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct EffectPlan {
    pub mark: Option<Mark>,
    pub unprotect: bool,
    pub invalidate: Invalidate,
    pub index: Option<IndexMark>,
    pub note_blocked: bool,
}

impl EffectPlan {
    pub(super) fn from_value(value: &Value) -> Self {
        let note_blocked = value.get("noteBlocked").and_then(Value::as_bool) == Some(true);
        // Bloqueio legal (451) não é prova do magnet: o TS zerava o mark e a
        // proteção neste caso, e o mesmo vale aqui.
        let mark = if note_blocked {
            None
        } else {
            match value.get("mark").and_then(Value::as_str) {
                Some("bad") => Some(Mark::Bad),
                Some("lie") => Some(Mark::Lie),
                _ => None,
            }
        };
        let unprotect =
            !note_blocked && value.get("unprotect").and_then(Value::as_bool) == Some(true);
        let invalidate = match value.get("invalidate").and_then(Value::as_str) {
            Some("obra") => Invalidate::Obra,
            Some("streams") => Invalidate::Streams,
            _ => Invalidate::None,
        };
        let index = match value.get("index").and_then(Value::as_str) {
            Some("missing") => Some(IndexMark::Missing),
            Some("missing-season") => Some(IndexMark::MissingSeason),
            Some("lied") => Some(IndexMark::Lied),
            _ => None,
        };
        Self {
            mark,
            unprotect,
            invalidate,
            index,
            note_blocked,
        }
    }
}
