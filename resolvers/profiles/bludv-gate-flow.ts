import { decodeEntities } from '../text.js';
import { extractMagnet, isValidMagnetUri } from './bludv-parsers.js';
import { BludvAdGateError } from './bludv-gate.js';
import { isGateUrl, safeGateUrl } from './bludv-gate-links.js';
import {
  createGateTransport, gateAbortError, gateError, gateWait, withinSignal,
} from './bludv-gate-transport.js';
import type { UrlGuard } from './bludv-gate-transport.js';

export interface GateOptions {
  solverUrl?: string;
  timeoutMs?: number;
  minWaitMs?: number;
  signal?: AbortSignal;
}

// Tetos de segurança por processo, inclusive consumidores coalescidos.
const MAX_QUEUED = 8;
const MAX_WAITERS = 32;
const MAX_CACHE = 128;
const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { magnet: string; expires: number }>();
const inFlight = new Map<string, { promise: Promise<string>; controller: AbortController; waiters: number }>();
const queue: Array<() => void> = [];
let active = false;

function duration(value: unknown, fallback: number, allowZero = false): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= (allowZero ? 0 : 1)
    && n <= 300_000 ? Math.floor(n) : fallback;
}

async function acquire(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) throw gateAbortError(signal);
  if (active) {
    if (queue.length >= MAX_QUEUED) throw gateError('fila cheia');
    let wake!: () => void;
    const ready = new Promise<void>((resolve) => { wake = resolve; queue.push(wake); });
    try { await withinSignal(ready, signal); }
    catch (error) {
      const index = queue.indexOf(wake);
      if (index >= 0) queue.splice(index, 1);
      else releaseSlot();
      throw error;
    }
  } else active = true;
  return releaseSlot;
}

function releaseSlot(): void {
  const next = queue.shift();
  if (next) next();
  else active = false;
}

const at = (host: string, path: RegExp): UrlGuard => (url) => url.hostname === host && path.test(url.pathname);

function hrefOf(html: string, base: string, guard: UrlGuard): string {
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1/gi)) {
    const url = safeGateUrl(decodeEntities(match[2]), base);
    if (url && guard(url)) return url.href;
  }
  throw gateError('botão de saída ausente');
}

async function runGate(gate: URL, options: GateOptions, deadline: number, signal: AbortSignal): Promise<string> {
  const transport = createGateTransport(
    options.solverUrl || process.env.FLARE_SOLVERR_URL || 'http://127.0.0.1:8191', gate, deadline, signal,
  );
  try {
    await transport.create();
    const startedAt = Date.now();
    const landing = await transport.flareGet(gate.href, at('promobr.online', /^\/jump\/.+/));
    const promotion = await transport.text(landing.url.href, at('promobr.online', /^\/jump\/.+/));
    const shortUrl = hrefOf(promotion, landing.url.href, at('x.gd', /^\/.+/));
    const redirected = await transport.get(shortUrl);
    const voucher = redirected.location;
    if (!voucher || !at('valedesconto.shop', /^\/r\/.+/)(voucher)) throw gateError('saída do encurtador inválida');
    const code = voucher.searchParams.get('utm_content') || '';
    if (voucher.searchParams.getAll('utm_content').length !== 1 || !/^[A-Za-z0-9+/_=-]{1,512}$/.test(code)) {
      throw gateError('código do anúncio inválido');
    }
    // Não é necessário visitar a loja. O Location fornece o código para a API.
    const endUrl = new URL('https://promobr.online/api/end');
    endUrl.searchParams.set('code', code);
    const end = JSON.parse(await transport.text(endUrl.href, at('promobr.online', /^\/api\/end$/)));
    if (typeof end?.url !== 'string') throw gateError('API sem saída');
    const hop = transport.allowed(end.url);
    if (!at('promobr.online', /^\/hop\/.+/)(hop)) throw gateError('hop inválido');
    const hopHtml = await transport.text(hop.href, at('promobr.online', /^\/hop\/.+/));
    const go = hrefOf(hopHtml, hop.href, at('promobr.online', /^\/go\/.+/));
    const callback = (await transport.get(go)).location;
    if (!callback || callback.hostname !== gate.hostname || callback.pathname !== '/gate/callback'
      || callback.searchParams.getAll('token').length !== 1 || !callback.searchParams.get('token')
      || callback.searchParams.getAll('ref').length !== 1 || !callback.searchParams.get('ref')) {
      throw gateError('callback inválido');
    }
    const minWait = duration(options.minWaitMs ?? process.env.BLUDV_GATE_MIN_WAIT_MS, 30_000, true);
    await gateWait(minWait - (Date.now() - startedAt), signal);
    const solved = await transport.flareGet(callback.href, (url) => url.hostname === gate.hostname);
    if (solved.url.searchParams.has('gate_erro')) throw gateError('callback recusado');
    const magnet = extractMagnet(decodeEntities(solved.html));
    if (!magnet || !isValidMagnetUri(magnet)) throw gateError('magnet válido ausente');
    return magnet;
  } catch (error) {
    if (signal.aborted) throw gateAbortError(signal);
    if (error instanceof BludvAdGateError) throw error;
    throw gateError('falha na resolução');
  } finally { await transport.destroy(); }
}

/** Cache e inFlight únicos: provider, crawl e resolver importam este módulo. */
export async function resolveGateMagnet(gateUrl: string, postUrl: string, options: GateOptions = {}): Promise<string> {
  if (!isGateUrl(gateUrl, postUrl)) throw gateError('botão inválido');
  if (options.signal?.aborted) throw gateAbortError(options.signal);
  const gate = new URL(gateUrl, postUrl);
  const key = gate.href;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.magnet;
  cache.delete(key);
  const timeout = duration(options.timeoutMs ?? process.env.BLUDV_GATE_TIMEOUT_MS, 120_000);
  let entry = inFlight.get(key);
  if (!entry) {
    if (inFlight.size >= MAX_QUEUED + 1) throw gateError('fila cheia');
    const controller = new AbortController();
    const deadline = now + timeout;
    const timer = setTimeout(() => controller.abort(new DOMException('', 'TimeoutError')), timeout);
    const promise = (async () => {
      const release = await acquire(controller.signal);
      try {
        const magnet = await runGate(gate, options, deadline, controller.signal);
        if (controller.signal.aborted) throw gateAbortError(controller.signal);
        for (const [cachedKey, value] of cache) if (value.expires <= Date.now()) cache.delete(cachedKey);
        while (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
        cache.set(key, { magnet, expires: Date.now() + CACHE_MS });
        return magnet;
      } finally { release(); }
    })().finally(() => { clearTimeout(timer); inFlight.delete(key); });
    entry = { promise, controller, waiters: 0 };
    inFlight.set(key, entry);
  }
  if (entry.waiters >= MAX_WAITERS) throw gateError('consumidores demais');
  entry.waiters++;
  const caller = new AbortController();
  const timer = setTimeout(() => caller.abort(new DOMException('', 'TimeoutError')), timeout);
  const signal = AbortSignal.any([caller.signal, entry.controller.signal, ...(options.signal ? [options.signal] : [])]);
  try { return await withinSignal(entry.promise, signal); }
  finally {
    clearTimeout(timer);
    entry.waiters--;
    // Cancelar um consumidor não derruba os demais. Sem interessados, não
    // continuamos gastando rede nem publicamos resultado tardio no cache.
    if (!entry.waiters) entry.controller.abort();
  }
}

export function prefetchGateMagnet(gateUrl: string, postUrl: string, options?: GateOptions): void {
  // O aquecimento é oportunista: o FlareSolverr atende uma requisição por vez.
  // Haveria backlog se o prefetch entrasse na fila — o play (que tem um
  // consumidor esperando) sempre tem prioridade sobre o fundo. Sem slack, o
  // botão é simplesmente pulado nesta rodada; a busca seguinte tenta de novo.
  if (active || queue.length || inFlight.size) return;
  // Mesma admissão e deduplicação do play; falha não envenena o cache nem a busca.
  void resolveGateMagnet(gateUrl, postUrl, options).catch(() => {});
}
