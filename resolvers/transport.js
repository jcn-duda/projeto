'use strict';

// Cadeia HTTP idêntica de BluDV e ComandoTorrents. Os parsers de HTML e as
// regras de magnet continuam nos profiles; aqui fica somente o transporte.
async function followProtectedUrl(value, referer, {
  assertAllowedUrl,
  decodeEntities,
  extractMagnet,
  nextProtectedUrl,
  extractMetaRefresh,
  maxHops,
  timeoutMs,
  userAgent,
}) {
  if (!value) throw new Error('invalid_url');
  if (String(value).startsWith('magnet:')) return decodeEntities(value);
  let current = assertAllowedUrl(value);
  let previousReferer = referer;

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml',
        ...(previousReferer ? { Referer: previousReferer } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('missing_redirect');
      if (location.startsWith('magnet:')) return decodeEntities(location);
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`http_${response.status}`);

    const html = await response.text();
    const magnet = extractMagnet(html);
    if (magnet) return magnet;

    const next = nextProtectedUrl(html, current.href);
    if (next) {
      previousReferer = current.href;
      current = assertAllowedUrl(next);
      continue;
    }

    const refreshTarget = extractMetaRefresh(html);
    if (refreshTarget) {
      if (refreshTarget.startsWith('magnet:')) return decodeEntities(refreshTarget);
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(refreshTarget, current).href);
      continue;
    }

    throw new Error('no_magnet');
  }

  throw new Error('too_many_redirects');
}

module.exports = { followProtectedUrl };
