// Ponte do Node com o worker NATIVO do Chupim (`adom-server::autofetch`), que
// vive na API administrativa do gateway em loopback (`127.0.0.1:8711`, a mesma
// URL/token do `stream-store.ts`).
//
// A admin publica `GET /autofetch` e `POST /autofetch/{config,pause,drain,
// suppressed-drain}`. O worker nasce DESLIGADO (`enabled:false`,
// `phase:"prepared"`, dreno respondendo `effect:"none"`) e só passa a consumir
// com `AUTOFETCH_WORKER=on`: ligado, quem EXECUTA o Chupim é ele (o corpo TS do
// runner saiu na leva B4) e esta ponte serve ao painel. O único caminho de
// execução que ainda mora no Node é o dreno da fila represada (`sup:`) com o
// worker desligado — quem decide o fallback é quem chama: daqui só sai estado.
//
// Contrato (igual ao `harvest-native`): o token vai SEMPRE no header
// (`x-indexer-test-token`, o mesmo da admin) e nunca na URL; prazo curto; e
// `null` = a admin não respondeu (rede, prazo ou backoff), `{ok:false}` = a
// admin respondeu recusando. Nada aqui lança: o caminho do painel nunca pode
// derrubar `/dashboard-status.json` nem `/dashboard-action.json`.
import config from '../config.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

/** Estado de `GET /autofetch` (espelho de `AutofetchStatus` do Rust). */
export type AutofetchStatus = {
  /** `false` enquanto o worker não executa (fase A/B do corte). */
  enabled: boolean;
  /** `prepared` | `unavailable` | o nome da fase viva do worker. */
  phase: string;
  paused: boolean;
  /** Chaves vivas na fila (`autofetch:v3:q:`), medidas na hidratação do boot. */
  queueDepth: number;
  /** Lotes de recheck persistidos (`autofetch:v3:lot:`). */
  lots: number;
  inflight: boolean;
  intervalMs: number;
};

/** Resposta das rotas de comando da admin. */
export type AutofetchResult = {
  ok: boolean;
  /** Estado efetivo devolvido por `config`/`pause`. */
  status?: AutofetchStatus;
  /** `none` = o worker existe e não toca em nada (fase A/B). */
  effect?: string;
  phase?: string;
  operation?: string;
  drained?: number;
  /** Recusa do gateway (texto dele; nunca carrega credencial). */
  error?: string;
};

/** Mesmo limiar do `harvest-native`: duas falhas seguidas sossegam a ponte. */
const SEQUENTIAL_FAILURES_BEFORE_BACKOFF = 2;
const BACKOFF_LOG_INTERVAL_MS = 30_000;

let failures = 0;
let blockedUntil = 0;
let lastBackoffLogAt = 0;

function settings() {
  return config.streamStore;
}

function available(now = Date.now()): boolean {
  return now >= blockedUntil;
}

function baseUrl(): string {
  return String(settings().url || '').replace(/\/+$/, '');
}

function token(): string {
  return settings().token || config.jackett.testToken || '';
}

function noteFailure(where: string): void {
  failures += 1;
  metrics.count('autofetch.bridge.errors');
  if (failures < SEQUENTIAL_FAILURES_BEFORE_BACKOFF) return;
  const backoff = Math.max(0, Number(settings().backoffMs) || 0);
  if (backoff <= 0 || Date.now() < blockedUntil) return;
  blockedUntil = Date.now() + backoff;
  metrics.count('autofetch.bridge.backoff');
  // O painel pode bater a cada poll: um log por janela basta.
  const now = Date.now();
  if (now - lastBackoffLogAt >= BACKOFF_LOG_INTERVAL_MS) {
    lastBackoffLogAt = now;
    log.warn(
      `[autofetch] ${where} falhou; pausando a ponte com a admin do Chupim por ` +
      `${Math.round(backoff / 1000)}s`,
    );
  }
}

function noteSuccess(): void {
  failures = 0;
  blockedUntil = 0;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** Erro de HTTP da admin: o corpo é o `{ok:false, error}` do Rust. */
class AdminHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown> | null) {
    super(`HTTP ${status}`);
    this.name = 'AdminHttpError';
  }
}

async function request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<unknown> {
  const opts = settings();
  const headers: Record<string, string> = {
    'x-indexer-test-token': token(),
    accept: 'application/json',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(Math.max(1, Number(opts.timeoutMs) || 2000))
    : undefined;
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const body = json && typeof json === 'object' ? json as Record<string, unknown> : null;
    throw new AdminHttpError(res.status, body);
  }
  return json;
}

/** Normaliza o `status` da admin. `null` quando o corpo não traz o objeto. */
function readStatus(raw: unknown): AutofetchStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const status = (raw as { status?: unknown }).status;
  if (!status || typeof status !== 'object') return null;
  const s = status as Record<string, unknown>;
  return {
    enabled: s.enabled === true,
    phase: String(s.phase || ''),
    paused: s.paused === true,
    queueDepth: Number(s.queueDepth) || 0,
    lots: Number(s.lots) || 0,
    inflight: s.inflight === true,
    intervalMs: Number(s.intervalMs) || 0,
  };
}

/**
 * Comando na admin. `null` = não houve resposta utilizável (rede, prazo,
 * backoff, corpo ilegível); `{ok:false}` = a admin respondeu recusando.
 */
async function command(path: string, body: unknown, where: string): Promise<AutofetchResult | null> {
  if (!available()) return null;
  try {
    const raw = await request(path, { method: 'POST', body });
    noteSuccess();
    const payload = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const out: AutofetchResult = { ok: payload.ok === true };
    const status = readStatus(payload);
    if (status) out.status = status;
    if (typeof payload.effect === 'string') out.effect = payload.effect;
    if (typeof payload.phase === 'string') out.phase = payload.phase;
    if (typeof payload.operation === 'string') out.operation = payload.operation;
    if (Number.isFinite(Number(payload.drained))) out.drained = Number(payload.drained);
    if (out.ok === false) out.error = String(payload.error || 'admin_recusou');
    return out;
  } catch (err) {
    if (err instanceof AdminHttpError) {
      // A admin respondeu: é recusa informada, não ponte caída (sem backoff).
      noteSuccess();
      metrics.count('autofetch.bridge.refused');
      const error = String((err.body?.error as string) || `HTTP ${err.status}`);
      log.warn(`[autofetch] admin recusou ${where} (${err.status}): ${error}`);
      return { ok: false, error };
    }
    noteFailure(where);
    metrics.count(isTimeout(err) ? 'autofetch.bridge.timeouts' : 'autofetch.bridge.offline');
    log.info(`[autofetch] admin não respondeu a ${where}: ${log.errorMessage(err)}`);
    return null;
  }
}

/** Estado do worker nativo. `null` = admin fora (ou sem o contrato). */
export async function fetchAutofetchStatus(): Promise<AutofetchStatus | null> {
  if (!available()) return null;
  try {
    const status = readStatus(await request('/autofetch', { method: 'GET' }));
    noteSuccess();
    return status;
  } catch (err) {
    noteFailure('status');
    metrics.count(isTimeout(err) ? 'autofetch.bridge.timeouts' : 'autofetch.bridge.offline');
    return null;
  }
}

/**
 * Aplica `paused`/`intervalMs` na config do worker. É o ÚNICO par que a admin
 * aceita (`deny_unknown_fields`): o resto do overlay do Chupim é do Node.
 */
export function setAutofetchConfig(patch: { paused?: boolean; intervalMs?: number }): Promise<AutofetchResult | null> {
  return command('/autofetch/config', patch, 'config');
}

/** Pausa/retoma o worker e devolve o estado efetivo dele. */
export function pauseAutofetch(paused: boolean): Promise<AutofetchResult | null> {
  return command('/autofetch/pause', { paused: paused === true }, 'pause');
}

/** Dreno do worker. Na fase A/B responde `effect:"none"` e não toca na fila. */
export function drainAutofetch(): Promise<AutofetchResult | null> {
  return command('/autofetch/drain', {}, 'drain');
}

/**
 * Dreno da fila de remoções represadas do worker. DESTRUTIVA: o gateway exige o
 * `{"confirm": true}` daqui E a credencial destrutiva (`STREAM_STORE_ADMIN_TOKEN`
 * ou `DEBRID_INTERNAL_TOKEN`, a mesma precedência do `token()` acima). O knob
 * `DEBRID_REMOVE_BY_ID` governa só o dreno AUTOMÁTICO do laço, não esta rota.
 */
export function drainSuppressedAutofetch(): Promise<AutofetchResult | null> {
  return command('/autofetch/suppressed-drain', { confirm: true }, 'suppressed-drain');
}

/**
 * O gateway EXECUTOU o comando? `{ok:true, effect:'none'}` é o worker da fase
 * A/B: respondeu, mas não fez nada. Só isso libera o Node de fazer o trabalho.
 */
export function autofetchEffectApplied(result: AutofetchResult | null): boolean {
  return result?.ok === true && result.effect !== 'none';
}

/** Só testes: esquece falhas/backoff do processo. */
export function resetAutofetchBridgeForTests(): void {
  failures = 0;
  blockedUntil = 0;
  lastBackoffLogAt = 0;
}
