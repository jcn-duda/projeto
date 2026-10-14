// Ledger observacional do Chupim (autofetch): cada portão que fecha — o motivo
// pelo qual um candidato NÃO foi enfileirado — fica registrado aqui, em ring de
// memória. O caso que motivou o módulo: um único stream BR nunca entrava em
// cache e o Chupim desistia em silêncio, num `return` mudo sem log nem métrica.
//
// Ao contrário do stream-trace (P5), NADA é gravado no cache: a entrada
// `streams` já existe e o trace viaja nela; aqui o anel é estado vivo do
// processo, exposto só pelo /dashboard-status.json via autofetchRunnerStatus.
//
// Regra de ouro (mesma do dropTrace): kill-switch desligado => return imediato,
// nenhum call site checa nada. O custo desligado é o de uma chamada de função.
import crypto from 'node:crypto';
import config from '../config.js';
import { sanitizeTraceLabel } from './stream-trace.js';

/** Um registro de desistência. NUNCA infoHash cru, searchKey, conta ou apiKey. */
export interface AutofetchTraceEntry {
  at: number;
  adapter: string;
  pool: string;
  reason: string;
  label: string;
  br: boolean;
  dubbed: boolean;
  quality: string;
  hash12: string;
}

const RING_MAX = 64;
const ring: AutofetchTraceEntry[] = [];

function traceEnabled(): boolean {
  return config.debrid.autoFetchTrace !== false;
}

/** hash12 = sha256(infoHash).slice(0,12) — mesmo padrão de autofetch-runner:689. */
function hash12(infoHash: string): string {
  return crypto.createHash('sha256').update(String(infoHash || '')).digest('hex').slice(0, 12);
}

function note(entry: Omit<AutofetchTraceEntry, 'at'>): void {
  if (!traceEnabled()) return;
  ring.push({
    at: Date.now(),
    adapter: String(entry.adapter || ''),
    pool: String(entry.pool || ''),
    reason: String(entry.reason || 'unknown'),
    label: sanitizeTraceLabel(String(entry.label || '')),
    br: Boolean(entry.br),
    dubbed: Boolean(entry.dubbed),
    quality: String(entry.quality || ''),
    hash12: String(entry.hash12 || ''),
  });
  if (ring.length > RING_MAX) ring.shift();
}

/** Cópia dos últimos `limit` registros; vazio quando o kill-switch está off. */
function lastSkips(limit = RING_MAX): AutofetchTraceEntry[] {
  if (!traceEnabled()) return [];
  const n = Math.max(1, Math.trunc(Number(limit) || RING_MAX));
  return ring.slice(-n).map((entry) => ({ ...entry }));
}

function clear(): void {
  ring.length = 0;
}

export { RING_MAX, traceEnabled, note, lastSkips, clear, hash12 };
