/**
 * Peças comuns dos testes do adaptador que fala com a 8710 (`rust-remote.ts`).
 *
 * `withPremiumize` abre o runtime do usuário, porque o adaptador remoto é
 * montado por `debrid.current()` dentro do `runtime.run` — como numa requisição.
 */
import * as runtime from '../../src/runtime.js';
import * as metrics from '../../src/utils/metrics.js';
import { BY_ID } from '../../src/debrid/registry.js';
import { isAuthError, isQuotaError, isRateLimitError } from '../../src/debrid/common.js';

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function hasHash(result: Set<string> | { cached: Set<string> }, hash: string): boolean {
  return result instanceof Set ? result.has(hash) : result.cached.has(hash);
}

/** Delta, não reset: o contador é global e outros testes do processo acumulam. */
function unreachableCount(): number {
  return metrics.snapshot().counters['rust.debrid.check.unreachable'] || 0;
}

/**
 * `AbortSignal.timeout` não expõe a duração (o símbolo interno só diz que
 * há prazo). O abort é o relógio: ~1,5s cabe; os 6s do DEBRID_TIMEOUT_MS não.
 */
function abortDelay(signal: AbortSignal | undefined, ceilingMs: number): Promise<number> {
  if (!signal) return Promise.reject(new Error('fetch sem AbortSignal'));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`signal não abortou em ${ceilingMs}ms`)), ceilingMs);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(Date.now() - started); }, { once: true });
  });
}

function withPremiumize<T>(fn: () => T, apiKey = 'k'): T {
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: apiKey };
  return runtime.run({ opts }, fn);
}

/**
 * Dublê da 8710 só para `/debrid/account`: responde com o CORPO TS do adaptador
 * cru (`BY_ID`), e o `fetch` do próprio teste faz o papel do provedor. Serve aos
 * testes do verificador de conta, que medem a regra sobre o mesmo mock de API de
 * antes; a ponte real não roda na suíte (a 8710 é pinada numa porta fechada).
 * Devolve null quando a URL não é essa rota, para o mock seguir o fluxo normal.
 */
async function bridgeAccountReply(url: string, init: RequestInit | undefined): Promise<Response | null> {
  const base = process.env.DEBRID_INTERNAL_URL || 'http://127.0.0.1:8710';
  if (!url.startsWith(base) || !url.endsWith('/debrid/account')) return null;
  const body = JSON.parse(String(init?.body ?? '{}')) as { service?: string; apiKey?: string };
  const adapter = body.service ? BY_ID.get(body.service) : undefined;
  if (!adapter?.accountStatus || !body.apiKey) {
    return new Response(JSON.stringify({ error: 'service_not_ported' }), { status: 501 });
  }
  try {
    const json = await adapter.accountStatus(body.apiKey);
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    const status = isQuotaError(err) ? 402 : isAuthError(err) ? 403 : isRateLimitError(err) ? 429 : 502;
    const kind = status === 402 ? 'quota' : status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'other';
    return new Response(JSON.stringify({ kind, message: errorMessage(err) }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/**
 * Roda `run` com o dublê da conta por cima do fetch atual (o mock de API do
 * teste). O fetch volta ao mock ao sair, mesmo se `run` lançar.
 */
async function viaAccountBridge<T>(run: () => T | Promise<T>): Promise<T> {
  const mocked = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => (await bridgeAccountReply(String(url), init)) ?? mocked(url, init)) as unknown as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = mocked;
  }
}

export { abortDelay, bridgeAccountReply, errorCode, errorMessage, hasHash, unreachableCount, viaAccountBridge, withPremiumize };
