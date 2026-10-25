//! base64url sem padding (RFC 4648 §5) — o transporte do token `lc1`.
//!
//! O crate não tem crate de base64 e a dependência nova não se justifica por
//! 40 linhas: o token guarda o cursor de LISTAGEM no `crawl_state`, e o
//! formato é o mesmo que o TS grava (`Buffer.from(json).toString('base64url')`).
//! Decodificar é estrito de propósito: token do operador é estado, não entrada
//! de usuário — lixo vira `None` e o cursor recomeça da página 1.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Codifica sem padding (`Node` com `base64url` também omite).
pub fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(char::from(ALPHABET[((n >> 18) & 63) as usize]));
        out.push(char::from(ALPHABET[((n >> 12) & 63) as usize]));
        if chunk.len() > 1 {
            out.push(char::from(ALPHABET[((n >> 6) & 63) as usize]));
        }
        if chunk.len() > 2 {
            out.push(char::from(ALPHABET[(n & 63) as usize]));
        }
    }
    out
}

/// Decodifica aceitando `=` final (alguns escritores põem padding). Fora do
/// alfabeto é `None`, nunca pânico nem byte inventado.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let body = text.trim_end_matches('=');
    let mut out = Vec::with_capacity(body.len() * 3 / 4 + 1);
    let mut bits = 0u32;
    let mut bits_len = 0u32;
    for byte in body.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        bits = (bits << 6) | u32::from(value);
        bits_len += 6;
        if bits_len >= 8 {
            bits_len -= 8;
            out.push((bits >> bits_len) as u8);
            bits &= (1 << bits_len) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ida_e_volta_em_todos_os_restos_de_tres_bytes() {
        for len in 0..24usize {
            let raw: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let token = encode(&raw);
            assert!(!token.ends_with('='), "sem padding: {token}");
            assert_eq!(decode(&token).as_deref(), Some(raw.as_slice()), "len={len}");
        }
    }

    #[test]
    fn alfabeto_url_safe_e_o_do_node() {
        assert_eq!(encode(b"\xfb\xff"), "-_8");
        assert_eq!(encode(b"lc1"), "bGMx");
        assert_eq!(decode("bGMx").as_deref(), Some(b"lc1".as_slice()));
        assert_eq!(decode("-__=").map(|b| b.len()), Some(2));
    }

    #[test]
    fn decode_recusa_lixo_em_vez_de_inventar_bytes() {
        assert_eq!(decode("a+b/"), None);
        assert_eq!(decode("a b"), None);
        assert_eq!(decode("á"), None);
    }
}
