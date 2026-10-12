//! Porte de `src/utils/crawl-store-rules.ts` — regras PURAS + codec do estado
//! da raspagem (`crawl.db`), sem I/O. É a fatia que as duas engines (SQLite e
//! memória) compartilham: a MESMA decisão de upsert e a MESMA marcação de
//! resultado, para não haver dois códigos parecidos divergindo.
//!
//! Semântica do upsert idempotente (o coração da incremental):
//! - URL nova → nasce `pending`;
//! - `lastmod` IGUAL → `unchanged`: a linha não é tocada, mas o HOST gravado
//!   acompanha (a identidade é o CAMINHO, então a redescoberta no domínio novo
//!   atualiza a `url` lida pelo motor);
//! - `lastmod` NOVO → `refreshed`: reprocessa do zero; aqui a `url` do ENTRY é
//!   IGNORADA de propósito — o spread herda a `url` antiga da linha, e só
//!   `lastmod/kind/status/.../addedAt` são reescritos.
//!
//! As pegadinhas de JS que o golden exercita:
//! - `?? ''` (nullish) difere de `|| ''` (falsy): `result.releases ?? 0` mantém
//!   o `0` explícito, enquanto `result.error || 'erro'` troca `''`/`0` por
//!   `'erro'`;
//! - `p.dry === 1` é igualdade ESTRITA de número: `true` e `"1"` não valem;
//! - `p.card && ...` é TRUTHINESS (objeto/array), não `typeof`;
//! - `Number(x) || 0` colapsa `NaN`/`0`; `parseProgress` PRESERVA negativos e
//!   floats em `totalCards`, já `renderProgress` faz `trunc`+`max(0,...)`;
//! - a saída JSON usa a ordem de inserção do `JSON.stringify` do Node.
//!
//! [`progress`] tem o codec do progresso de série (parse/render/avanço);
//! [`row`] o upsert e a marcação de resultado; [`codec`] a linha/URL/status e
//! os contadores.

use serde_json::{Number, Value};

use crate::js_text::{js_number, js_to_string};

// Os `#[path]` explícitos ancoram os submódulos em `src/crawl_store_rules/`
// tanto quando o módulo é declarado em `lib.rs` quanto quando é incluído por
// `#[path]` num teste (que muda a raiz de resolução dos filhos).
#[path = "crawl_store_rules/codec.rs"]
mod codec;
#[path = "crawl_store_rules/progress.rs"]
mod progress;
#[path = "crawl_store_rules/row.rs"]
mod row;

pub use codec::{empty_counters, parse_status, parse_url_row, render_url};
pub use progress::{parse_progress, progress_advanced, render_progress, with_dry_flag};
pub use row::{apply_result, decide_upsert};

/// Teto do backoff exponencial: 6h. Erro persistente não pode virar polling
/// eterno, mas também não pode dormir mais que o ciclo incremental.
pub const ERROR_BACKOFF_CAP_MS: f64 = 21_600_000.0;

/// Dormência de URL cujas tentativas esgotaram (`tries >= maxTries`): um dia.
/// Não é apagada — o "Reprocessar erros" do painel a reenfileira.
pub const CRAWL_GIVE_UP_MS: f64 = 86_400_000.0;

/// Backoff default quando o motor não declara base (erro transitório: 1 min).
pub const DEFAULT_RETRY_BASE_MS: f64 = 60_000.0;

/// Piso do backoff: base menor que 1s é martelada de requisição.
const MIN_RETRY_BASE_MS: f64 = 1_000.0;

/// Ordem FIXA das colunas de `crawl_url`. `url_key` é o caminho (identidade da
/// linha) e `url` é o valor lido pelo motor, sempre com o host vigente.
pub const URL_COLUMNS: [&str; 14] = [
    "site",
    "url",
    "url_key",
    "lastmod",
    "kind",
    "status",
    "imdb",
    "tries",
    "next_at",
    "checked_at",
    "releases",
    "error",
    "progress",
    "added_at",
];

/// `errorBackoffMs(baseMs, tries)`: `min(max(1s, base) * 2^max(0,tries-1), 6h)`.
/// `tries` é o contador JÁ incrementado da tentativa que falhou (1 = 1ª falha).
/// `baseMs` é coagido por `Number` do JS (string numérica, `null` → 0) e nunca
/// escapa do piso de 1s.
pub fn error_backoff_ms(base_ms: &Value, tries: &Value) -> f64 {
    let base = js_max(MIN_RETRY_BASE_MS, js_number(base_ms));
    let exp = js_max(0.0, js_number(tries) - 1.0);
    js_min(base * 2f64.powf(exp), ERROR_BACKOFF_CAP_MS)
}

/// `Math.max` do JS (propaga NaN, ao contrário do `f64::max` do Rust).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a >= b {
        a
    } else {
        b
    }
}

/// `Math.min` do JS (propaga NaN).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a <= b {
        a
    } else {
        b
    }
}

/// `Math.max(0, Math.trunc(n))` para um `n` já não-NaN.
pub(super) fn trunc_max0(n: f64) -> f64 {
    let t = n.trunc();
    if t < 0.0 {
        0.0
    } else {
        t
    }
}

/// `Number(x) || 0`: colapsa `0`, `-0` e `NaN` (falsos do JS) em `0`.
pub(super) fn or_zero(n: f64) -> f64 {
    if n == 0.0 || n.is_nan() {
        0.0
    } else {
        n
    }
}

/// Valor JSON de um número JS. `NaN`/`Infinity` viram `null`, como no
/// `JSON.stringify` do Node.
pub(super) fn num(f: f64) -> Value {
    Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// Falsidade do JS sobre um valor JSON (`null`/`undefined`, `false`, `0`, `''`
/// são falsos; `[]` e `{}` são verdadeiros).
pub(super) fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_none_or(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(x || '')`: coage só quando o valor é verdadeiro; senão `''`.
pub(super) fn truthy_string(v: Option<&Value>) -> String {
    match v {
        Some(x) if js_truthy(x) => js_to_string(x),
        _ => String::new(),
    }
}

/// `arr.map(u => String(u || '')).filter(Boolean)` — coage cada item verdadeiro
/// e descarta os que viram string vazia (inclusive `[]`, truthy mas `''`).
/// Fora de array, devolve vazio.
pub(super) fn array_strings_filtered(opt: Option<&Value>) -> Vec<Value> {
    let Some(arr) = opt.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .map(|u| {
            if js_truthy(u) {
                js_to_string(u)
            } else {
                String::new()
            }
        })
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .collect()
}
