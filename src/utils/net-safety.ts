import net from 'node:net';

/**
 * Checks whether the 4 IPv4 octets fall within any private, loopback,
 * link-local, unspecified, multicast, or reserved ranges.
 */
function isPrivateIpv4Octets(b0: number, b1: number, b2: number, b3: number): boolean {
  // 0.0.0.0/8 (unspecified / "this" network)
  if (b0 === 0) return true;
  // 10.0.0.0/8 (RFC 1918 private)
  if (b0 === 10) return true;
  // 100.64.0.0/10 (RFC 6598 Carrier-Grade NAT)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
  // 127.0.0.0/8 (RFC 1122 loopback)
  if (b0 === 127) return true;
  // 169.254.0.0/16 (RFC 3927 link-local / cloud metadata)
  if (b0 === 169 && b1 === 254) return true;
  // 172.16.0.0/12 (RFC 1918 private: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  // 192.0.0.0/24 (RFC 6890 IETF Protocol Assignments)
  if (b0 === 192 && b1 === 0 && b2 === 0) return true;
  // 192.0.2.0/24 (RFC 5737 TEST-NET-1 documentation)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;
  // 192.168.0.0/16 (RFC 1918 private)
  if (b0 === 192 && b1 === 168) return true;
  // 198.18.0.0/15 (RFC 2544 network benchmark tests)
  if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
  // 198.51.100.0/24 (RFC 5737 TEST-NET-2 documentation)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;
  // 203.0.113.0/24 (RFC 5737 TEST-NET-3 documentation)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;
  // 224.0.0.0/4 (RFC 5771 multicast: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;
  // 240.0.0.0/4 (RFC 1112 reserved / broadcast: 240.0.0.0 - 255.255.255.255)
  if (b0 >= 240) return true;

  return false;
}

function privateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  return isPrivateIpv4Octets(parts[0], parts[1], parts[2], parts[3]);
}

/**
 * Parses a valid IPv6 string into 8 16-bit integer words.
 * Correctly expands '::' compression and converts dotted-decimal IPv4 suffixes.
 */
function parseIpv6Words(host: string): number[] | null {
  let str = host;
  const lastColon = str.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = str.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4parts = tail.split('.').map(Number);
      if (v4parts.length !== 4 || v4parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return null;
      }
      const w1 = ((v4parts[0] << 8) | v4parts[1]).toString(16);
      const w2 = ((v4parts[2] << 8) | v4parts[3]).toString(16);
      str = str.slice(0, lastColon + 1) + w1 + ':' + w2;
    }
  }

  let words: number[];
  if (str.includes('::')) {
    const parts = str.split('::');
    if (parts.length > 2) return null;
    const [left, right] = parts;
    const leftParts = left ? left.split(':').map((h) => parseInt(h, 16)) : [];
    const rightParts = right ? right.split(':').map((h) => parseInt(h, 16)) : [];
    const fillCount = 8 - (leftParts.length + rightParts.length);
    if (fillCount < 0) return null;
    words = [...leftParts, ...new Array(fillCount).fill(0), ...rightParts];
  } else {
    words = str.split(':').map((h) => parseInt(h, 16));
  }

  if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) {
    return null;
  }
  return words;
}

function privateIpv6(host: string): boolean {
  const words = parseIpv6Words(host);
  if (!words) return true; // Fail-safe closed on malformed representations

  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;

  // Unspecified (::/128)
  if (words.every((w) => w === 0)) return true;

  // Loopback (::1/128)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96, RFC 4291) and IPv4-compatible (::0:0/96)
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) {
    const b0 = (w6 >> 8) & 0xff;
    const b1 = w6 & 0xff;
    const b2 = (w7 >> 8) & 0xff;
    const b3 = w7 & 0xff;
    return isPrivateIpv4Octets(b0, b1, b2, b3);
  }

  // NAT64 Well-Known Prefix (64:ff9b::/96, RFC 6052)
  if (w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const b0 = (w6 >> 8) & 0xff;
    const b1 = w6 & 0xff;
    const b2 = (w7 >> 8) & 0xff;
    const b3 = w7 & 0xff;
    return isPrivateIpv4Octets(b0, b1, b2, b3);
  }

  // 6to4 prefix (2002::/16, RFC 3056: embeds IPv4 in w1 and w2)
  if (w0 === 0x2002) {
    const b0 = (w1 >> 8) & 0xff;
    const b1 = w1 & 0xff;
    const b2 = (w2 >> 8) & 0xff;
    const b3 = w2 & 0xff;
    if (isPrivateIpv4Octets(b0, b1, b2, b3)) return true;
  }

  // Discard prefix (100::/64, RFC 6666)
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true;

  // Documentation prefix (2001:db8::/32, RFC 3849)
  if (w0 === 0x2001 && w1 === 0x0db8) return true;

  // Unique Local Address ULA (fc00::/7, RFC 4193: covers fc00:: through fdff::)
  if ((w0 & 0xfe00) === 0xfc00) return true;

  // Link-Local Unicast (fe80::/10, RFC 4291: covers fe80:: through febf::)
  if ((w0 & 0xffc0) === 0xfe80) return true;

  // Deprecated Site-Local Unicast (fec0::/10, RFC 3879: covers fec0:: through feff::)
  if ((w0 & 0xffc0) === 0xfec0) return true;

  // Multicast (ff00::/8, RFC 4291: covers ff00:: through ffff::)
  if ((w0 & 0xff00) === 0xff00) return true;

  return false;
}

/**
 * O Link do indexer é input de terceiros. Bloqueia esquemas e destinos locais
 * literais antes do fetch; hostname público continua a ser resolvido pela rede
 * normal para não transformar indisponibilidade de DNS em falso bloqueio.
 */
function isSafeDownloadUrl(raw: string, allowPrivate = false): boolean {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (allowPrivate) return true;
    const host = url.hostname.toLowerCase().replace(/\.+$/, '').replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return false;
    if (net.isIP(host) === 4) return !privateIpv4(host);
    if (net.isIP(host) === 6) return !privateIpv6(host);
    return true;
  } catch {
    return false;
  }
}

export { isSafeDownloadUrl };
