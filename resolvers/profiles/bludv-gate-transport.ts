import { randomUUID } from 'node:crypto';
import { USER_AGENT } from '../runtime.js';
import { decodeEntities } from '../text.js';
import { safeGateUrl } from './bludv-gate-links.js';
import { BludvAdGateError } from './bludv-gate.js';

const AD_HOSTS = new Set(['promobr.online', 'x.gd', 'valedesconto.shop']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const CLEANUP_MS = 3000;

export function gateError(reason: string): BludvAdGateError {
  return new BludvAdGateError(`bludv: portão de anúncio (${reason})`);
}

/** Nunca incorpora mensagem remota, URL, token ou motivo bruto de AbortSignal. */
export function gateAbortError(signal: AbortSignal): BludvAdGateError {
  return gateError(signal.reason?.name === 'TimeoutError' ? 'prazo esgotado' : 'cancelado');
}

export function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(gateAbortError(signal)); };
    promise.then((value) => {
      signal.removeEventListener('abort', abort);
      signal.aborted ? reject(gateAbortError(signal)) : resolve(value);
    }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function gateWait(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await withinSignal(new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)); }), signal); }
  finally { clearTimeout(timer); }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await withinSignal(reader.read(), signal);
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw gateError('resposta grande demais');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { void reader.cancel().catch(() => {}); }
}

export type UrlGuard = (url: URL) => boolean;

export function createGateTransport(solverUrl: string, gate: URL, deadline: number, signal: AbortSignal) {
  let endpoint: URL;
  try {
    endpoint = new URL(solverUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) throw new Error();
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '').replace(/\/v1$/, '')}/v1`;
  } catch { throw gateError('solvedor inválido'); }
  // ID escolhido antes da criação: mesmo se a resposta se perder, podemos limpar.
  const session = randomUUID();

  function allowed(value: string, base?: string): URL {
    const url = safeGateUrl(value, base);
    if (!url || (url.hostname !== gate.hostname && !AD_HOSTS.has(url.hostname))) {
      throw gateError('destino não permitido');
    }
    return url;
  }

  async function request(url: URL, init: RequestInit, requestSignal = signal): Promise<Response> {
    if (requestSignal.aborted) throw gateAbortError(requestSignal);
    return withinSignal(fetch(url.href, { ...init, redirect: 'manual', signal: requestSignal }), requestSignal);
  }

  async function flare(payload: Record<string, unknown>, requestSignal = signal): Promise<Record<string, any>> {
    const res = await request(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }, requestSignal);
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw gateError('solvedor indisponível'); }
    const data = JSON.parse(await readBody(res, requestSignal));
    if (data?.status !== 'ok') throw gateError('solvedor recusou a operação');
    return data;
  }

  async function flareGet(value: string, guard: UrlGuard): Promise<{ url: URL; html: string }> {
    const url = allowed(value);
    // FlareSolverr NÃO oferece redirect:'manual'/allowlist no request.get.
    // Validamos entrada e saída, mas saltos/subrecursos internos exigem filtro
    // de egress no solvedor. Não fingir que solution.url prova toda a cadeia.
    const data = await flare({ cmd: 'request.get', url: url.href, session,
      maxTimeout: Math.max(1, deadline - Date.now()) });
    const solution = data.solution;
    if (!solution || typeof solution.url !== 'string' || typeof solution.response !== 'string'
      || !(solution.status >= 200 && solution.status < 300)) throw gateError('solução inválida');
    const finalUrl = allowed(solution.url);
    if (!guard(finalUrl)) throw gateError('saída inesperada do solvedor');
    return { url: finalUrl, html: solution.response };
  }

  async function get(value: string): Promise<{ url: URL; location: URL | null; html: string }> {
    const url = allowed(value);
    const res = await request(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' } });
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => {});
      const location = res.headers.get('location');
      if (!location) throw gateError('redirecionamento sem destino');
      // Valida ANTES de qualquer requisição ao Location (inclusive no x.gd).
      return { url, location: allowed(decodeEntities(location), url.href), html: '' };
    }
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw gateError('etapa HTTP indisponível'); }
    return { url, location: null, html: await readBody(res, signal) };
  }

  async function text(value: string, guard: UrlGuard): Promise<string> {
    let url = allowed(value);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!guard(url)) throw gateError('etapa fora do destino esperado');
      const result = await get(url.href);
      if (!result.location) return result.html;
      url = result.location;
    }
    throw gateError('redirecionamentos demais');
  }

  return {
    allowed, get, text, flareGet,
    create: async () => {
      const data = await flare({ cmd: 'sessions.create', session });
      if (data.session !== session) throw gateError('sessão não confirmada');
    },
    destroy: async () => {
      // Cleanup independente do abort da busca, mas sempre limitado. O prazo de
      // resolução não é prolongado: quem aguarda já está protegido pelo signal.
      const cleanup = new AbortController();
      const timer = setTimeout(() => cleanup.abort(), CLEANUP_MS);
      try { await flare({ cmd: 'sessions.destroy', session }, cleanup.signal); }
      catch { console.warn('[bludv-gate] não foi possível confirmar a limpeza da sessão'); }
      finally { clearTimeout(timer); }
    },
  };
}
