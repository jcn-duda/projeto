use regex::Regex;
use std::sync::OnceLock;

fn days_from_civil(y: i64, m: u64, d: u64) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + (doe as i64) - 719468
}

/// Tenta interpretar uma string de data no formato ISO-8601 estrito.
fn parse_iso_timestamp_strict(s: &str) -> Option<i64> {
    static ISO_DATE_RE: OnceLock<Regex> = OnceLock::new();
    let re = ISO_DATE_RE.get_or_init(|| {
        Regex::new(r"^(?i)(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(?:Z|([+-]\d{2})(?::?(\d{2}))?)?)?$").unwrap()
    });
    let caps = re.captures(s)?;
    let year: i64 = caps.get(1)?.as_str().parse().ok()?;
    let month: u64 = caps.get(2)?.as_str().parse().ok()?;
    let day: u64 = caps.get(3)?.as_str().parse().ok()?;

    if year < 1000 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let hour: i64 = caps.get(4).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
    let minute: i64 = caps.get(5).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
    let second: i64 = caps.get(6).map_or(Ok(0), |m| m.as_str().parse()).ok()?;

    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=60).contains(&second) {
        return None;
    }

    let ms: i64 = if let Some(m) = caps.get(7) {
        let frac_str = m.as_str();
        if frac_str.len() >= 3 {
            frac_str[..3].parse().ok()?
        } else if frac_str.len() == 2 {
            frac_str.parse::<i64>().ok()? * 10
        } else if frac_str.len() == 1 {
            frac_str.parse::<i64>().ok()? * 100
        } else {
            0
        }
    } else {
        0
    };

    let offset_seconds: i64 = if let Some(m) = caps.get(8) {
        let tz_h: i64 = m.as_str().parse().ok()?;
        let tz_m: i64 = caps.get(9).map_or(Ok(0), |m| m.as_str().parse()).ok()?;
        if !(0..=59).contains(&tz_m) {
            return None;
        }
        if tz_h >= 0 {
            tz_h * 3600 + tz_m * 60
        } else {
            tz_h * 3600 - tz_m * 60
        }
    } else {
        0
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_seconds;
    Some(seconds * 1000 + ms)
}

/// Parser leniente no estilo `Date.parse` do JavaScript: extrai ano/mês/dia/hora de strings
/// mesmo malformadas ("corrupt-2026" → ano 2026). Retorna `None` se não conseguir extrair
/// nenhum componente de data válido.
fn parse_lenient_timestamp(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    // 1. Tenta ISO estrito primeiro
    if let Some(ts) = parse_iso_timestamp_strict(s) {
        return Some(ts);
    }

    // 2. Tenta extrair ano de 4 dígitos (1900-2100) de qualquer posição
    static YEAR_RE: OnceLock<Regex> = OnceLock::new();
    let re = YEAR_RE.get_or_init(|| Regex::new(r"(19|20)\d{2}").unwrap());
    if let Some(m) = re.find(s) {
        let year: i64 = m.as_str().parse().ok()?;
        // Assume 1º de janeiro 00:00:00 UTC para ano solto
        let days = days_from_civil(year, 1, 1);
        return Some(days * 86400 * 1000);
    }

    None
}

/// Maior lastmod (ISO) da leva descoberta; `""` quando nenhum é legível.
/// Comportamento igual ao TS `Date.parse`: datas válidas vencem; com ilegíveis misturados,
/// mantém o primeiro string não vazia ou o melhor timestamp válido se houver.
pub fn max_lastmod<S: AsRef<str>>(urls: &[S]) -> String {
    let mut best: Option<&str> = None;
    let mut best_time: Option<i64> = None;

    for entry in urls {
        let s = entry.as_ref();
        if s.is_empty() {
            continue;
        }
        if let Some(time) = parse_lenient_timestamp(s) {
            match best_time {
                Some(current_best) => {
                    if time > current_best {
                        best_time = Some(time);
                        best = Some(s);
                    }
                }
                None => {
                    best_time = Some(time);
                    best = Some(s);
                }
            }
        } else if best_time.is_none() && best.is_none() {
            best = Some(s);
        }
    }

    best.unwrap_or("").to_string()
}
