//! `Retry-After` do Mico — porte fiel de `retryAfterMs` (`src/providers/mico.ts`).
//!
//! O header pode vir em delta-segundos (`120`, `1.5`) ou data HTTP
//! (`Wed, 21 Oct 2026 07:28:00 GMT`). O Node tenta `Number(raw)` primeiro e só
//! então `Date.parse(raw)`; aqui a ordem e o sinal (nunca negativo) são os
//! mesmos. Datas RFC 1123/RFC 850/asctime são cobertas pelo `httpdate` — o
//! subconjunto que o `Retry-After` da RFC 7231 admite.

use std::time::UNIX_EPOCH;

/// `Retry-After` → milissegundos. `None` quando ausente/ilegível.
pub fn retry_after_ms(header: Option<&str>, now_ms: i64) -> Option<u64> {
    let raw = header?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(secs) = parse_js_number(raw) {
        if secs.is_finite() {
            // `Math.max(0, Math.round(secs * 1000))`; satura em u64 (o
            // `Infinity` do `Number` cai no ramo de data e vira `None`).
            let ms = (secs * 1000.0).round();
            if ms <= 0.0 {
                return Some(0);
            }
            return Some(ms.min(u64::MAX as f64) as u64);
        }
    }
    let date = httpdate::parse_http_date(raw).ok()?;
    let epoch_ms = date.duration_since(UNIX_EPOCH).ok()?.as_millis();
    let diff = epoch_ms as i128 - i128::from(now_ms);
    Some(diff.max(0) as u64)
}

/// `Number(raw)` do JS para os formatos que importam no header: decimal
/// (com sinal/expoente) e os literais `0x`/`0b`/`0o`. `Infinity`/`NaN` são
/// devolvidos como não finitos para o chamador cair no ramo de data.
fn parse_js_number(raw: &str) -> Option<f64> {
    let (negative, signed, body) = match raw.as_bytes().first() {
        Some(b'-') => (true, true, &raw[1..]),
        Some(b'+') => (false, true, &raw[1..]),
        _ => (false, false, raw),
    };
    if body.is_empty() {
        return None;
    }
    // Literais de base só valem SEM sinal no `Number` do JS (`+0x10` é NaN).
    let radix = if signed {
        None
    } else if let Some(rest) = strip_prefix_ci(body, "0x") {
        Some((16, rest))
    } else if let Some(rest) = strip_prefix_ci(body, "0b") {
        Some((2, rest))
    } else {
        strip_prefix_ci(body, "0o").map(|rest| (8, rest))
    };
    let Some((radix, digits)) = radix else {
        let value: f64 = body.parse().ok()?;
        return Some(if negative { -value } else { value });
    };
    if digits.is_empty() {
        return None;
    }
    let value = u128::from_str_radix(digits, radix).ok()? as f64;
    Some(if negative { -value } else { value })
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())
        .filter(|head| head.eq_ignore_ascii_case(prefix))
        .map(|_| &text[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Data fixa do RFC 1123; o `now_ms` é calculado a partir dela para o teste
    /// não depender do relógio.
    fn http_date_epoch(text: &str) -> i64 {
        let date = httpdate::parse_http_date(text).expect("data HTTP");
        date.duration_since(UNIX_EPOCH).expect("epoch").as_millis() as i64
    }

    #[test]
    fn segundos_inteiros_e_decimais() {
        assert_eq!(retry_after_ms(Some("120"), 0), Some(120_000));
        assert_eq!(retry_after_ms(Some(" 1.5 "), 0), Some(1_500));
        assert_eq!(retry_after_ms(Some("0"), 0), Some(0));
        assert_eq!(retry_after_ms(Some("-5"), 0), Some(0));
        assert_eq!(retry_after_ms(Some("+2"), 0), Some(2_000));
        assert_eq!(retry_after_ms(Some("1e2"), 0), Some(100_000));
        assert_eq!(retry_after_ms(Some("0x10"), 0), Some(16_000));
        assert_eq!(retry_after_ms(Some("0b101"), 0), Some(5_000));
        assert_eq!(retry_after_ms(Some("0o17"), 0), Some(15_000));
        assert_eq!(
            retry_after_ms(Some("+0x10"), 0),
            None,
            "Number('+0x10') é NaN no JS"
        );
    }

    #[test]
    fn data_http_vira_delta_a_partir_do_agora() {
        let text = "Wed, 21 Oct 2026 07:28:00 GMT";
        let epoch = http_date_epoch(text);
        assert_eq!(retry_after_ms(Some(text), epoch - 120_000), Some(120_000));
        assert_eq!(
            retry_after_ms(Some(text), epoch + 5_000),
            Some(0),
            "data no passado satura em zero, como o Math.max"
        );
    }

    #[test]
    fn ilegivel_ou_ausente_e_none() {
        assert_eq!(retry_after_ms(None, 0), None);
        assert_eq!(retry_after_ms(Some(""), 0), None);
        assert_eq!(retry_after_ms(Some("   "), 0), None);
        assert_eq!(retry_after_ms(Some("amanhã"), 0), None);
        assert_eq!(retry_after_ms(Some("1.2.3"), 0), None);
        assert_eq!(retry_after_ms(Some("Infinity"), 0), None);
    }
}
