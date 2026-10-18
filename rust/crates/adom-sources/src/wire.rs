//! Helpers do wire JSON do Cinemeta/TMDB. Tudo `pub(crate)`: o `Value` cru não
//! atravessa a fronteira pública do crate.
//!
//! As semânticas imitam o JS onde ele é frouxo de propósito: `Number.isInteger`
//! aceita número inteiro ou string numérica, `String(...).slice(0, 4)` corta em
//! 4 caracteres e `Date.parse("YYYY-MM-DD")` é meia-noite UTC.

use serde_json::Value;

/// `typeof v === 'string' && v` (string vazia é falsy no JS).
pub(crate) fn nonempty_str(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

/// `String(v).trim() || null` do TS para títulos localizados.
pub(crate) fn trimmed_title(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `Number(v)` quando o resultado é inteiro (`Number.isInteger`). Aceita string
/// numérica (`Number("1")`) e número inteiro; recusa NaN/Infinity/fração.
pub(crate) fn as_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                return Some(int);
            }
            let float = number.as_f64()?;
            integral_i64(float)
        }
        Value::String(text) => integral_i64(text.trim().parse::<f64>().ok()?),
        _ => None,
    }
}

fn integral_i64(float: f64) -> Option<i64> {
    if float.is_finite()
        && float.fract() == 0.0
        && float >= i64::MIN as f64
        && float <= i64::MAX as f64
    {
        Some(float as i64)
    } else {
        None
    }
}

/// `v.year || ...`: texto ou número; vazio não conta.
pub(crate) fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
        _ => None,
    }
}

/// `Date.parse("YYYY-MM-DD")` do JS: meia-noite UTC. O TMDB publica data pura;
/// quando vier sufixo (`T00:00:00.000Z`) os 10 primeiros caracteres bastam.
pub(crate) fn parse_iso_date_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: u32 = text.get(5..7)?.parse().ok()?;
    let day: u32 = text.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400_000)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Dias desde 1970-01-01 (algoritmo civil de Howard Hinnant), prolepse gregoriana
/// — o mesmo calendário do `Date` do JS.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i64;
    let day = day as i64;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
