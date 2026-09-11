// --- isSafeDownloadUrl: bloqueio SSRF (extraído de jackett-provider.test.ts) ---
//
// O Link do indexer é input de terceiro. A proteção bloqueia esquema não-http(s),
// loopback, RFC1918, CGNAT, link-local (incluindo o 169.254.169.254 de metadado
// de nuvem), multicast, reservados e os equivalentes IPv6 — ULA, link-local,
// IPv4-mapeado, 6to4, NAT64.
import { test } from 'node:test';
import assert from 'node:assert';

import { isSafeDownloadUrl } from '../src/utils/net-safety.js';

test('Link de download bloqueia SSRF para destinos locais literais (IPv4, IPv6, ULA, Link-Local, IPv4-Mapped)', () => {
  // --- Protocolos não autorizados ---
  assert.equal(isSafeDownloadUrl('file:///etc/passwd'), false);
  assert.equal(isSafeDownloadUrl('gopher://127.0.0.1/'), false);
  assert.equal(isSafeDownloadUrl('ftp://tracker.org/file'), false);
  assert.equal(isSafeDownloadUrl('javascript:alert(1)'), false);

  // --- Hostname localhost / FQDN ---
  assert.equal(isSafeDownloadUrl('http://localhost:8080/test'), false);
  assert.equal(isSafeDownloadUrl('http://sub.localhost:8080/test'), false);
  assert.equal(isSafeDownloadUrl('http://localhost.:8080/test'), false);
  assert.equal(isSafeDownloadUrl('http://sub.localhost.:8080/test'), false);

  // --- IPv4 Privado, Loopback, Link-Local, CGNAT, Multicast, Broadcast ---
  assert.equal(isSafeDownloadUrl('http://127.0.0.1:9117/api'), false);
  assert.equal(isSafeDownloadUrl('http://127.1.2.3/test'), false);
  assert.equal(isSafeDownloadUrl('http://10.0.0.1:8080/torrents'), false);
  assert.equal(isSafeDownloadUrl('http://172.16.0.1/download'), false);
  assert.equal(isSafeDownloadUrl('http://172.31.255.254/download'), false);
  assert.equal(isSafeDownloadUrl('http://192.168.1.10/file'), false);
  assert.equal(isSafeDownloadUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafeDownloadUrl('http://0.0.0.0:7000/api'), false);
  assert.equal(isSafeDownloadUrl('http://100.64.0.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://100.127.255.254/test'), false);
  assert.equal(isSafeDownloadUrl('http://192.0.2.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://198.51.100.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://203.0.113.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://224.0.0.1/multicast'), false);
  assert.equal(isSafeDownloadUrl('http://239.255.255.250/multicast'), false);
  assert.equal(isSafeDownloadUrl('http://240.0.0.1/reserved'), false);
  assert.equal(isSafeDownloadUrl('http://255.255.255.255/broadcast'), false);

  // --- IPv6 Não-especificado ---
  assert.equal(isSafeDownloadUrl('http://[::]/file.torrent'), false);
  assert.equal(isSafeDownloadUrl('http://[0:0:0:0:0:0:0:0]/file'), false);

  // --- IPv6 Loopback ---
  assert.equal(isSafeDownloadUrl('http://[::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[0:0:0:0:0:0:0:1]:8080/api'), false);

  // --- IPv4-Mapped IPv6 (notação decimal e hexadecimal normalizada) ---
  assert.equal(isSafeDownloadUrl('http://[::ffff:127.0.0.1]:9117/api'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:7f00:1]/api'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:169.254.169.254]/meta'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:a9fe:a9fe]/meta'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:10.0.0.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:a00:1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:192.168.1.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:c0a8:101]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:172.16.0.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:ac10:1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:0.0.0.0]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:100.64.0.1]/test'), false);

  // --- NAT64 e 6to4 Privados ---
  assert.equal(isSafeDownloadUrl('http://[64:ff9b::127.0.0.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[2002:7f00:1::1]/test'), false);

  // --- IPv6 Unique Local Address (ULA fc00::/7) ---
  assert.equal(isSafeDownloadUrl('http://[fc00::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[fd12:3456:789a::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/file'), false);

  // --- IPv6 Link-Local Unicast (fe80::/10) ---
  assert.equal(isSafeDownloadUrl('http://[fe80::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[fe80::200:5efe:127.0.0.1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/file'), false);

  // --- IPv6 Site-Local e Multicast ---
  assert.equal(isSafeDownloadUrl('http://[fec0::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[ff02::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[ffff::1]/file'), false);

  // --- IPv6 Documentação e Discard ---
  assert.equal(isSafeDownloadUrl('http://[2001:db8::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[100::1]/file'), false);

  // --- Endpoints públicos legítimos permitidos ---
  assert.equal(isSafeDownloadUrl('https://tracker.example/download'), true);
  assert.equal(isSafeDownloadUrl('https://tracker.example.com/download.torrent'), true);
  assert.equal(isSafeDownloadUrl('http://tracker.example.org:8080/download'), true);
  assert.equal(isSafeDownloadUrl('http://93.184.216.34/file.torrent'), true);
  assert.equal(isSafeDownloadUrl('http://8.8.8.8/dns'), true);
  assert.equal(isSafeDownloadUrl('http://1.1.1.1/dns'), true);
  assert.equal(isSafeDownloadUrl('http://172.32.0.1/download'), true);
  assert.equal(isSafeDownloadUrl('http://192.169.1.1/download'), true);
  assert.equal(isSafeDownloadUrl('http://100.128.0.1/download'), true);
  assert.equal(isSafeDownloadUrl('http://[2606:4700:4700::1111]/dns'), true);
  assert.equal(isSafeDownloadUrl('http://[2001:4860:4860::8888]/dns'), true);
  assert.equal(isSafeDownloadUrl('http://[::ffff:8.8.8.8]/file'), true);
  assert.equal(isSafeDownloadUrl('http://[::ffff:1.1.1.1]/file'), true);
  assert.equal(isSafeDownloadUrl('http://[64:ff9b::8.8.8.8]/file'), true);

  // --- allowPrivate flag ---
  assert.equal(isSafeDownloadUrl('http://127.0.0.1:9117/api', true), true);
  assert.equal(isSafeDownloadUrl('http://[::1]/file', true), true);
  assert.equal(isSafeDownloadUrl('http://192.168.1.1/file', true), true);
  assert.equal(isSafeDownloadUrl('http://[fe80::1]/file', true), true);
  assert.equal(isSafeDownloadUrl('file:///etc/passwd', true), false);
});
