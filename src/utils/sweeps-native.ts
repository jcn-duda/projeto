// Ponte do Node com as varreduras NATIVAS da AllDebrid (`adom-server::al_sweeps`,
// API administrativa do gateway em loopback, porta 8711).
//
// O agendador é do Rust: quem calcula `due`, guarda o anti-reentrada e monta o
// plano é o gateway. Ao Node sobrou o que o painel precisa — ler o snapshot
// (`GET /sweeps`) e pedir UMA varredura fora do relógio (`POST /sweeps/run`).
// Nada aqui agenda varredura nem toca a conta.
//
// Contrato BEST-EFFORT do `harvest-native.ts` (o padrão de ponte desta casa),
// SEM compartilhar estado com ele: falha de rede vira "sem efeito" + backoff
// curto e nada pode derrubar busca, play ou boot. O bloco do
// `/dashboard-status.json` é síncrono e lê o espelho (`snapshot`); quem o
// atualiza é o poll de fundo (`startSweepsPolling`) ou um `refreshSweepsStatus()`.
import config from '../config.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

/** Os quatro tipos canônicos do vocabulário Rust (`SweepKind`). */
export type NativeSweepKind = 'sweepDead' | 'sweepUndubbed' | 'reconcile' | 'revalidate';

/** Modo EFETIVO (o corpo nunca eleva): o gateway decide pelo gate dele. */
export type NativeSweepMode = 'off' | 'read_only' | 'apply';

export const NATIVE_SWEEP_KINDS: readonly NativeSweepKind[] = ['sweepDead', 'sweepUndubbed', 'reconcile', 'revalidate'];

export type NativeSweepKindCounters = {
  runs: number; planned: number; swept: number; failed: number; blocked: number; calls: number;
};

export type NativeSweepCounters = {
  runs: number; manualRuns: number; reentered: number; notDue: number; missing: number;
  planned: number; swept: number;
  /** Atalho de `byKind.sweepUndubbed.swept`. */
  sweptUndubbed: number;
  failed: number; blocked: number; calls: number;
  byKind: Record<NativeSweepKind, NativeSweepKindCounters>;
  reasons: Record<string, number>;
};

export type NativeSweepOutcome = {
  kind: NativeSweepKind; applied: boolean; planned: number; swept: number; failed: number;
  blocked: number; stopped: string | null; calls: number; reasons: Record<string, number>;
};

export type NativeSweepLast = {
  at: number; manual: boolean; outcomes: NativeSweepOutcome[]; missing: NativeSweepKind[];
};

/** Snapshot de `GET /sweeps` (nomes camelCase, iguais ao contrato Rust). */
export type NativeSweepStatus = {
  ok: boolean; enabled: boolean; scheduled: boolean; mode: NativeSweepMode;
  intervalMs: number; running: boolean;
  startedAt: number | null; lastTickAt: number | null; nextDueAt: number | null;
  disabledReason: string | null;
  counters: NativeSweepCounters;
  /** `null` quando o processo não registrou nenhuma rodada (nada inventado). */
  last: NativeSweepLast | null;
  /** Quando ESTA ponte tirou a foto (ISO). */
  pulledAt: string;
};

/**
 * Resposta de `POST /sweeps/run`. Contagem é `null` quando o gateway não a
 * mandou: recusa não vira zero, senão o toast anunciaria "0 removido" para uma
 * varredura que nunca rodou.
 */
export type NativeSweepRun = {
  ok: boolean; ran: boolean; kind: NativeSweepKind; mode: NativeSweepMode | null;
  applied: boolean | null; planned: number | null; swept: number | null;
  varridos: number | null; falhas: number | null; failed: number | null;
  blocked: number | null; calls: number | null; stopped: string | null;
  reasons: Record<string, number>; at: number | null;
  /** Outro tick nativo em voo (409 `reentered`): não é falha, é espera. */
  busy?: boolean;
  /** O prazo da ponte venceu com a varredura ainda rodando no gateway. */
  timedOut?: boolean;
  /** A varredura continua: o cartão acompanha o status até o próximo poll. */
  pending?: boolean;
  reason?: string;
  error?: string;
};

const SEQUENTIAL_FAILURES_BEFORE_BACKOFF = 2;

let failures = 0;
let blockedUntil = 0;
const pending = new Set<Promise<unknown>>();
let snapshot: NativeSweepStatus | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function settings() { return config.streamStore; }

function available(now = Date.now()): boolean { return now >= blockedUntil; }
function baseUrl(): string { return String(settings().url || '').replace(/\/+$/, ''); }
function token(): string { return settings().token || config.jackett.testToken || ''; }

function noteFailure(where: string): void {
  failures += 1;
  metrics.count('sweeps.bridge.errors');
  const backoff = Math.max(0, Number(settings().backoffMs) || 0);
  if (failures < SEQUENTIAL_FAILURES_BEFORE_BACKOFF || backoff <= 0 || Date.now() < blockedUntil) return;
  blockedUntil = Date.now() + backoff;
  metrics.count('sweeps.bridge.backoff');
  log.warn(
    `[sweeps] ${where} falhou; pausando a ponte com as varreduras nativas por ` +
    `${Math.round(backoff / 1000)}s`,
  );
}

function noteSuccess(): void {
  failures = 0;
  blockedUntil = 0;
}

/** Resposta crua: aqui o STATUS importa (409/503 têm significado de contrato). */
type RawResponse = { status: number; body: unknown };

async function request(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawResponse> {
  const opts = settings();
  const headers: Record<string, string> = {
    'x-indexer-test-token': token(),
    accept: 'application/json',
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(Math.max(1, Number(init.timeoutMs ?? opts.timeoutMs) || 2000))
    : undefined;
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method || 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal,
  });
  const body = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  return { status: Number(res.status) || 0, body };
}

function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  return promise;
}

/** `sweep_dead`/`sweep-undubbed`/`SWEEPDEAD` → o nome canônico; lixo → `null`. */
export function normalizeSweepKind(value: unknown): NativeSweepKind | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const compact = raw.replace(/[_-]/g, '').toLowerCase();
  return NATIVE_SWEEP_KINDS.find((kind) => kind.toLowerCase() === compact) || null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalNum(value: unknown): number | null {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Mapa de motivos (`{ready: 5, preexisting: 2}`) — só contagens medidas. */
function reasonsOf(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(asRecord(value)).map(([key, raw]) => [key, num(raw)]));
}

function kindCounters(raw: unknown): NativeSweepKindCounters {
  const e = asRecord(raw);
  return {
    runs: num(e.runs), planned: num(e.planned), swept: num(e.swept),
    failed: num(e.failed), blocked: num(e.blocked), calls: num(e.calls),
  };
}

/**
 * Contadores: número ausente vira zero (é contador de processo, todos nascem em
 * zero). O resto do snapshot segue o oposto — `last`, `startedAt` e `lastTickAt`
 * ausentes ficam `null`, senão o painel mostraria "rodou agora" sem ter rodado.
 */
function countersOf(raw: unknown): NativeSweepCounters {
  const e = asRecord(raw);
  const rawByKind = asRecord(e.byKind);
  const byKind = Object.fromEntries(
    NATIVE_SWEEP_KINDS.map((kind) => [kind, kindCounters(rawByKind[kind])]),
  ) as Record<NativeSweepKind, NativeSweepKindCounters>;
  return {
    runs: num(e.runs), manualRuns: num(e.manualRuns), reentered: num(e.reentered),
    notDue: num(e.notDue), missing: num(e.missing), planned: num(e.planned), swept: num(e.swept),
    // Atalho do contrato: quando ausente, é o mesmo valor medido em `byKind`.
    sweptUndubbed: e.sweptUndubbed === undefined ? byKind.sweepUndubbed.swept : num(e.sweptUndubbed),
    failed: num(e.failed), blocked: num(e.blocked), calls: num(e.calls),
    byKind, reasons: reasonsOf(e.reasons),
  };
}

function modeOf(value: unknown): NativeSweepMode { return value === 'apply' || value === 'read_only' || value === 'off' ? value : 'off'; }

function outcomesOf(raw: unknown): NativeSweepOutcome[] {
  const out: NativeSweepOutcome[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const e = asRecord(row);
    const kind = normalizeSweepKind(e.kind);
    if (!kind) continue;
    out.push({
      kind, applied: e.applied === true, planned: num(e.planned), swept: num(e.swept),
      failed: num(e.failed), blocked: num(e.blocked), calls: num(e.calls),
      stopped: e.stopped == null ? null : String(e.stopped), reasons: reasonsOf(e.reasons),
    });
  }
  return out;
}

function lastOf(raw: unknown): NativeSweepLast | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = asRecord(raw);
  const missing: NativeSweepKind[] = [];
  for (const row of Array.isArray(e.missing) ? e.missing : []) {
    const kind = normalizeSweepKind(row);
    if (kind) missing.push(kind);
  }
  return { at: num(e.at), manual: e.manual === true, outcomes: outcomesOf(e.outcomes), missing };
}

/** Último estado conhecido (sync — o bloco do painel não pode esperar rede). */
export function sweepsStatusSnapshot(): NativeSweepStatus | null { return snapshot; }

/** Busca o estado no gateway. Nunca lança; em falha mantém o snapshot anterior. */
export function refreshSweepsStatus(): Promise<NativeSweepStatus | null> {
  if (!available()) return Promise.resolve(snapshot);
  return track((async () => {
    try {
      const res = await request('/sweeps', { method: 'GET' });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const e = asRecord(res.body);
      noteSuccess();
      snapshot = {
        ok: e.ok === true, enabled: e.enabled === true, scheduled: e.scheduled === true,
        mode: modeOf(e.mode), intervalMs: num(e.intervalMs), running: e.running === true,
        startedAt: optionalNum(e.startedAt), lastTickAt: optionalNum(e.lastTickAt),
        nextDueAt: optionalNum(e.nextDueAt),
        disabledReason: e.disabledReason == null ? null : String(e.disabledReason),
        counters: countersOf(e.counters), last: lastOf(e.last),
        pulledAt: new Date().toISOString(),
      };
      return snapshot;
    } catch (err) {
      noteFailure('status');
      metrics.count('sweeps.bridge.status_errors');
      log.warn(`[sweeps] status das varreduras nativas falhou: ${log.errorMessage(err)}`);
      return snapshot;
    }
  })());
}

/** O `AbortSignal.timeout` rejeita com `TimeoutError` (DOMException). */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function emptyRun(kind: NativeSweepKind, over: Partial<NativeSweepRun> = {}): NativeSweepRun {
  const blank: NativeSweepRun = {
    ok: false, ran: false, kind, mode: null, applied: null, planned: null, swept: null,
    varridos: null, falhas: null, failed: null, blocked: null, calls: null, stopped: null,
    reasons: {}, at: null,
  };
  return { ...blank, ...over };
}

function runOf(kind: NativeSweepKind, body: Record<string, unknown>): NativeSweepRun {
  // `varridos`/`falhas` são os nomes que o toast do painel lê desde antes da rota
  // nativa; `swept`/`failed` são os canônicos. A ponte repassa os DOIS e só
  // deriva um do outro quando o gateway manda apenas um deles.
  const swept = optionalNum(body.swept);
  const failed = optionalNum(body.failed);
  return {
    ok: true, ran: body.ran !== false, kind: normalizeSweepKind(body.kind) || kind,
    mode: body.mode == null ? null : modeOf(body.mode), applied: body.applied === true,
    planned: optionalNum(body.planned), swept,
    varridos: optionalNum(body.varridos) ?? swept, falhas: optionalNum(body.falhas) ?? failed, failed,
    blocked: optionalNum(body.blocked), calls: optionalNum(body.calls),
    stopped: body.stopped == null ? null : String(body.stopped),
    reasons: reasonsOf(body.reasons), at: optionalNum(body.at),
  };
}

/**
 * Pedido de UMA varredura fora do relógio. O `kind` é validado AQUI (tipo
 * desconhecido não sai para a rede) e o prazo é o long das varreduras: a rota só
 * responde depois de varrer, e os 2 s das rotas curtas cortariam o pedido no
 * meio — vencê-lo não pausa a ponte, porque a varredura segue no gateway.
 */
export function runNativeSweep(kind: NativeSweepKind | string): Promise<NativeSweepRun> {
  const target = normalizeSweepKind(kind);
  if (!target) {
    metrics.count('sweeps.bridge.invalid_kind');
    return Promise.resolve(emptyRun('sweepDead', { reason: 'invalid_kind', error: 'tipo de varredura inválido' }));
  }
  if (!available()) {
    return Promise.resolve(emptyRun(target, {
      reason: 'bridge-backoff', error: 'ponte com as varreduras nativas em espera depois de falhas seguidas',
    }));
  }
  return track((async () => {
    try {
      const res = await request('/sweeps/run', {
        body: { kind: target, confirm: true },
        timeoutMs: settings().sweepTimeoutMs,
      });
      const body = asRecord(res.body);
      const reason = String(body.reason || '');
      if (res.status === 200 && body.ok !== false) {
        noteSuccess();
        metrics.count('sweeps.bridge.ran');
        return runOf(target, body);
      }
      if (res.status === 409) {
        // 409 é RESPOSTA do gateway, não falha de ponte: nada de backoff. O
        // `reentered` só pede espera; os outros explicam o desligamento.
        noteSuccess();
        if (reason === 'reentered' || body.running === true) {
          metrics.count('sweeps.bridge.busy');
          return emptyRun(target, {
            busy: true, reason: 'reentered', error: 'outra varredura nativa está em voo; acompanhe o status',
          });
        }
        metrics.count(`sweeps.bridge.disabled.${reason || 'unknown'}`);
        return emptyRun(target, {
          reason: reason || 'sweeps_disabled', error: String(body.error || 'varreduras nativas desligadas no gateway'),
        });
      }
      if (res.status === 503) {
        // Sem conta do operador ou sem cliente HTTP no gateway: a ponte fica
        // doente de verdade (não é recusa de modo).
        noteFailure('run');
        metrics.count('sweeps.bridge.unavailable');
        return emptyRun(target, {
          reason: reason || 'sweeps_unavailable', error: String(body.error || 'varreduras nativas indisponíveis no gateway'),
        });
      }
      metrics.count('sweeps.bridge.rejected');
      log.warn(`[sweeps] varredura nativa recusada: HTTP ${res.status} (${reason || 'sem motivo'})`);
      return emptyRun(target, {
        reason: reason || (body.error == null ? `http-${res.status}` : String(body.error)),
        error: String(body.error || `varredura nativa recusada (HTTP ${res.status})`),
      });
    } catch (err) {
      if (isTimeout(err)) {
        metrics.count('sweeps.bridge.run_timeout');
        log.info('[sweeps] varredura nativa segue no gateway depois do prazo da ponte');
        return emptyRun(target, { ok: true, ran: true, timedOut: true, pending: true });
      }
      noteFailure('run');
      log.warn(`[sweeps] varredura nativa falhou: ${log.errorMessage(err)}`);
      return emptyRun(target, {
        reason: 'bridge-error', error: 'falha de rede falando com as varreduras nativas do gateway',
      });
    }
  })());
}

/**
 * Arma o poll do status (idempotente). O painel lê o espelho sync; o timer é o
 * único que fala com o gateway fora das ações. 30 s é o ritmo do colhedor.
 */
export function startSweepsPolling(intervalMs = 30000): void {
  if (pollTimer) return;
  const every = Number.isFinite(intervalMs) && intervalMs >= 5000 ? intervalMs : 30000;
  void refreshSweepsStatus();
  pollTimer = setInterval(() => void refreshSweepsStatus(), every);
  // Não segura o processo no shutdown (mesma razão dos timers do painel).
  if (typeof pollTimer === 'object' && pollTimer) (pollTimer as { unref?: () => void }).unref?.();
}

export function stopSweepsPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Drena os pedidos em voo (testes e shutdown). */
export async function flushPendingSweeps(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled(Array.from(pending));
}

/** Só testes: esquece backoff/snapshot do processo. */
export function resetSweepsBridgeForTests(): void {
  failures = 0;
  blockedUntil = 0;
  snapshot = null;
  stopSweepsPolling();
}
