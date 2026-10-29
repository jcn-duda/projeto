// Ponte do Node com o warmer NATIVO do Real-Debrid (`adom-server::rd_warmer`,
// API administrativa do gateway em loopback, 8711).
//
// A Fase 1 do porte tira o timer do Node do caminho quando o gateway responde:
// fila, sonda e teto horário passam a ser do Rust. Ao Node sobra o painel — ler
// o snapshot (`GET /rd-warm`) e pedir pausa/retomada/drenagem. Se a rota não
// existir (gateway antigo), o snapshot fica `null` e o chamador segue com o
// warmer local: esta ponte nunca inicia timer nem toca a conta.
//
// DUAS credenciais, de propósito: o `GET` aceita o token próprio ou, sem ele, o
// de DIAGNÓSTICO (`JACKETT_TEST_TOKEN`, o mesmo de `/metrics.json`); o `POST`
// destrutivo usa SÓ o próprio (`STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN`).
// Sem ele a ponte nem vai à rede: token de diagnóstico não pausa nem drena a
// fila do operador.
//
// Contrato BEST-EFFORT (o padrão das pontes desta casa): falha de rede vira
// "sem efeito" + backoff curto e nada pode derrubar busca, play ou boot. O bloco
// do `/debrid-status.json` é síncrono e lê o espelho (`snapshot`); quem o
// atualiza é o poll de fundo (`startRdWarmPolling`) ou um `refreshRdWarmStatus()`.
import config from '../config.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

/** Origem da credencial do warmer como o painel já publica. */
export type NativeRdWarmAccountSource = 'panel' | 'env' | 'sessao' | 'none';

/** Contadores de processo do warmer nativo (todos nascem em zero). */
export type NativeRdWarmCounters = {
  enqueued: number; skipped: number; droppedFull: number; droppedNoKey: number;
  probes: number; hits: number; misses: number; blocked: number; stopped: number;
};

/** Snapshot de `GET /rd-warm` (nomes camelCase, iguais ao contrato Rust). */
export type NativeRdWarmStatus = {
  ok: boolean; enabled: boolean; paused: boolean; inFlight: boolean;
  queueDepth: number; queueMax: number; batch: number; maxPerHour: number; queriesThisHour: number;
  intervalMs: number; idleWindowMs: number;
  /** `null` quando o processo ainda não deu um tick (nada inventado). */
  lastTickAt: number | null;
  accountSource: NativeRdWarmAccountSource;
  counters: NativeRdWarmCounters;
  /** Quando ESTA ponte tirou a foto (ISO). */
  pulledAt: string;
};

/**
 * Resultado de pausa/retomada/drenagem. `unavailable` só aparece quando o
 * snapshot nativo é `null` — o chamador então decide cair no warmer local.
 * Com snapshot presente, qualquer recusa é definitiva: dois donos da mesma
 * fila sondariam a mesma conta.
 */
export type NativeRdWarmAction = {
  ok: boolean; paused?: boolean; processed?: number | null; queueRemaining?: number | null;
  reason?: string; error?: string; unavailable?: boolean;
};

/** O que o `status()` local do `rd-warmer` publica (mínimo estrutural). */
export type LocalRdWarmStatus = {
  enabled: boolean; queueDepth: number; lastTickAt: number | null; paused: boolean;
  processedLastHour: number; accountSource: NativeRdWarmAccountSource;
};

/** Formato de `rd.warm` no `/debrid-status.json`. `source` só existe no nativo. */
export type RdWarmDiagnosticStatus = LocalRdWarmStatus & {
  source?: 'rust';
  counters?: NativeRdWarmCounters;
};

const SEQUENTIAL_FAILURES_BEFORE_BACKOFF = 2;
/** Sonda de boot: curta, para não atrasar o arranque do Node. */
const PROBE_TIMEOUT_CAP_MS = 1500;

let failures = 0;
let blockedUntil = 0;
const pending = new Set<Promise<unknown>>();
let snapshot: NativeRdWarmStatus | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function settings() { return config.streamStore; }

function available(now = Date.now()): boolean { return now >= blockedUntil; }
function baseUrl(): string { return String(settings().url || '').replace(/\/+$/, ''); }
/** `GET`: o token próprio e, sem ele, o de diagnóstico (o gateway aceita os dois). */
function statusToken(): string { return settings().token || config.jackett.testToken || ''; }
/** `POST`: SÓ o token destrutivo — o de diagnóstico nunca mexe na fila. */
function destructiveToken(): string { return settings().token || ''; }

function noteFailure(where: string): void {
  failures += 1;
  metrics.count('rdwarm.bridge.errors');
  const backoff = Math.max(0, Number(settings().backoffMs) || 0);
  if (failures < SEQUENTIAL_FAILURES_BEFORE_BACKOFF || backoff <= 0 || Date.now() < blockedUntil) return;
  blockedUntil = Date.now() + backoff;
  metrics.count('rdwarm.bridge.backoff');
  log.warn(
    `[rdwarm] ${where} falhou; pausando a ponte com o warmer nativo por ` +
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
  init: { method?: string; body?: unknown; timeoutMs?: number; token?: string } = {},
): Promise<RawResponse> {
  const opts = settings();
  const headers: Record<string, string> = {
    'x-indexer-test-token': init.token ?? statusToken(),
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

function accountSourceOf(value: unknown): NativeRdWarmAccountSource {
  return value === 'panel' || value === 'env' || value === 'sessao' || value === 'none' ? value : 'none';
}

/** Contadores ausentes viram zero: é contador de processo, não medição pontual. */
function countersOf(raw: unknown): NativeRdWarmCounters {
  const e = asRecord(raw);
  return {
    enqueued: num(e.enqueued), skipped: num(e.skipped), droppedFull: num(e.droppedFull), droppedNoKey: num(e.droppedNoKey),
    probes: num(e.probes), hits: num(e.hits), misses: num(e.misses), blocked: num(e.blocked), stopped: num(e.stopped),
  };
}

/** Último estado conhecido (sync — o bloco do painel não pode esperar rede). */
export function rdWarmStatusSnapshot(): NativeRdWarmStatus | null { return snapshot; }

/** Resultado interno: o snapshot e se a rota respondeu `200 + ok:true`. */
type PullResult = { snapshot: NativeRdWarmStatus | null; responded: boolean };

/**
 * Corpo do refresh. Nunca lança; em falha mantém o snapshot anterior. O
 * `responded` é o que a sonda de boot usa: snapshot antigo não prova gateway
 * vivo, e é isso que decide quem fica com o timer.
 */
async function pull(timeoutMs?: number): Promise<PullResult> {
  if (!available()) return { snapshot, responded: false };
  return track((async (): Promise<PullResult> => {
    try {
      const res = await request('/rd-warm', { method: 'GET', timeoutMs });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const e = asRecord(res.body);
      noteSuccess();
      snapshot = {
        ok: e.ok === true,
        enabled: e.enabled === true,
        paused: e.paused === true,
        queueDepth: num(e.queueDepth),
        queueMax: num(e.queueMax),
        batch: num(e.batch),
        maxPerHour: num(e.maxPerHour),
        queriesThisHour: num(e.queriesThisHour),
        intervalMs: num(e.intervalMs),
        idleWindowMs: num(e.idleWindowMs),
        inFlight: e.inFlight === true,
        lastTickAt: optionalNum(e.lastTickAt),
        accountSource: accountSourceOf(e.accountSource),
        counters: countersOf(e.counters),
        pulledAt: new Date().toISOString(),
      };
      return { snapshot, responded: e.ok === true };
    } catch (err) {
      noteFailure('status');
      metrics.count('rdwarm.bridge.status_errors');
      log.warn(`[rdwarm] status do warmer nativo falhou: ${log.errorMessage(err)}`);
      return { snapshot, responded: false };
    }
  })());
}

/** Busca o estado no gateway. Nunca lança; em falha mantém o snapshot anterior. */
export async function refreshRdWarmStatus(): Promise<NativeRdWarmStatus | null> {
  return (await pull()).snapshot;
}

/**
 * Sonda de boot: `true` quando a rota existe e respondeu `200 {ok:true}` —
 * inclusive `enabled:false`, que significa "o gateway é o dono, mas está
 * desligado". Nesse caso o Node NÃO liga o timer local: dois donos sondariam a
 * mesma conta. Prazo curto para não atrasar o arranque.
 */
export async function probeNativeRdWarm(): Promise<boolean> {
  const timeoutMs = Math.max(1, Math.min(PROBE_TIMEOUT_CAP_MS, Number(settings().timeoutMs) || PROBE_TIMEOUT_CAP_MS));
  const result = await pull(timeoutMs);
  return result.responded;
}

/** O `AbortSignal.timeout` rejeita com `TimeoutError` (DOMException). */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Pré-condições das ações. Snapshot `null` não toca a rede (o chamador decide o
 * fallback local); com snapshot, a credencial destrutiva é obrigatória e NÃO há
 * fallback: token de diagnóstico não pausa nem drena a fila do operador.
 */
function actionBlocked(): NativeRdWarmAction | null {
  if (snapshot === null) {
    return { ok: false, reason: 'native-unavailable', unavailable: true };
  }
  if (!destructiveToken()) {
    metrics.count('rdwarm.bridge.no_admin_token');
    return {
      ok: false,
      reason: 'missing_admin_token',
      error: 'ação do warmer nativo exige STREAM_STORE_ADMIN_TOKEN no gateway: o token de diagnóstico não mexe na fila',
    };
  }
  if (!available()) {
    return { ok: false, reason: 'bridge-backoff', error: 'ponte com o warmer nativo em espera depois de falhas seguidas' };
  }
  return null;
}

type ActionReply = { body: Record<string, unknown> } | { failure: NativeRdWarmAction };

/** POST de ação: 200 aplica; 401/403/409/503 viram recusa com motivo do corpo. */
async function postAction(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<ActionReply> {
  try {
    const res = await request(path, { body, timeoutMs, token: destructiveToken() });
    const payload = asRecord(res.body);
    if (res.status === 200 && payload.ok !== false) {
      noteSuccess();
      return { body: payload };
    }
    const reason = String(payload.reason || '');
    if (res.status === 503) {
      // Sem conta do operador ou sem cliente HTTP no gateway: a ponte fica
      // doente de verdade (não é recusa de modo).
      noteFailure(path);
      metrics.count('rdwarm.bridge.unavailable');
    } else {
      // 401/403/409 são RESPOSTAS do gateway: nada de backoff.
      noteSuccess();
      metrics.count('rdwarm.bridge.rejected');
    }
    log.warn(`[rdwarm] ${path} recusado: HTTP ${res.status} (${reason || 'sem motivo'})`);
    return {
      failure: {
        ok: false,
        reason: reason || `http-${res.status}`,
        error: String(payload.error || `ação do warmer nativo recusada (HTTP ${res.status})`),
      },
    };
  } catch (err) {
    if (isTimeout(err)) {
      // A ação pode ter sido aplicada; o próximo poll mostra o estado real. Não
      // é falha de rede, então não pausa a ponte.
      metrics.count('rdwarm.bridge.timeout');
      log.info(`[rdwarm] ${path} segue no gateway depois do prazo da ponte`);
      return {
        failure: { ok: false, reason: 'timeout', error: 'o gateway não confirmou a ação dentro do prazo da ponte' },
      };
    }
    noteFailure(path);
    log.warn(`[rdwarm] ${path} falhou: ${log.errorMessage(err)}`);
    return {
      failure: { ok: false, reason: 'bridge-error', error: 'falha de rede falando com o warmer nativo do gateway' },
    };
  }
}

/** Pausa o warmer nativo. Devolve o estado efetivo que o gateway confirmou. */
export async function pauseNativeRdWarm(): Promise<NativeRdWarmAction> {
  const blocked = actionBlocked();
  if (blocked) return blocked;
  const reply = await postAction('/rd-warm/pause', {}, settings().timeoutMs);
  if ('failure' in reply) return reply.failure;
  const paused = reply.body.paused === true;
  if (snapshot) snapshot.paused = paused;
  metrics.count('rdwarm.bridge.pause');
  return { ok: true, paused };
}

/** Retoma o warmer nativo. */
export async function resumeNativeRdWarm(): Promise<NativeRdWarmAction> {
  const blocked = actionBlocked();
  if (blocked) return blocked;
  const reply = await postAction('/rd-warm/resume', {}, settings().timeoutMs);
  if ('failure' in reply) return reply.failure;
  const paused = reply.body.paused === true;
  if (snapshot) snapshot.paused = paused;
  metrics.count('rdwarm.bridge.resume');
  return { ok: true, paused };
}

/**
 * Drena à mão até `max`. O gateway só responde DEPOIS de drenar, então o prazo
 * é o longo (`rdWarmDrainTimeoutMs`); vencê-lo NÃO pausa a ponte — a drenagem
 * segue no gateway e o próximo poll mostra a fila andando.
 */
export async function drainNativeRdWarm(max?: number): Promise<NativeRdWarmAction> {
  const blocked = actionBlocked();
  if (blocked) return blocked;
  const body: Record<string, unknown> = { confirm: true };
  if (typeof max === 'number' && Number.isFinite(max) && max > 0) body.max = Math.trunc(max);
  const reply = await postAction('/rd-warm/drain', body, settings().rdWarmDrainTimeoutMs);
  if ('failure' in reply) return reply.failure;
  const processed = optionalNum(reply.body.processed);
  const queueRemaining = optionalNum(reply.body.queueRemaining);
  if (snapshot && queueRemaining !== null) snapshot.queueDepth = queueRemaining;
  metrics.count('rdwarm.bridge.drain');
  return { ok: true, processed, queueRemaining };
}

/**
 * Mapeia o snapshot nativo para o formato que `/debrid-status.json` já publica
 * em `rd.warm`. Sem snapshot, delega ao warmer local (gateway antigo/sem rota).
 * O `source:'rust'` é o que o painel usa para saber quem é o dono.
 */
export function nativeWarmStatus(services: { rdWarmer: { status(): LocalRdWarmStatus } }): RdWarmDiagnosticStatus {
  const snap = snapshot;
  if (!snap) return services.rdWarmer.status();
  return {
    enabled: snap.enabled,
    queueDepth: snap.queueDepth,
    lastTickAt: snap.lastTickAt,
    paused: snap.paused,
    processedLastHour: snap.queriesThisHour,
    accountSource: snap.accountSource,
    source: 'rust',
    counters: { ...snap.counters },
  };
}

/**
 * Arma o poll do status (idempotente). O painel lê o espelho sync; o timer é o
 * único que fala com o gateway fora das ações. 30 s é o ritmo das outras pontes.
 */
export function startRdWarmPolling(intervalMs = 30000): void {
  if (pollTimer) return;
  const every = Number.isFinite(intervalMs) && intervalMs >= 5000 ? intervalMs : 30000;
  void refreshRdWarmStatus();
  pollTimer = setInterval(() => void refreshRdWarmStatus(), every);
  // Não segura o processo no shutdown.
  if (typeof pollTimer === 'object' && pollTimer) (pollTimer as { unref?: () => void }).unref?.();
}

export function stopRdWarmPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Só testes: esquece backoff/snapshot do processo e desarma o timer. */
export function resetRdWarmBridgeForTests(): void {
  failures = 0;
  blockedUntil = 0;
  snapshot = null;
  stopRdWarmPolling();
}
