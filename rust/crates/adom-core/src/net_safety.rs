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
fn strip_url_noise(raw: &str) -> String {
    raw.chars()
        .filter(|c| !matches!(*c, '\t' | '\n' | '\r'))
        .collect::<String>()
        .trim_matches(|c: char| (c as u32) <= 0x20)
        .to_string()
}
fn split_scheme(s: &str) -> Option<(String, &str)> {
    let bytes = s.as_bytes();
    if bytes.first().is_none_or(|b| !b.is_ascii_alphabetic()) {
        return None;
    }
    let mut i = 1;
    while i < bytes.len()
        && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'+' | b'-' | b'.'))
    {
        i += 1;
    }
    if bytes.get(i) != Some(&b':') {
        return None;
    }
    Some((s[..i].to_ascii_lowercase(), &s[i + 1..]))
}
fn http_hostname(raw: &str) -> Option<String> {
    let cleaned = strip_url_noise(raw);
    let (scheme, after) = split_scheme(&cleaned)?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let mut rest = after.replace('\\', "/");
    if rest.starts_with('/') {
        rest = rest.trim_start_matches('/').to_string();
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let auth = &rest[..end];
    if auth.is_empty() {
        return None;
    }
    let hostport = match auth.rfind('@') {
        Some(at) => &auth[at + 1..],
        None => auth,
    };
    if let Some(inner) = hostport.strip_prefix('[') {
        let endb = inner.find(']')?;
        let afterb = &inner[endb + 1..];
        let port = if afterb.is_empty() {
            None
        } else {
            Some(afterb.strip_prefix(':')?)
        };
        if !valid_port(port) {
            return None;
        }
        let literal = inner[..endb].to_ascii_lowercase();
        parse_ipv6_words(&literal)?;
        return Some(literal);
    }
    let colons = hostport.bytes().filter(|b| *b == b':').count();
    if colons > 1 {
        return None;
    }
    let (host, port) = if colons == 1 {
        hostport.split_once(':').map(|(h, p)| (h, Some(p)))?
    } else {
        (hostport, None)
    };
    if !valid_port(port) {
        return None;
    }
    let decoded = percent_decode_host(host)?;
    let lower = map_idna(&decoded).to_lowercase();
    if lower.is_empty() || lower.chars().any(|c| !c.is_ascii() || forbidden_host(c)) {
        return None;
    }
    if ends_in_a_number(&lower) {
        parse_ipv4(&lower)
    } else {
        Some(lower)
    }
}
fn valid_port(port: Option<&str>) -> bool {
    let Some(port) = port else { return true };
    if port.is_empty() {
        return true;
    }
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let trimmed = port.trim_start_matches('0');
    if trimmed.is_empty() || trimmed.len() > 5 {
        return trimmed.is_empty();
    }
    matches!(trimmed.parse::<u32>(), Ok(n) if n <= 65535)
}
fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}
fn percent_decode_host(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            out.push((hex_val(bytes[i + 1])? << 4) | hex_val(bytes[i + 2])?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn forbidden_host(c: char) -> bool {
    let cp = c as u32;
    cp < 0x20
        || cp == 0x7f
        || matches!(
            c,
            ' ' | '#' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|'
        )
}
fn map_idna(host: &str) -> String {
    let mut out = String::with_capacity(host.len());
    for c in host.chars() {
        let cp = c as u32;
        if matches!(cp, 0x3002 | 0xff0e | 0xff61) {
            out.push('.');
        } else if (0xff01..=0xff5e).contains(&cp) {
            out.push(char::from_u32(cp - 0xfee0).unwrap_or(c));
        } else {
            out.push(c);
        }
    }
    out
}
fn ends_in_a_number(host: &str) -> bool {
    let mut parts: Vec<&str> = host.split('.').collect();
    if parts.last() == Some(&"") {
        if parts.len() == 1 {
            return false;
        }
        parts.pop();
    }
    let Some(last) = parts.last().copied() else {
        return false;
    };
    (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit())) || ipv4_number(last).is_some()
}
fn ipv4_number(input: &str) -> Option<u64> {
    if input.is_empty() {
        return None;
    }
    let bytes = input.as_bytes();
    let (radix, digits): (u64, &[u8]) =
        if bytes.len() >= 2 && bytes[0] == b'0' && matches!(bytes[1], b'x' | b'X') {
            (16, &bytes[2..])
        } else if bytes.len() >= 2 && bytes[0] == b'0' {
            (8, &bytes[1..])
        } else {
            (10, bytes)
        };
    if digits.is_empty() {
        return Some(0);
    }
    let mut n = 0u64;
    for &c in digits {
        let d = match radix {
            16 => u64::from(hex_val(c)?),
            8 if (b'0'..=b'7').contains(&c) => u64::from(c - b'0'),
            10 if c.is_ascii_digit() => u64::from(c - b'0'),
            _ => return None,
        };
        n = n.checked_mul(radix)?.checked_add(d)?;
        if n > u64::from(u32::MAX) {
            return None;
        }
    }
    Some(n)
}
fn parse_ipv4(input: &str) -> Option<String> {
    let mut parts: Vec<&str> = input.split('.').collect();
    if parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut numbers = Vec::with_capacity(parts.len());
    for part in &parts {
        if part.is_empty() {
            return None;
        }
        numbers.push(ipv4_number(part)?);
    }
    let last = numbers.len() - 1;
    if numbers[..last].iter().any(|n| *n > 255) {
        return None;
    }
    let limit = 256u64.pow((5 - numbers.len()) as u32);
    if numbers[last] >= limit {
        return None;
    }
    let mut ipv4 = numbers[last];
    for (counter, n) in numbers[..last].iter().enumerate() {
        ipv4 += n * 256u64.pow((3 - counter) as u32);
    }
    let b = |shift: u32| (ipv4 >> shift) & 255;
    Some(format!("{}.{}.{}.{}", b(24), b(16), b(8), b(0)))
}
