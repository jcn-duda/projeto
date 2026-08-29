'use strict';

/**
 * FlareSolverr (Cloudflare) — núcleo comum dos resolvers (passo 6 do item 9,
 * PLANO_MELHORIAS §5.8).
 *
 * Duas peças:
 *  - `createFlareSessions()`: mapa hostname -> sessão { cookies, userAgent,
 *    expiresAt } com leitura consciente de TTL. API original do núcleo §5.4,
 *    preservada para quem já a usa.
 *  - `createFlareFetcher({...})`: RELOCALIZAÇÃO da mecânica FlareSolverr que
 *    vivia no bludv — `fetchTextViaFlare`, `buildFlareHeaders`,
 *    `getFlareSession`, `buildCookies` e a derivação por desafio CF
 *    (`isCloudflareChallenge`). Dono único, não deduplicação: hoje só o bludv
 *    consome; nenhum outro perfil passa por aqui.
 *
 * Sem estado de módulo (R-2): as sessões nascem por chamada (ou entram
 * injetadas) e nada é compartilhado entre perfis.
 */

function createFlareSessions() {
  const sessions = new Map();
  return {
    get(hostname) {
      const hit = sessions.get(hostname);
      return hit && hit.expiresAt > Date.now() ? hit : null;
    },
    set(hostname, session) { sessions.set(hostname, session); },
    clear() { sessions.clear(); },
    sessions,
  };
}

/**
 * Cookies da solução do FlareSolverr no formato de header Cookie. Extraído
 * junto com o fetcher para o bludv não manter a segunda metade da mecânica.
 */
function buildCookies(cookies) {
  return (cookies || [])
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Detecta o desafio do Cloudflare num 403: header `cf-mitigated: challenge`
 * OU marcadores do desafio no corpo. 403 por outro motivo (rate-limit,
 * bloqueio de região/proxy) NÃO é desafio — derivá-lo ao FlareSolverr viraria
 * página de erro do resolvedor e silenciaria a falha em "0 resultados".
 */
function isCloudflareChallenge(response, body) {
  return response.headers.get('cf-mitigated') === 'challenge' ||
    /Just a moment|cf-chl|__cf_chl|challenge-platform|cf-browser-verification|cf_chl/i.test(body);
}

/**
 * Fábrica da mecânica FlareSolverr de um perfil. Knobs de env com os MESMOS
 * defaults do bludv (lidos no require do perfil, como antes — a chamada do
 * perfil acontece no nível do módulo). `userAgent` é o fallback do fetch
 * direto quando não há sessão (o perfil injeta o USER_AGENT do runtime).
 */
function createFlareFetcher(options = {}) {
  const {
    // `solverUrl` e não `url`: o parâmetro `url` de fetchTextViaFlare é o alvo
    // pedido — sombrear aqui seria postar o alvo no lugar do resolvedor.
    solverUrl = (process.env.FLARE_SOLVERR_URL || 'http://127.0.0.1:8191').replace(/\/$/, ''),
    timeoutMs = Number(process.env.FLARE_TIMEOUT_MS || 55_000),
    sessionTtlMs = Number(process.env.FLARE_SESSION_TTL_MS || 20 * 60_000),
    userAgent,
    sessions = createFlareSessions(),
  } = options;

  function getFlareSession(hostname) {
    const hit = sessions.get(hostname);
    if (hit && hit.expiresAt > Date.now()) return hit;
    return null;
  }

  // Roteia a resposta HTML pelo FlareSolverr quando o site exigir desafio
  // Cloudflare. Salva a sessão (cf_clearance + userAgent) por host para o fetch
  // direto seguinte reusar sem pagar o browser de novo. Retorna o HTML resolvido.
  async function fetchTextViaFlare(url, referer) {
    const body = JSON.stringify({ cmd: 'request.get', url, maxTimeout: timeoutMs });
    const res = await fetch(`${solverUrl}/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    // Falha do FlareSolverr (5xx/HTML) NÃO é falha do site: propaga com prefixo
    // flare_ (excluído do isNetworkError) para o failover de domínio não morder.
    if (!res.ok) throw new Error(`flare_http_${res.status}`);
    const data = await res.json();
    if (data.status !== 'ok' || !data.solution) {
      throw new Error(`flare_error_${data.status || '?'}:${data.message || 'sem solução'}`);
    }
    const { solution } = data;
    // FlareSolverr reporta status:'ok' mesmo quando a página final é a tela de
    // erro do Chromium (ex.: origin 522). `solution.status` é o HTTP real da
    // página: só 2xx é sucesso — senão o erro de origin viraria "0 posts" e o
    // noteSuccess() zerava o streak do failover, escondendo a fonte morta.
    const solvedStatus = Number(solution.status || 200);
    if (solvedStatus < 200 || solvedStatus >= 300) {
      throw new Error(`flare_site_${solvedStatus}`);
    }
    const response = solution.response || '';
    // Guarda extra: a tela de erro do Chromium ("This page isn't working"/"HTTP
    // ERROR NNN") chega com status 200 internamente em alguns cenários. Rejeitá-la
    // mantém a falha diagnosticável em vez de silenciar em "0 resultados".
    if (/This page isn.t working|HTTP ERROR \d{3}/i.test(response)) {
      throw new Error('flare_site_error_page');
    }
    const session = {
      cookies: buildCookies(solution.cookies),
      userAgent: solution.userAgent,
      expiresAt: Date.now() + sessionTtlMs,
    };
    // Grava sob o host PEDIDO e o RESOLVIDO: no cenário 301 (bludvfilmes.xyz →
    // bludvfilmes1.xyz) o próximo fetch direto consulta o host pedido e acha a
    // sessão — senão pagava o browser de novo a cada expiração do cache.
    sessions.set(new URL(url).hostname, session);
    sessions.set(new URL(solution.url || url).hostname, session);
    return response;
  }

  function buildFlareHeaders(url, referer) {
    // O fetch direto só reusa a sessão do MESMO host: um domain change limpa o
    // mapa, e o cf_clearance é por host — misturar UA/cookies de outro domínio
    // só garante rejeição. O host é o do alvo pedido, não do referer (o referer
    // chega undefined no fetchText do post).
    const hostname = new URL(url).hostname;
    const session = getFlareSession(hostname);
    return {
      'User-Agent': session?.userAgent || userAgent,
      Accept: 'text/html,application/xhtml+xml',
      ...(session?.cookies ? { Cookie: session.cookies } : {}),
      ...(referer ? { Referer: referer } : {}),
    };
  }

  return { sessions, getFlareSession, buildFlareHeaders, fetchTextViaFlare };
}

module.exports = { createFlareSessions, createFlareFetcher, buildCookies, isCloudflareChallenge };
