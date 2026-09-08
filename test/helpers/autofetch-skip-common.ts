// Instrumentação compartilhada da desistência do Chupim (extraída de
// autofetch-skip-trace.test.ts na divisão estrutural dos arquivos acima de
// 400 linhas): cada portão do enqueueAutofetch conta
// `autofetch.skip.<motivo>` e registra no trace (hash anonimizado).
import * as runtime from '../../src/runtime.js';
import * as autofetch from '../../src/providers/autofetch.js';
import * as autofetchLive from '../../src/utils/autofetch-live.js';
import * as metrics from '../../src/utils/metrics.js';
import debrid from '../../src/debrid/index.js';
import { accountScope } from '../../src/utils/request-key.js';
import { enqueueAutofetch } from '../../src/providers/autofetch-runner.js';
import { clearSkips } from '../../src/providers/autofetch-gates.js';
import * as autofetchTrace from '../../src/utils/autofetch-trace.js';
import type { DebridAdapter } from '../../types/domain.js';

process.env.CACHE_PERSIST = 'false';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Drena microtareas/setImmediate — usado com mock.timers. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
// Hash próprio evita marker/lock de um teste poluir o seguinte.
export const H1 = 'a'.repeat(40);
export const H2 = 'b'.repeat(40);
export const H3 = 'c'.repeat(40);
export const H4 = 'd'.repeat(40);
export const H5 = 'e'.repeat(40);
export const H6 = 'f'.repeat(40);
export const H7 = '0'.repeat(40);
export const H8 = '1'.repeat(40);
export const H9 = '2'.repeat(40);
export const API_KEY = 'chave-integrada';

export const pmAdapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
export const originalEnqueue = pmAdapter.enqueue;
// accountScope é determinística (sha256 da chave): const de import, sem estado
// compartilhado — cada arquivo de teste roda no próprio processo.
export const account = accountScope(API_KEY);

export const brDub = (h: string, extra: Record<string, unknown> = {}) => ({
  infoHash: h,
  name: 'Coringa Dublado 1080p',
  title: 'Coringa (2019) Dublado 1080p',
  _br: true,
  _dubbed: true,
  _quality: '1080p',
  ...extra,
});

export const userOpts = (extra: Record<string, unknown> = {}) => ({
  ...runtime.defaults(),
  debridService: 'premiumize',
  debridApiKey: API_KEY,
  ...extra,
});

/** Enfileira um candidato BR direto, como o passe parcial/tardio faría. */
export async function runEnqueue(h: string, opts: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  const { cached: cachedList, ...rest } = request;
  const cached = new Set((cachedList as string[]) || []);
  return runtime.run({ opts: userOpts(opts), encoded: 'cfg' }, () =>
    enqueueAutofetch(
      { stream: brDub(h) as any, account, pool: 'br' },
      { cached, searchKey: `busca-${h.slice(0, 6)}`, ...rest },
    ),
  );
}

export function delta(reason: string) {
  const key = `autofetch.skip.${reason}`;
  const before = metrics.snapshot().counters[key] || 0;
  return () => (metrics.snapshot().counters[key] || 0) - before;
}

export function lastReason() {
  const recent = autofetchTrace.lastSkips(1);
  return recent.length ? recent[0].reason : null;
}

/** Estado limpo entre testes: pause, gate de conta, orçamento e rastro de skip. */
export function resetSkipState(): void {
  autofetchLive.reset();
  autofetch.resetAccountGate();
  autofetch.resetBudget();
  clearSkips();
}

/** Dublê padrão do enqueue do Premiumize para os before() dos arquivos. */
export async function stubEnqueue(_apiKey: string, infoHash: string): Promise<boolean> {
  void _apiKey;
  return infoHash.length > 0;
}
