//! Scanners à mão para os três padrões de `parse_title_season_episode` que
//! casam em quase todo título (marcador `s01e02`, `s01` solto e `e05` solto).
//! No `fancy_regex` cada um custa ~1 µs por título (laço de retrocesso com
//! lookbehind); aqui é uma varredura de bytes.
//!
//! Cada função reproduz o casamento leftmost-first do regex original, inclusive
//! o retrocesso; o teste `scanner_igual_ao_regex` compara as duas formas sobre
//! o golden e sobre texto aleatório.

/// `[a-z0-9]` dos lookarounds. Byte de continuação UTF-8 (≥ 0x80) nunca casa,
/// então olhar o byte vizinho equivale a olhar o char vizinho.
fn is_az09(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit()
}

/// Comprimento em bytes do char de `__SP__` (o `\s` do ECMAScript) em `at`.
fn space_len(text: &str, at: usize) -> usize {
    match text[at..].chars().next() {
        Some(
            c @ ('\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
            | '\u{3000}' | '\u{feff}'),
        ) => c.len_utf8(),
        _ => 0,
    }
}

fn digits_end(b: &[u8], from: usize) -> usize {
    let mut end = from;
    while end < b.len() && b[end].is_ascii_digit() {
        end += 1;
    }
    end
}

/// `(?<![a-z0-9])L([0-9]{1,max})(?![a-z0-9])`: o grupo de dígitos de cada
/// casamento. Mais de `max` dígitos nunca casa (qualquer corte deixa um dígito
/// na frente do lookahead); letra ou dígito depois também não.
pub(crate) fn letter_number(t: &str, letter: u8, max: usize) -> Vec<&str> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == letter && (i == 0 || !is_az09(b[i - 1])) {
            let end = digits_end(b, i + 1);
            let count = end - (i + 1);
            if (1..=max).contains(&count) && (end == b.len() || !is_az09(b[end])) {
                out.push(&t[i + 1..end]);
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Uma repetição de `[SP]?e[SP]?[0-9]{1,4}` a partir de `at`; fim ou `None`.
fn episode_step(t: &str, at: usize) -> Option<usize> {
    let b = t.as_bytes();
    // Espaço opcional guloso; sem `e` depois dele, pular o espaço também falha
    // (o char em `at` é o espaço, não `e`).
    let e_at = at + space_len(t, at);
    if b.get(e_at) != Some(&b'e') {
        return None;
    }
    let after_e = e_at + 1;
    // Espaço opcional antes dos dígitos: sem dígito depois dele, voltar atrás
    // deixa o espaço na frente dos dígitos e também falha.
    let from = if after_e < b.len() { after_e + space_len(t, after_e) } else { after_e };
    let end = digits_end(b, from);
    if end == from {
        return None;
    }
    Some(from + (end - from).min(4))
}

/// `(?<![a-z0-9])s([0-9]{1,2})((?:[SP]?e[SP]?[0-9]{1,4})+)`: pares (temporada,
/// trecho dos episódios). Nada vem depois da repetição, então a primeira
/// leitura gulosa é a que o regex devolve.
pub(crate) fn season_episodes(t: &str) -> Vec<(&str, &str)> {
    let b = t.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b's' && (i == 0 || !is_az09(b[i - 1])) {
            let season_end = digits_end(b, i + 1);
            // Três dígitos ou mais: qualquer corte deixa um dígito onde a
            // repetição precisa de espaço ou `e`.
            if (1..=2).contains(&(season_end - (i + 1))) {
                let mut end = season_end;
                while let Some(next) = episode_step(t, end) {
                    end = next;
                }
                if end > season_end {
                    out.push((&t[i + 1..season_end], &t[season_end..end]));
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::episode_parse_gate::GatedRegex;
    use crate::title_normalization::normalize_title;

    const SP: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

    fn compiled(pattern: &str) -> GatedRegex {
        GatedRegex::new(&pattern.replace("__SP__", SP))
    }

    fn caps(re: &GatedRegex, text: &str) -> Vec<Vec<String>> {
        re.fancy
            .captures_iter(text)
            .map(|c| {
                let c = c.expect("executa");
                (1..c.len()).map(|i| c.get(i).map_or("", |m| m.as_str()).to_string()).collect()
            })
            .collect()
    }

    struct Refs([GatedRegex; 3]);

    fn refs() -> Refs {
        Refs([
            compiled(r"(?<![a-z0-9])s([0-9]{1,2})(?![a-z0-9])"),
            compiled(r"(?<![a-z0-9])e([0-9]{1,3})(?![a-z0-9])"),
            compiled(r"(?<![a-z0-9])s([0-9]{1,2})((?:[__SP__]?e[__SP__]?[0-9]{1,4})+)"),
        ])
    }

    fn check(refs: &Refs, text: &str) {
        let s = caps(&refs.0[0], text);
        let got: Vec<Vec<String>> = letter_number(text, b's', 2).iter().map(|d| vec![d.to_string()]).collect();
        assert_eq!(got, s, "s solto: {text:?}");
        let e = caps(&refs.0[1], text);
        let got: Vec<Vec<String>> = letter_number(text, b'e', 3).iter().map(|d| vec![d.to_string()]).collect();
        assert_eq!(got, e, "e solto: {text:?}");
        let se = caps(&refs.0[2], text);
        let got: Vec<Vec<String>> = season_episodes(text)
            .iter()
            .map(|(a, b)| vec![a.to_string(), b.to_string()])
            .collect();
        assert_eq!(got, se, "sXXeYY: {text:?}");
    }

    #[test]
    fn scanner_igual_ao_regex() {
        let refs = refs();
        for case in [
            "show s01e02", "s01 e02 e03", "s1e1e2e3", "s123e4", "s01e12345", "xs01e02",
            "s01 x", "s01e", "s01 e 05", "s01\u{a0}e\u{a0}05", "és01e02", "s01é", "e5 e10 e100 e1000",
            "s01s02", "s1", "s", "e", "", "s01e02s03e04", "1s01", "s01 ", "s0 1",
        ] {
            check(&refs, case);
        }
        let golden = concat!(env!("CARGO_MANIFEST_DIR"), "/../../golden/title-normalization.jsonl");
        for line in std::fs::read_to_string(golden).expect("golden").lines() {
            let v: serde_json::Value = serde_json::from_str(line).expect("jsonl");
            if let Some(input) = v["input"].as_str() {
                check(&refs, &normalize_title(input));
                check(&refs, input);
            }
        }
        // Texto aleatório sobre o alfabeto que importa (LCG fixo: reproduzível).
        let alphabet = ['s', 'e', '0', '1', '2', '9', ' ', 'x', 'a', '\u{a0}', 'é', '-'];
        let mut seed: u64 = 0x5eed;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        for _ in 0..50_000 {
            let len = next() % 24 + 1;
            let text: String = (0..len).map(|_| alphabet[next() % alphabet.len()]).collect();
            check(&refs, &text);
        }
    }
}
