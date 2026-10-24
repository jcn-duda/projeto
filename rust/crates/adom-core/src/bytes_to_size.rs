//! Porte de `bytesToSize` (`src/utils/title-normalization.ts`).
//!
//! O `toFixed` do JS não é o `format!` do Rust. Dois desvios medidos contra o
//! Node v22: o meio exato desempata para longe de zero (`0.5` → `"1"`, `2.5` →
//! `"3"`; o `format!("{:.0}")` desempata para o par e devolve `"0"` e `"2"`), e
//! valor ≥ `1e21` cai no `ToString` científico (`"1e+21"`), não num decimal de
//! duas casas. O literal `1.005` também cabe aqui: o f64 é um pouco menor que
//! 1.005, então as duas casas são `"1.00"`, não `"1.01"`.

const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

/// Tamanho legível no mesmo texto do JS, ou `None` quando o número não é um
/// tamanho (não finito ou ≤ 0). A unidade para em TB, como o laço do TS.
pub fn bytes_to_size(bytes: f64) -> Option<String> {
    if !bytes.is_finite() || bytes <= 0.0 {
        return None;
    }
    let mut index = 0;
    let mut value = bytes;
    while value >= 1024.0 && index < UNITS.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    let digits = if index == 0 { 0 } else { 2 };
    Some(format!("{} {}", js_to_fixed(value, digits), UNITS[index]))
}

/// `Number.prototype.toFixed` para um f64 finito ≥ 0 e `digits` 0 ou 2
/// (o que `bytes_to_size` pede). Acima de `1e21` o spec devolve `ToString`.
fn js_to_fixed(value: f64, digits: u32) -> String {
    debug_assert!(value.is_finite() && value >= 0.0);
    debug_assert!(digits <= 2);
    if value >= 1e21 {
        return js_exponential(value);
    }
    let (mant, exp) = f64_mantissa_exp(value);
    let rounded = round_half_away(mant, exp, digits);
    format_fixed(rounded, digits)
}

/// `ToString` do número grande: o `{:e}` do Rust já é o decimal curto, mas o
/// JS sempre escreve o sinal do expoente (`1e+21`, não `1e21`).
fn js_exponential(value: f64) -> String {
    let sci = format!("{value:e}");
    let (mant, exp) = sci.split_once('e').expect("formato científico do f64");
    let exponent: i64 = exp.parse().expect("expoente numérico");
    format!(
        "{mant}e{}{}",
        if exponent < 0 { '-' } else { '+' },
        exponent.unsigned_abs()
    )
}

/// `value = mantissa * 2^exp`, com a mantissa inteira (subnormal incluso).
fn f64_mantissa_exp(value: f64) -> (u64, i32) {
    let bits = value.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1_u64 << 52) - 1);
    if biased == 0 {
        (frac, -1074)
    } else {
        (frac | (1_u64 << 52), biased - 1023 - 52)
    }
}

/// Inteiro mais próximo de `mant * 2^exp * 10^digits`. No empate, o maior
/// (half away from zero — o valor aqui já é ≥ 0).
fn round_half_away(mant: u64, exp: i32, digits: u32) -> u128 {
    let mut numer = u128::from(mant);
    for _ in 0..digits {
        numer *= 5;
    }
    let power = exp + digits as i32;
    if power >= 0 {
        return numer << power;
    }
    let shift = (-power) as u32;
    // Com 0 ou 2 casas, a mantissa cabe abaixo de 2^58. Shift ≥ 64 deixa o
    // número tão pequeno que fica abaixo do meio e arredonda para 0.
    if shift >= 64 {
        return 0;
    }
    let half = 1_u128 << (shift - 1);
    let frac = numer & ((1_u128 << shift) - 1);
    let quot = numer >> shift;
    if frac >= half {
        quot + 1
    } else {
        quot
    }
}

/// Dígitos de `n / 10^digits`, com zeros à esquerda se faltar a parte inteira
/// (`5` com 2 casas → `"0.05"`). Casa zero não leva ponto.
fn format_fixed(n: u128, digits: u32) -> String {
    if digits == 0 {
        return n.to_string();
    }
    let mut text = n.to_string();
    let min_len = digits as usize + 1;
    if text.len() < min_len {
        let mut padded = String::with_capacity(min_len);
        for _ in 0..(min_len - text.len()) {
            padded.push('0');
        }
        padded.push_str(&text);
        text = padded;
    }
    let split = text.len() - digits as usize;
    format!("{}.{}", &text[..split], &text[split..])
}
