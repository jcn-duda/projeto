/* Resolve códigos do encurtador AFTVnews (go.aftvnews.com) pelo FlareSolverr.
 *
 * Desde 2026-11-12 o go.aftvnews.com fica atrás de um desafio do Cloudflare
 * (`cf-mitigated: challenge`) e responde 403 a todo cliente que não é
 * navegador — o app Power Movie e até o curl da VPS. O FlareSolverr do
 * container passa pelo desafio e o navegador dele segue o redirect em JS da
 * página: o destino chega em `solution.url`.
 *
 * Códigos da AFTVnews são permanentes, então o resultado fica em cache: cada
 * código paga o FlareSolverr (segundos, um Chromium) uma vez por processo.
 */

const AFTV_BASE = 'https://go.aftvnews.com/';
const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX = 2_000;
const MAX_CONCURRENT = 2;
// A AFTVnews às vezes responde "The server is under heavy load" (texto puro,
// sem destino). É passageiro: tenta de novo algumas vezes antes de desistir.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 4_000;
const OVERLOADED = /under heavy load/i;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface AftvResolverOptions {
  flaresolverrUrl: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Espera entre tentativas (teste injeta 0). */
  retryDelayMs?: number;
}

/** `url` = destino; `null` = o código não existe; erro = falha de rede/solver. */
type AftvResult = { url: string } | { url: null };

const DESTINATION = /window\.location\s*=\s*"(https?:\/\/[^"]+)"/;

function extractDestination(solutionUrl: string, body: string): AftvResult | 'unknown' | 'overloaded' {
  if (/does not exist/i.test(body)) return { url: null };
  if (OVERLOADED.test(body)) return 'overloaded';
  if (solutionUrl && !solutionUrl.startsWith(AFTV_BASE) && /^https?:\/\//.test(solutionUrl)) {
    return { url: solutionUrl };
  }
  const match = DESTINATION.exec(body);
  if (match) return { url: match[1].replace(/&amp;/g, '&') };
  return 'unknown';
}

function createAftvResolver(options: AftvResolverOptions) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const cache = new Map<string, { result: AftvResult; at: number }>();
  const inflight = new Map<string, Promise<AftvResult>>();
  let active = 0;

  async function solveOnce(code: string): Promise<AftvResult | 'unknown' | 'overloaded'> {
    const response = await fetchImpl(options.flaresolverrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: AFTV_BASE + code, maxTimeout: timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000),
    });
    if (!response.ok) throw new Error(`FlareSolverr HTTP ${response.status}`);
    const data = (await response.json()) as any;
    if (data?.status !== 'ok' || !data.solution) {
      throw new Error(`FlareSolverr: ${data?.message || 'sem solução'}`);
    }
    return extractDestination(String(data.solution.url || ''), String(data.solution.response || ''));
  }

  /** Lança `Error('overloaded')` quando a AFTVnews segue sobrecarregada. */
  async function solve(code: string): Promise<AftvResult> {
    let last: 'unknown' | 'overloaded' = 'unknown';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await solveOnce(code);
      if (outcome !== 'unknown' && outcome !== 'overloaded') return outcome;
      last = outcome;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    if (last === 'overloaded') throw new Error('overloaded');
    throw new Error('página da AFTVnews sem destino reconhecível');
  }

  /** Lança `Error('busy')` quando o solver já está no limite de concorrência. */
  async function resolve(code: string): Promise<AftvResult> {
    const cached = cache.get(code);
    if (cached && now() - cached.at < CACHE_TTL_MS) return cached.result;
    const pending = inflight.get(code);
    if (pending) return pending;
    if (active >= MAX_CONCURRENT) throw new Error('busy');

    active += 1;
    const task = solve(code)
      .then((result) => {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
        cache.set(code, { result, at: now() });
        return result;
      })
      .finally(() => {
        active -= 1;
        inflight.delete(code);
      });
    inflight.set(code, task);
    return task;
  }

  return { resolve };
}

export { createAftvResolver, extractDestination };
export type { AftvResult };
