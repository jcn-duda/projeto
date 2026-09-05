'use strict';

// Os sites BR rotacionam o protetor sem avisar, e host de protetor fora desta
// lista não vira botão: o post é lido, os links existem, e a fonte devolve 0
// releases em silêncio — o mesmo sintoma de parser quebrado, causa diferente.
// Medido em 2026-09-03: o nerdfilmes passou de `systemads1.com` para
// `temreceita.com` no meio do dia e a fonte zerou em produção enquanto
// comandotorrents, torrentdosfilmes e bludv seguiam entregando.
// Hotfix sem deploy é `EXTRA_ALLOWED_PROTECTORS` no .env; esta lista é o
// default versionado.
const BASE_PROTECTOR_SUFFIXES = [
  'systemads1.com',
  'systemads.net',
  'videosad.net',
  'canalfutebol.com',
  'temreceita.com',
];

function hasAllowedHost(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function assertAllowedUrl(value, suffixes, blockedHostDetail = false) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported_protocol');
  if (!hasAllowedHost(url.hostname, suffixes)) {
    throw new Error(blockedHostDetail ? `blocked_host:${url.hostname.toLowerCase()}` : 'blocked_host');
  }
  return url;
}

module.exports = { BASE_PROTECTOR_SUFFIXES, hasAllowedHost, assertAllowedUrl };
