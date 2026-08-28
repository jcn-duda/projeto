'use strict';

// Cadeia HTTP dos quatro perfis. Os parsers de HTML e as regras de magnet
// continuam nos profiles; aqui fica somente o transporte.
//
// O teste do scheme é case-insensitive e o resultado sai normalizado para
// `magnet:` minúsculo: o NerdFilmes publica `MAGNET:` em parte dos botões e
// tinha o próprio laço só por causa disso. Para os outros três a normalização
// é no-op — eles já emitem minúsculo.
const MAGNET_SCHEME = /^magnet:/i;

function normalizeMagnet(value) {
  return String(value).replace(MAGNET_SCHEME, 'magnet:');
}

// Jar de cookies OPT-IN, local a cada chamada de followProtectedUrl.
// Guarda os `Set-Cookie` por hostname e reenvia como `Cookie` apenas quando o
// próximo salto tem o MESMO hostname (não vazam para host diferente). É o que
// sustenta a cadeia systemtech go.php -> relay.php (mesmo domínio): o relay
// exige o cookie emitido no go.php, mas um resolvedor não pode acoplar a
// sessão entre chamadas.
//
// Aceita dois formatos:
//   - `true`  → jar vazio (desde sempre): só colhe os `Set-Cookie` da rede.
//   - objeto  → além de colher, PRÉ-POPULA o jar com pares conhecidos na forma
//     `{ seed: { '<hostname>': { '<nome>': '<valor>' } } }` — ex.: os cookies
//     de liberação client-side do Vaca Torrent (`enc_liberado`/`enc_etapa1_*`)
//     que o `liberar()` do JS setaria na vacadb.org.
// O seed reusa o parser `harvest(host).from("<nome>=<valor>")`, então qualquer
// atributo que porventura apareça no seed é tratado como em um `Set-Cookie`.
function createCookieJar() {
  const byHost = new Map();
  return {
    headers(hostname) {
      const h = byHost.get(String(hostname).toLowerCase());
      if (!h || h.size === 0) return null;
      return [...h.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    harvest(hostname) {
      return {
        from(raw) {
          const name = String(hostname).toLowerCase();
          if (!raw) return;
          if (!byHost.has(name)) byHost.set(name, new Map());
          const dest = byHost.get(name);
          // Node/undici une vários `Set-Cookie` numa única string separada por
          // ", " — quebrar os DOIS separadores evita corromper o 2º cookie
          // (ex.: "session=abc; Path=/", "theme=dark" -> dois pares distintos).
          for (const part of String(raw).split(',')) {
            const pair = part.split(';')[0];
            const eq = pair.indexOf('=');
            if (eq < 1) continue;
            // o valor pode conter "="; só o primeiro separa name de value.
            dest.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
          }
        },
        list() {
          return undefined;
        },
      };
    },
  };
}

async function followProtectedUrl(value, referer, {
  assertAllowedUrl,
  decodeEntities,
  extractMagnet,
  nextProtectedUrl,
  extractMetaRefresh,
  maxHops,
  timeoutMs,
  userAgent,
  cookieJar = false,
}) {
  if (!value) throw new Error('invalid_url');
  if (MAGNET_SCHEME.test(String(value))) return normalizeMagnet(decodeEntities(value));
  let current = assertAllowedUrl(value);
  let previousReferer = referer;
  const jar = cookieJar ? createCookieJar() : null;
  // Pre-popula o jar com o seed explícito (quando cookieJar é um objeto na
  // forma `{ seed: { '<host>': { '<nome>': '<valor>' } } }`). `cookieJar: true`
  // não tem seed e mantém o comportamento original (jar só colhe da rede).
  if (jar && cookieJar && typeof cookieJar === 'object' && cookieJar.seed) {
    for (const [host, pairs] of Object.entries(cookieJar.seed)) {
      for (const [name, value] of Object.entries(pairs || {})) {
        jar.harvest(host).from(`${name}=${value}`);
      }
    }
  }

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const headers = {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml',
      ...(previousReferer ? { Referer: previousReferer } : {}),
    };
    if (jar) {
      const cookie = jar.headers(current.hostname);
      if (cookie) headers.Cookie = cookie;
    }
    const response = await fetch(current, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (jar) jar.harvest(current.hostname).from(response.headers.get('set-cookie'));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('missing_redirect');
      if (MAGNET_SCHEME.test(location)) return normalizeMagnet(decodeEntities(location));
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`http_${response.status}`);

    const html = await response.text();
    const magnet = extractMagnet(html);
    if (magnet) return normalizeMagnet(magnet);

    const next = nextProtectedUrl(html, current.href);
    if (next) {
      previousReferer = current.href;
      current = assertAllowedUrl(next);
      continue;
    }

    const refreshTarget = extractMetaRefresh(html);
    if (refreshTarget) {
      if (MAGNET_SCHEME.test(refreshTarget)) return normalizeMagnet(decodeEntities(refreshTarget));
      previousReferer = current.href;
      current = assertAllowedUrl(new URL(refreshTarget, current).href);
      continue;
    }

    throw new Error('no_magnet');
  }

  throw new Error('too_many_redirects');
}

module.exports = { followProtectedUrl };
