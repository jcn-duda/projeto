// Ponte do Node com o colhedor NATIVO (`adom-server::harvest`, API
// administrativa do gateway em loopback).
//
// Desde a Fase 5 o colhedor roda no processo Rust: a fila `harvest:v1:q`, o
// dedupe de 12h, o balde horário (`harvest:v1:hour`) e a sonda dirigida são do
// gateway, que colhe com as MESMAS fontes nativas do `/stream` e grava no
// índice/banco nativos. O Node deixou de ser dono do namespace `harvest` — não
// escreve, não drena e não lê a fila do L2 (o L1 nasceria vazio e um flush
// sobrescreveria o trabalho do Rust).
//
// O que sobra aqui é o que o PAINEL precisa:
//   - ler o estado (`GET /harvest`) para o bloco do painel;
//   - pausar / drenar / limpar / configurar pelo painel.
//
// O `harvester_enqueue` da busca NÃO passa por aqui: o gateway o consome no
// próprio processo (`rust/crates/adom-server/src/harvest_effect.rs` — o salto
// pelo Node, que só o devolvia à admin 8711, saiu no corte). Se o efeito
// chegar ao Node (colhedor desligado), é aceito sem execução e contado em
// `nativeOnly` pela rota `/internal/search/effects`.
//
// Contrato BEST-EFFORT, igual ao `streams-store-native`: falha de rede/tempo
// vira "sem efeito" + backoff curto. Nenhuma dessas chamadas pode derrubar
// busca, play ou boot. O status é espelhado em memória (`snapshot`) porque o
// bloco do `/dashboard-status.json` é síncrono; quem atualiza é o poll de fundo
// (`startHarvestPolling`) ou um `refreshHarvestStatus()` explícito.
import config from '../config.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

/** Entrada da fila como o gateway devolve (espelho de `HarvestEntry` do Rust). */
export type NativeHarvestEntry = {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
  reason: string;
  enqueuedAt: number;
  priorityAt?: number;
  resumed?: boolean;
  brProbe?: boolean;
  fullBase?: boolean;
};

export type NativeHarvestLast = {
  imdbId: string;
  type: string;
  reason: string;
  ok: boolean;
  queries: number;
  at: number;
};

/** Snapshot de `GET /harvest` (nomes camelCase, iguais ao contrato Rust). */
export type NativeHarvestStatus = {
  ok: boolean;
  enabled: boolean;
  paused: boolean;
  intervalMs: number;
  maxPerHour: number;
  queriesThisHour: number;
  depth: number;
  inflight: boolean;
  preview: NativeHarvestEntry[];
  last: NativeHarvestLast[];
  counters: { drained: number; failed: number };
  store: string;
};

const SEQUENTIAL_FAILURES_BEFORE_BACKOFF = 2;

let failures = 0;
let blockedUntil = 0;
let snapshot: NativeHarvestStatus | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

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
  metrics.count('harvest.bridge.errors');
  if (failures >= SEQUENTIAL_FAILURES_BEFORE_BACKOFF) {
    const backoff = Math.max(0, Number(settings().backoffMs) || 0);
    if (backoff > 0 && Date.now() >= blockedUntil) {
      blockedUntil = Date.now() + backoff;
      metrics.count('harvest.bridge.backoff');
      log.warn(
        `[harvest] ${where} falhou; pausando a ponte com o colhedor nativo por ` +
        `${Math.round(backoff / 1000)}s`,
      );
    }
  }
}

function noteSuccess(): void {
  failures = 0;
  blockedUntil = 0;
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<unknown> {
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Último estado conhecido (sync — o bloco do painel não pode esperar rede). */
export function harvestStatusSnapshot(): NativeHarvestStatus | null {
  return snapshot;
}

/** `true` quando o último refresh trouxe um gateway vivo. */
export function harvestNativeOnline(): boolean {
  return snapshot?.ok === true && snapshot.enabled !== false;
}

/** Preview público: só campos do contrato. `fullIntent` nunca viaja. */
function publicPreview(raw: unknown): NativeHarvestEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const e = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    const out: NativeHarvestEntry = {
      imdbId: String(e.imdbId || ''),
      type: e.type === 'series' ? 'series' : 'movie',
      reason: String(e.reason || ''),
      enqueuedAt: Number(e.enqueuedAt) || 0,
    };
    if (Number.isFinite(Number(e.season))) out.season = Number(e.season);
    if (Number.isFinite(Number(e.episode))) out.episode = Number(e.episode);
    if (Number.isFinite(Number(e.priorityAt))) out.priorityAt = Number(e.priorityAt);
    if (e.resumed === true) out.resumed = true;
    if (e.brProbe === true) out.brProbe = true;
    if (e.fullBase === true) out.fullBase = true;
    return out;
  });
}

/** Busca o estado no gateway. Nunca lança; em falha mantém o snapshot anterior. */
export async function refreshHarvestStatus(): Promise<NativeHarvestStatus | null> {
  if (!available()) return snapshot;
  try {
    const json = (await request('/harvest', { method: 'GET' })) as NativeHarvestStatus;
    noteSuccess();
    snapshot = {
      ok: json?.ok === true,
      enabled: json?.enabled === true,
      paused: json?.paused === true,
      intervalMs: Number(json?.intervalMs) || 0,
      maxPerHour: Number(json?.maxPerHour) || 0,
      queriesThisHour: Number(json?.queriesThisHour) || 0,
      depth: Number(json?.depth) || 0,
      inflight: json?.inflight === true,
      preview: publicPreview(json?.preview),
      last: Array.isArray(json?.last) ? json.last : [],
      counters: {
        drained: Number(json?.counters?.drained) || 0,
        failed: Number(json?.counters?.failed) || 0,
      },
      store: String(json?.store || ''),
    };
    return snapshot;
  } catch (err) {
    noteFailure('status');
    metrics.count('harvest.bridge.status_errors');
    log.warn(`[harvest] status do colhedor nativo falhou: ${log.errorMessage(err)}`);
    return snapshot;
  }
}

/** Pausa/retoma o worker. Devolve o estado efetivo (ou `null` se a ponte caiu). */
export async function pauseNativeHarvest(paused: boolean): Promise<boolean | null> {
  if (!available()) return null;
  try {
    const json = (await request('/harvest/pause', { body: { paused: paused === true } })) as { paused?: unknown };
    noteSuccess();
    const value = json?.paused === true;
    if (snapshot) snapshot.paused = value;
    return value;
  } catch (err) {
    noteFailure('pause');
    log.warn(`[harvest] pause nativo falhou: ${log.errorMessage(err)}`);
    return null;
  }
}

/**
 * Empurra os overrides do painel (`harvesterLive.overrides()`) ao gateway, que
 * os aplica sobre o `.env` dele. `true` = aplicado; `false` = colhedor nativo
 * desligado; `null` = ponte fora. O disco (`cfg:v1:harvester`) segue sendo a
 * fonte do boot, então uma falha aqui só atrasa o efeito até o restart.
 */
export async function pushNativeHarvestConfig(overrides: Record<string, unknown>): Promise<boolean | null> {
  if (!available()) return null;
  try {
    const json = (await request('/harvest/config', { body: overrides })) as { applied?: unknown; paused?: unknown };
    noteSuccess();
    const applied = json?.applied === true;
    if (applied && snapshot) snapshot.paused = json?.paused === true;
    return applied;
  } catch (err) {
    noteFailure('config');
    log.warn(`[harvest] config nativa do colhedor falhou: ${log.errorMessage(err)}`);
    return null;
  }
}

export type NativeHarvestDrain = {
  drained: number;
  /** O prazo da ponte venceu com o gateway ainda drenando: não é falha. */
  timedOut: boolean;
};

/** O `AbortSignal.timeout` rejeita com `TimeoutError` (DOMException). */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Drena à mão até `max` obras. O gateway só responde DEPOIS de drenar, então
 * o pedido tem prazo próprio (`drainTimeoutMs`), e vencê-lo NÃO pausa a ponte:
 * o loop do gateway segue drenando, e pausar bloquearia os pedidos do painel
 * por 30 s (o "colhedor indisponível" falso do botão Drenar).
 */
export async function drainNativeHarvest(max = 5): Promise<NativeHarvestDrain> {
  if (!available()) return { drained: 0, timedOut: false };
  try {
    const json = (await request('/harvest/drain', {
      body: { max },
      timeoutMs: settings().drainTimeoutMs,
    })) as { drained?: unknown };
    noteSuccess();
    const drained = Number(json?.drained);
    return { drained: Number.isFinite(drained) && drained > 0 ? drained : 0, timedOut: false };
  } catch (err) {
    if (isTimeout(err)) {
      metrics.count('harvest.bridge.drain_timeout');
      log.info('[harvest] drain nativo segue no gateway depois do prazo da ponte');
      return { drained: 0, timedOut: true };
    }
    noteFailure('drain');
    log.warn(`[harvest] drain nativo falhou: ${log.errorMessage(err)}`);
    return { drained: 0, timedOut: false };
  }
}

/** Limpa a fila do colhedor nativo. Devolve quantas entradas saíram. */
export async function clearNativeHarvest(): Promise<number> {
  if (!available()) return 0;
  try {
    const json = (await request('/harvest/clear', { body: {} })) as { cleared?: unknown };
    noteSuccess();
    const cleared = Number(json?.cleared);
    return Number.isFinite(cleared) && cleared > 0 ? Math.floor(cleared) : 0;
  } catch (err) {
    noteFailure('clear');
    log.warn(`[harvest] clear nativo falhou: ${log.errorMessage(err)}`);
    return 0;
  }
}

/**
 * Arma o poll do estado (idempotente). O painel lê o espelho sync; o timer é o
 * único que fala com o gateway. Intervalo default 30s — o painel recarrega
 * sozinho e o status não precisa ser tempo real como o do crawl.
 */
export function startHarvestPolling(intervalMs = 30000): void {
  if (pollTimer) return;
  const every = Number.isFinite(intervalMs) && intervalMs >= 5000 ? intervalMs : 30000;
  void refreshHarvestStatus();
  pollTimer = setInterval(() => void refreshHarvestStatus(), every);
  // Não segura o processo no shutdown (mesma razão dos timers do painel).
  if (typeof pollTimer === 'object' && pollTimer && 'unref' in pollTimer) {
    (pollTimer as { unref?: () => void }).unref?.();
  }
}

export function stopHarvestPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

/** Só testes: esquece backoff/snapshot do processo. */
export function resetHarvestBridgeForTests(): void {
  failures = 0;
  blockedUntil = 0;
  snapshot = null;
  stopHarvestPolling();
}
