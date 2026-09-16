// Modelo puro do bloco de indexadores da aba Saúde. Lê o contrato real do
// bloco `indexers` do /dashboard-status.json — `{ id, label, isBr, status,
// breaker, flagSlow, source }` — e devolve linhas + resumo estáveis para a
// view montar os chips. Sem DOM: só dado → dado, testável direto.
//
// A tradução estado → variante é a MESMA do kit (`statusVariant`), para o
// estado não ganhar duas leituras visuais divergentes. `kit.ts` é componente,
// não view: importar a função pura não acopla o modelo à montagem de painel.
import { statusVariant, type BadgeVariant } from './kit.js';

/** Estado do indexer; `null` = nunca medido (sem `status` ou fora do TTL). */
export type IndexerState = 'online' | 'slow' | 'degraded' | 'offline' | null;

const INDEXER_STATES = new Set(['online', 'slow', 'degraded', 'offline']);

const STATE_LABELS: Record<string, string> = {
  online: 'ONLINE',
  slow: 'LENTO',
  degraded: 'DEGRADADO',
  offline: 'OFFLINE',
};

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeState(value: unknown): IndexerState {
  const state = String(value ?? '');
  return INDEXER_STATES.has(state) ? (state as IndexerState) : null;
}

/** Rótulo FIEL do estado. `null` sai "DESCONHECIDO" — nunca "OFFLINE", que
 * afirmaria uma falha não medida (indexer sem amostra no TTL, ou catálogo
 * vindo do fallback do .env). */
export function indexerStateLabel(state: IndexerState): string {
  return state ? STATE_LABELS[state] : 'DESCONHECIDO';
}

export function indexerStateVariant(state: IndexerState): BadgeVariant {
  return statusVariant(state);
}

export interface SaudeIndexerRow {
  id: string;
  label: string;
  isBr: boolean;
  state: IndexerState;
  stateLabel: string;
  variant: BadgeVariant;
  ms: number | null;
  breakerOpen: boolean;
  breakerState: string | null;
  cooldownRemainingMs: number | null;
  checkedAt: string | null;
}

function normalizeRow(raw: unknown): SaudeIndexerRow | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const id = String(obj.id ?? '').trim();
  if (!id) return null;
  const status = asObject(obj.status);
  const breaker = asObject(obj.breaker);
  const state = normalizeState(status?.state ?? obj.state);
  return {
    id,
    label: String(obj.label ?? id) || id,
    isBr: obj.isBr === true,
    state,
    stateLabel: indexerStateLabel(state),
    variant: indexerStateVariant(state),
    ms: finiteNumber(status?.ms ?? obj.ms),
    breakerOpen: breaker?.tripped === true,
    breakerState: breaker?.state != null ? String(breaker.state) : null,
    cooldownRemainingMs: finiteNumber(breaker?.cooldownRemainingMs),
    checkedAt: status?.checkedAt != null ? String(status.checkedAt) : null,
  };
}

/** Faixa de ordenação: falha primeiro, desconhecido POR ÚLTIMO. */
function stateRank(state: IndexerState): number {
  if (state === 'offline') return 0;
  if (state === 'slow' || state === 'degraded') return 1;
  if (state === 'online') return 2;
  return 3;
}

/** Falha primeiro (offline → lento/degradado → online), desconhecido no fim.
 * Empate resolvido por id, determinístico. */
export function sortIndexerRows(rows: readonly SaudeIndexerRow[]): SaudeIndexerRow[] {
  return [...rows].sort((a, b) => {
    const diff = stateRank(a.state) - stateRank(b.state);
    return diff !== 0 ? diff : compareId(a.id, b.id);
  });
}

export function indexerRows(indexers: unknown): SaudeIndexerRow[] {
  if (!Array.isArray(indexers)) return [];
  const out: SaudeIndexerRow[] = [];
  for (const raw of indexers) {
    const row = normalizeRow(raw);
    if (row) out.push(row);
  }
  return sortIndexerRows(out);
}

export interface SaudeIndexerSummary {
  total: number;
  online: number;
  slow: number;
  degraded: number;
  offline: number;
  unknown: number;
  /** slow + degraded + offline: o que merece atenção do operador. `degraded`
   * CONTA como atenção, mas a linha do chip mantém o rótulo fiel. */
  attention: number;
  breakerOpen: number;
  brOffline: number;
}

export function indexerSummary(rows: readonly SaudeIndexerRow[]): SaudeIndexerSummary {
  let online = 0; let slow = 0; let degraded = 0; let offline = 0; let unknown = 0;
  let breakerOpen = 0; let brOffline = 0;
  for (const row of rows) {
    if (row.state === 'online') online += 1;
    else if (row.state === 'slow') slow += 1;
    else if (row.state === 'degraded') degraded += 1;
    else if (row.state === 'offline') offline += 1;
    else unknown += 1;
    if (row.breakerOpen) breakerOpen += 1;
    if (row.isBr && row.state === 'offline') brOffline += 1;
  }
  return {
    total: rows.length, online, slow, degraded, offline, unknown,
    attention: slow + degraded + offline, breakerOpen, brOffline,
  };
}

/** Badge do card: offline manda (err), depois atenção (warn), senão ok. Sem
 * catálogo é `neutral` — "sem dados" não é saúde.
 *
 * Honestidade do desconhecido: `online === 0` depois de offline/atenção
 * zerados significa que TODO o catálogo caiu no desconhecido (nunca medido /
 * fora do TTL). "TODOS ONLINE" ali afirmaria saúde que ninguém mediu — o badge
 * vira neutro. Com alguma medição positiva, o card pode dizer OK, mas NÃO
 * "TODOS": o desconhecido não vira saúde por omissão. Só o catálogo inteiro
 * medido e online merece o "TODOS ONLINE". */
export function indexerCardBadge(summary: SaudeIndexerSummary): { text: string; variant: BadgeVariant } {
  if (summary.total === 0) return { text: 'SEM CATÁLOGO', variant: 'neutral' };
  if (summary.offline > 0) return { text: `${summary.offline} OFFLINE`, variant: 'err' };
  if (summary.attention > 0) return { text: `${summary.attention} EM ATENÇÃO`, variant: 'warn' };
  if (summary.online === 0) return { text: 'SEM MEDIÇÃO', variant: 'neutral' };
  if (summary.unknown > 0) return { text: `${summary.online} ONLINE`, variant: 'ok' };
  return { text: 'TODOS ONLINE', variant: 'ok' };
}
