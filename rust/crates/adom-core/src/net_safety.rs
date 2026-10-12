/// `true` quando o Link http(s) pode ser buscado.
pub fn is_safe_download_url(raw: &str, allow_private: bool) -> bool {
    let Some(hostname) = http_hostname(raw) else {
        return false;
    };
    if allow_private {
        return true;
    }
    let host = normalize_host(&hostname);
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    if is_ipv4(&host) {
        return !private_ipv4(&host);
    }
    if host.contains(':') {
        return !private_ipv6(&host);
    }
    true
}
fn normalize_host(hostname: &str) -> String {
    let mut host = hostname.to_ascii_lowercase();
    while host.ends_with('.') {
        host.pop();
    }
    if host.starts_with('[') {
        host.remove(0);
    }
    if host.ends_with(']') {
        host.pop();
    }
    host
}
fn is_v4_seg(s: &str) -> bool {
    matches!(s.parse::<u8>(), Ok(n) if s == n.to_string())
}
fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts.iter().all(|part| is_v4_seg(part))
}
fn is_private_ipv4_octets(b0: u8, b1: u8, b2: u8, _: u8) -> bool {
    b0 == 0 || b0 == 10 || b0 == 127
        || (b0 == 100 && (64..=127).contains(&b1))
        // 169.254.0.0/16: link-local, inclui o metadata 169.254.169.254.
        || (b0 == 169 && b1 == 254)
        || (b0 == 172 && (16..=31).contains(&b1))
        || (b0 == 192 && b1 == 0 && (b2 == 0 || b2 == 2))
        || (b0 == 192 && b1 == 168)
        || (b0 == 198 && (b1 == 18 || b1 == 19))
        || (b0 == 198 && b1 == 51 && b2 == 100)
        || (b0 == 203 && b1 == 0 && b2 == 113)
        || b0 >= 224
}
fn private_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u8; 4];
    for (i, part) in parts.iter().enumerate() {
        let Some(n) = decimal_octet(part) else {
            return false;
        };
        octets[i] = n as u8;
    }
    is_private_ipv4_octets(octets[0], octets[1], octets[2], octets[3])
}
fn decimal_octet(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = s.parse().ok()?;
    (n <= 255).then_some(n)
}
fn parse_ipv6_words(host: &str) -> Option<[u16; 8]> {
    let mut current = host.to_string();
    if let Some(last_colon) = current.rfind(':') {
        let tail = &current[last_colon + 1..];
        if tail.contains('.') {
            let v4: Vec<&str> = tail.split('.').collect();
            if v4.len() != 4 {
                return None;
            }
            let mut nums = [0u32; 4];
            for (i, part) in v4.iter().enumerate() {
                nums[i] = decimal_octet(part)?;
            }
            let w1 = (nums[0] << 8) | nums[1];
            let w2 = (nums[2] << 8) | nums[3];
            current = format!("{}{:x}:{:x}", &current[..last_colon + 1], w1, w2);
        }
    }
    let words = if current.contains("::") {
        let parts: Vec<&str> = current.split("::").collect();
        if parts.len() > 2 {
            return None;
        }
        let left = if parts[0].is_empty() {
            Vec::new()
        } else {
            hex_side(parts[0])?
        };
        let right = if parts[1].is_empty() {
            Vec::new()
        } else {
            hex_side(parts[1])?
        };
        let fill = 8isize - left.len() as isize - right.len() as isize;
        if fill < 0 {
            return None;
        }
        let mut words = left;
        words.extend(std::iter::repeat(0u16).take(fill as usize));
        words.extend(right);
        words
    } else {
        hex_side(&current)?
    };
    if words.len() != 8 {
        return None;
    }
    let mut out = [0u16; 8];
    out.copy_from_slice(&words);
    Some(out)
}
fn hex_side(side: &str) -> Option<Vec<u16>> {
    side.split(':')
        .map(|piece| {
            let value = u32::from_str_radix(piece, 16).ok()?;
            (value <= 0xffff).then_some(value as u16)
        })
        .collect()
}
fn private_ipv6(host: &str) -> bool {
    let Some(words) = parse_ipv6_words(host) else {
        return true;
    };
    let [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    if words.iter().all(|w| *w == 0) {
        return true;
    }
    if [w0, w1, w2, w3, w4, w5, w6] == [0, 0, 0, 0, 0, 0, 0] && w7 == 1 {
        return true;
    }
    let v4 = |hi: u16, lo: u16| {
        is_private_ipv4_octets(
            (hi >> 8) as u8,
            (hi & 0xff) as u8,
            (lo >> 8) as u8,
            (lo & 0xff) as u8,
        )
    };
    // IPv4-mapeado (::ffff:0:0/96) e compatível (::/96): o IPv4 embutido
    // usa a mesma régua, senão 127.0.0.1 passa como ::ffff:7f00:1.
    if w0 == 0 && w1 == 0 && w2 == 0 && w3 == 0 && w4 == 0 && (w5 == 0xffff || w5 == 0) {
        return v4(w6, w7);
    }
    if w0 == 0x0064 && w1 == 0xff9b && w2 == 0 && w3 == 0 && w4 == 0 && w5 == 0 {
        return v4(w6, w7);
    }
    if w0 == 0x2002 && v4(w1, w2) {
        return true;
    }
    if w0 == 0x0100 && w1 == 0 && w2 == 0 && w3 == 0 {
        return true;
    }
    if w0 == 0x2001 && w1 == 0x0db8 {
        return true;
    }
    (w0 & 0xfe00) == 0xfc00
        || (w0 & 0xffc0) == 0xfe80
        || (w0 & 0xffc0) == 0xfec0
        || (w0 & 0xff00) == 0xff00
}
/// Host do Link pelo parser WHATWG do crate `url` — o mesmo algoritmo do
/// `new URL()` do TS, com IDNA/punycode, números IPv4 em hex/octal/decimal e
/// percent-decode. Um parser escrito à mão divergia do Node em ~1,6% de URLs
/// de fuzz (IDNA inteira, e `%` e hex estourado liberados); com o crate, zero
/// em 600 mil. Esquema fora de http(s) ou URL inválida: `None` (fail-closed).
fn http_hostname(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    url.host_str().map(str::to_string)
}
