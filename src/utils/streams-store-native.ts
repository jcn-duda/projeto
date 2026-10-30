// Ponte do Node com o store NATIVO de `streams:v21` (`data/streams.db`).
//
// Desde o F4.4 o SWR do corte é do processo Rust. O Node continua dono do
// `/resolve`, do painel e do `/stream-trace.json`, e nos três precisa MEXER no
// store nativo — sem isso a invalidação por obra não alcançava a lista servida
// pelo gateway, o `clear-cache` deixava o SWR nativo intacto e o trace nascia
// vazio (dívida F4.4a).
//
// A superfície é a API administrativa do gateway (`adom-server::store_admin`):
// loopback + `X-Indexer-Test-Token`, NUNCA a 7000 pública. Este módulo é
// BEST-EFFORT por contrato: falha de rede/tempo vira "sem efeito" e um backoff
// curto, porque nenhuma dessas operações pode derrubar busca ou play. O
// caminho antigo (limpar só o L1 do Node) continua valendo sempre.
//
// Import de `config` só para endereço/token/backoff — nenhum ciclo: `config`
// não conhece este módulo.
import config from '../config.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

/** Forma da entrada que a API do Rust devolve no trace (só o que o Node usa). */
export type NativeStreamTrace = {
  ok: boolean;
  found: boolean;
  source?: string;
  cache?: { remainingS?: number; partial?: boolean; debridKnown?: boolean; stale?: boolean };
  trace?: unknown;
  searchMeta?: { names?: string[]; year?: number | null } | null;
  // 4.2(b) — o recompute offline é NATIVO: quando a entrada TEM lista mas NÃO
  // tem ledger, o gateway recomputa e devolve o `RecomputeOutcome` pronto (o
  // Node só repassa; `null` quando não dá para recomputar honestamente).
  recompute?: unknown;
  streams?: Array<{ name?: string | null; infoHash?: string | null }>;
};

export type NativeClearResult = {
  /** `false` = a ponte nem tentou (backoff, ou escopo fora do store nativo). */
  attempted: boolean;
  ok: boolean;
  removed: number;
  error?: string;
};

const SEQUENTIAL_FAILURES_BEFORE_BACKOFF = 2;

/**
 * Recusa HTTP da ponte, com o status e o `error` do corpo. Serve para separar
 * RECUSA (403/409: credencial ou `confirm` faltando) de falha de TRANSPORTE:
 * a primeira é configuração e não pode pôr a ponte em backoff — senão um
 * `clear` sem credencial derrubaria junto a invalidação por obra do `/resolve`.
 */
class NativeHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code ? `HTTP ${status} ${code}` : `HTTP ${status}`);
    this.name = 'NativeHttpError';
    this.status = status;
    this.code = code;
  }
}

let failures = 0;
let blockedUntil = 0;
let warnedMissingDestructive = false;
const pending = new Set<Promise<unknown>>();

function settings() {
  return config.streamStore;
}

/** Fora do backoff de falha (não existe mais interruptor por env). */
function available(now = Date.now()): boolean {
  return now >= blockedUntil;
}

function baseUrl(): string {
  return String(settings().url || '').replace(/\/+$/, '');
}

function token(): string {
  return settings().token || config.jackett.testToken || '';
}

/**
 * Credencial DESTRUTIVA — a MESMA precedência de `src/config/stream-store.ts`:
 * `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN`. O `JACKETT_TEST_TOKEN`
 * fica FORA de propósito: é o token de diagnóstico (o de `/metrics.json`) e o
 * gateway recusa com ele o que apaga (`403 streams_token_insufficient`).
 */
function destructiveToken(): string {
  return settings().token || '';
}

function noteFailure(where: string, err: unknown): void {
  failures += 1;
  metrics.count('stream.store.errors');
  // Só depois de DUAS falhas seguidas: um restart do gateway não pode congelar
  // a ponte logo na primeira tentativa.
  if (failures >= SEQUENTIAL_FAILURES_BEFORE_BACKOFF) {
    const backoff = Math.max(0, Number(settings().backoffMs) || 0);
    if (backoff > 0 && Date.now() >= blockedUntil) {
      blockedUntil = Date.now() + backoff;
      metrics.count('stream.store.backoff');
      log.warn(
        `[stream-store] ${where} falhou (${log.errorMessage(err)}); ` +
        `pausando a ponte com o streams.db por ${Math.round(backoff / 1000)}s ` +
        '(o L1 do Node continua funcionando)',
      );
    }
  }
}

function noteSuccess(): void {
  failures = 0;
  blockedUntil = 0;
}

/** Um fetch curto com token; devolve o JSON ou lança (quem chama decide). */
async function request(
  path: string,
  init: { method?: string; body?: unknown; destructive?: boolean } = {},
): Promise<unknown> {
  const opts = settings();
  const headers: Record<string, string> = {
    // Rota destrutiva: só a credencial que apaga. As outras seguem com o token
    // da superfície (que cai para o de diagnóstico).
    'x-indexer-test-token': init.destructive ? destructiveToken() : token(),
    accept: 'application/json',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(Math.max(1, Number(opts.timeoutMs) || 2000))
    : undefined;
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method || 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal,
  });
  if (!res.ok) {
    // O `error` do corpo é o motivo do gateway (`confirmation_required`, …):
    // vai para o painel em vez de um "HTTP 409" sem explicação.
    let code = '';
    try {
      const body = (await res.json()) as { error?: unknown } | null;
      code = typeof body?.error === 'string' ? body.error : '';
    } catch {
      code = ''; // corpo não-JSON: o status já basta
    }
    throw new NativeHttpError(res.status || 0, code);
  }
  return res.json();
}

/** Registra a promessa para o `flush` dos testes/encerramento. */
function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
}

/**
 * Invalida a lista pronta de UMA obra no store nativo — o único caminho vivo
 * de `invalidateStreamsForObra` (`src/utils/br-gap.ts`), que delegou para cá no
 * F4.2(c): o namespace `streams` é Rust-owned e o L1 do Node nasce vazio.
 * Fire-and-forget: o `/resolve` não espera, e o próximo `stream` que chegar
 * depois do DELETE já reconstrói.
 *
 * Devolve `true` quando o pedido foi enfileirado e `false` quando não havia o
 * que pedir (imdbId fora do contrato, ponte em backoff). Nunca é contagem de
 * entradas: o Node não tem mais esse número.
 */
export function invalidateNativeStreamsForObra(imdbId: string): boolean {
  const target = String(imdbId || '').trim().toLowerCase();
  if (!/^tt\d+$/.test(target) || !available()) return false;
  track(
    request('/streams/invalidate', { body: { imdbId: target } })
      .then((json) => {
        noteSuccess();
        const removed = Number((json as { removed?: unknown })?.removed);
        if (Number.isFinite(removed) && removed > 0) {
          metrics.count('stream.store.invalidated', removed);
        }
      })
      .catch((err) => noteFailure('invalidate por obra', err)),
  );
  return true;
}

/**
 * Limpa o store nativo: tudo (escopo global) ou só o escopo de uma instalação
 * (`suffix` = `:<streamsCacheScope>`, o MESMO sufixo das chaves nativas).
 *
 * A rota que zera o namespace exige as duas guardas do gateway: a credencial
 * DESTRUTIVA e `{"confirm":true}` — este módulo manda as duas, porque é o
 * código do operador, não uma requisição de terceiro. Sem a credencial não há
 * nem requisição (o gateway responderia 409) e o motivo volta no `error` do
 * painel. Nunca lança.
 */
export async function clearNativeStreams(options: { suffix?: string } = {}): Promise<NativeClearResult> {
  if (!available()) {
    return { attempted: false, ok: false, removed: 0, error: 'ponte em backoff após falhas' };
  }
  if (!destructiveToken()) {
    if (!warnedMissingDestructive) {
      warnedMissingDestructive = true;
      log.warn(
        '[stream-store] clear do streams.db sem credencial destrutiva ' +
        '(STREAM_STORE_ADMIN_TOKEN/DEBRID_INTERNAL_TOKEN); o token de diagnóstico não apaga',
      );
    }
    return {
      attempted: false,
      ok: false,
      removed: 0,
      error: 'sem credencial destrutiva (STREAM_STORE_ADMIN_TOKEN/DEBRID_INTERNAL_TOKEN)',
    };
  }
  try {
    const body = { confirm: true, ...(options.suffix ? { suffix: options.suffix } : {}) };
    const json = (await request('/streams/clear', { body, destructive: true })) as {
      removed?: unknown;
      entries?: unknown;
    };
    noteSuccess();
    const removed = Number(json?.removed);
    if (Number.isFinite(removed) && removed > 0) metrics.count('stream.store.cleared', removed);
    return { attempted: true, ok: true, removed: Number.isFinite(removed) ? removed : 0 };
  } catch (err) {
    // 403/409 são recusa de credencial/`confirm`, não queda do gateway: ficam
    // FORA do backoff para não congelar a invalidação por obra do `/resolve`.
    const refusal = err instanceof NativeHttpError && err.status < 500;
    if (!refusal) noteFailure('clear', err);
    const error = log.errorMessage(err);
    log.warn(`[stream-store] clear do streams.db falhou: ${error}`);
    return { attempted: true, ok: false, removed: 0, error };
  }
}

/** `clearNativeStreams` sem esperar (o 451 do play não pode segurar o cliente). */
export function clearNativeStreamsSoon(options: { suffix?: string } = {}): void {
  if (!available()) return;
  track(clearNativeStreams(options));
}

/**
 * Ledger + estado da entrada da obra no store nativo. `key` (a mesma
 * `streamsCacheKey` do Node) tenta a chave EXATA; o Rust cai para a build mais
 * recente da obra quando ela não existe. `null` = ponte fora do ar ou obra
 * ausente — quem chama segue o caminho antigo.
 */
export async function fetchNativeStreamTrace(
  type: string,
  id: string,
  key?: string,
): Promise<NativeStreamTrace | null> {
  if (!available()) return null;
  const query = new URLSearchParams({ type, id });
  if (key) query.set('key', key);
  try {
    const json = (await request(`/streams/trace?${query.toString()}`, { method: 'GET' })) as NativeStreamTrace;
    noteSuccess();
    if (!json || json.ok !== true) return null;
    if (json.found) metrics.count('stream.store.trace.hit');
    return json;
  } catch (err) {
    noteFailure('trace', err);
    return null;
  }
}

/** Aguarda as invalidações pendentes (testes e shutdown). */
export async function flushNativeStreamStores(): Promise<void> {
  // Uma rodada pode enfileirar outra (ex.: clear que dispara invalidates).
  for (let i = 0; i < 5 && pending.size > 0; i += 1) {
    await Promise.allSettled([...pending]);
  }
}

/** Estado do backoff (diagnóstico/painel). */
export function nativeStreamStoreStatus(): { available: boolean; failures: number; blockedUntil: number } {
  return { available: available(), failures, blockedUntil };
}

/**
 * Zera a memória do módulo (testes): backoff, contador de falhas e fila. Não
 * mexe em config — endereço/token continuam vindo do `config`.
 */
export function resetNativeStreamStore(): void {
  failures = 0;
  blockedUntil = 0;
  warnedMissingDestructive = false;
  pending.clear();
}
