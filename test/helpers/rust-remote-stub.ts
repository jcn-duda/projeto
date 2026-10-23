/**
 * Peças comuns dos testes do adaptador que fala com a 8710 (`rust-remote.ts`).
 *
 * `withPremiumize` abre o runtime do usuário, porque o adaptador remoto é
 * montado por `debrid.current()` dentro do `runtime.run` — como numa requisição.
 */
import * as runtime from '../../src/runtime.js';
import * as metrics from '../../src/utils/metrics.js';

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

export { abortDelay, errorCode, errorMessage, hasHash, unreachableCount, withPremiumize };
