// Status dos indexadores medido pelo GATEWAY (busca nativa) → `indexer-status`.
//
// Desde a Fase 5 a busca roda no `adom-server` e o `jackett.ts`, que chamava
// `indexerStatus.record` a cada consulta, saiu: o painel passou a mostrar todo
// indexador "desconhecido" e o alerta de "Indexador BR offline" parou. O
// gateway guarda a última consulta de cada indexer (`status_board` no
// `adom-sources`) e a expõe em `GET /indexers/status` na admin (8711). Esta
// ponte lê o placar e grava cada amostra NOVA pelo `record` de sempre — estado,
// TTL, métricas e alerta continuam numa régua só.
//
// O circuito por indexer também vem de lá (`breakerFor`): o Node não tem mais
// breaker próprio. Falha da ponte nunca derruba nada: o painel segue com o que
// já tinha (ou "desconhecido").
import config from '../config.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as indexerStatus from './indexer-status.js';

export type NativeIndexerBreaker = {
  tripped: boolean;
  state: string;
  failStreak: number;
  cooldownRemainingMs: number;
};

type NativeSample = { id: string; ok: boolean; ms: number; results: number; budgetMs: number; at: number };
type NativeRow = { id: string; sample?: NativeSample | null; breaker?: NativeIndexerBreaker | null };

const POLL_MS = 30_000;
/** Última amostra já gravada por indexer: a mesma consulta não conta duas vezes. */
const ingestedAt = new Map<string, number>();
const breakers = new Map<string, NativeIndexerBreaker>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<boolean> | null = null;

function baseUrl(): string {
  return String(config.streamStore.url || '').replace(/\/+$/, '');
}

function token(): string {
  return config.streamStore.token || config.jackett.testToken || '';
}

/** Grava o que o placar trouxe de novo. Exportado para o teste sem rede. */
export function ingestNativeIndexerStatus(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  let recorded = 0;
  for (const raw of rows as NativeRow[]) {
    const id = String(raw?.id || '').trim().toLowerCase();
    if (!id) continue;
    if (raw.breaker && typeof raw.breaker === 'object') breakers.set(id, { ...raw.breaker });
    const sample = raw.sample;
    if (!sample || !Number.isFinite(sample.at)) continue;
    if ((ingestedAt.get(id) || 0) >= sample.at) continue;
    ingestedAt.set(id, sample.at);
    indexerStatus.record(id, {
      ok: sample.ok === true,
      ms: Number.isFinite(sample.ms) ? sample.ms : null,
      budgetMs: sample.budgetMs,
      results: Number(sample.results) || 0,
    }, sample.at);
    recorded += 1;
  }
  return recorded;
}

/** Circuito do indexer segundo o gateway; `null` = nunca medido. */
export function breakerFor(id: string): NativeIndexerBreaker | null {
  return breakers.get(String(id || '').trim().toLowerCase()) || null;
}

/** Lê o placar do gateway. `false` = ponte fora (o painel segue com o que tinha). */
export function refreshNativeIndexerStatus(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch(`${baseUrl()}/indexers/status`, {
        headers: { 'x-indexer-test-token': token(), accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, Number(config.streamStore.timeoutMs) || 2000)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { indexers?: unknown };
      ingestNativeIndexerStatus(json?.indexers);
      return true;
    } catch (err) {
      metrics.count('indexer.status.bridge_errors');
      log.debug(`[jackett] status nativo dos indexadores indisponível: ${log.errorMessage(err)}`);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Poll em fundo: o alerta de BR offline não pode esperar alguém abrir o painel. */
export function startIndexerStatusPolling(intervalMs = POLL_MS): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => { void refreshNativeIndexerStatus(); }, intervalMs);
  pollTimer.unref?.();
  void refreshNativeIndexerStatus();
}

export function stopIndexerStatusPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export function resetIndexerStatusBridgeForTests(): void {
  ingestedAt.clear();
  breakers.clear();
  inFlight = null;
}
