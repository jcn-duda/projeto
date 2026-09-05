// Portões de decisão do Chupim (autofetch), extraídos do runner para caber a
// instrumentação sem estourar a catraca. Dois papéis:
//
// 1. `classifyEnqueue` — decide QUAL portão fechou, na ORDEM EXATA dos
//    `return` de enqueueAutofetch. As checagens têm efeito (acquire, vaga da
//    busca, orçamento, refresh do gate) e entram como closures injetadas pelo
//    runner — o módulo é síncrono e sem rede, como o caminho de hoje.
// 2. `noteSkip` — contador (`autofetch.skip.<motivo>`) + registro no trace.
//
// A tabela de rollback reproduz EXATAMENTE o que cada `return` liberava hoje,
// com UMA exceção decidida (H2, 2026-09-01): o portão `marker` passou a
// liberar o hold recém-criado — produção mostrou o marcador bloqueando a
// retentativa dentro da janela, e o hold extra só
// estendia a proteção da limpeza para um hash órfão do recheck/restart.
// `in-flight` segue retendo o hold de propósito: o MESMO hash está em voo
// agora, e soltá-lo reabriria o hash à limpeza no meio do download.
import type { Stream } from '../../types/domain.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import autofetchLive from '../utils/autofetch-live.js';
import * as autofetchTrace from '../utils/autofetch-trace.js';
import type { DebridAdapter } from '../../types/domain.js';

/** Motivo pelo qual um candidato não foi enfileirado nesta busca. */
export type SkipReason =
  | 'paused'
  | 'dead'
  | 'already-cached'
  | 'marker'
  | 'in-flight'
  | 'search-slot-busy'
  | 'account-gate'
  | 'budget';

/** Checagens do enqueueAutofetch, injetadas na ordem exata dos portões. */
export interface EnqueueGates {
  isPaused(): boolean;
  isDead(): boolean;
  isCached(): boolean;
  markerActive(): boolean;
  tryLock(): boolean;
  trySlot(): boolean;
  accountBlocked(): boolean;
  tryBudget(): boolean;
}

/** Ordem EXATA dos portões de enqueueAutofetch — não reordenar. */
export function classifyEnqueue(gates: EnqueueGates): SkipReason | null {
  if (gates.isPaused()) return 'paused';
  if (gates.isDead()) return 'dead';
  if (gates.isCached()) return 'already-cached';
  if (gates.markerActive()) return 'marker';
  if (!gates.tryLock()) return 'in-flight';
  if (!gates.trySlot()) return 'search-slot-busy';
  if (gates.accountBlocked()) return 'account-gate';
  if (!gates.tryBudget()) return 'budget';
  return null;
}

type RollbackAction = 'lock' | 'slot' | 'hold';

/** O que cada desistência precisa liberar, na ordem dos returns de hoje. */
export const ENQUEUE_ROLLBACK: Record<SkipReason, RollbackAction[]> = {
  paused: ['hold'],
  dead: ['hold'],
  'already-cached': ['hold'],
  // marker: o hold recém-criado pela seleção desta busca não serve para nada —
  // o enqueue foi barrado pelo marcador do enqueue ANTERIOR, e retê-lo só
  // estenderia a proteção da limpeza para um hash que o recheck (ou o restart)
  // deixou órfão. O download antigo (se ainda vivo) segue protegido pelo hold
  // do enqueue original até o recheck resolvê-lo. Correção H2 (2026-09-01):
  // produção mostrou marker bloqueando retentativas sem lote vivo — o marcador
  // morre com o torrent no settle expirado (autofetch-runner).
  marker: ['hold'],
  // in-flight: o lock está em voo — o MESMO hash está sendo enfileirado agora;
  // soltar o hold aqui reabriria o hash à limpeza no meio do download.
  'in-flight': [],
  'search-slot-busy': ['lock', 'hold'],
  'account-gate': ['lock', 'slot', 'hold'],
  budget: ['lock', 'slot', 'hold'],
};

const skipCounts = new Map<string, number>();

function skipCountsSnapshot(): Record<string, number> {
  return Object.fromEntries([...skipCounts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function labelOf(stream: Stream | null | undefined): string {
  const value = stream as { title?: unknown; name?: unknown } | null | undefined;
  return String(value?.title || value?.name || '').split('\n')[0];
}

/**
 * Registra uma desistência: contador sempre (frequência no /metrics.json e no
 * painel), trace em ring quando o kill-switch permite. `stream` pode faltar
 * nas desistências de lista (sem candidato) — o registro fica sem hash12.
 */
function noteSkip(reason: string, stream: Stream | null | undefined, adapterId: string, pool = ''): void {
  const r = String(reason || 'unknown');
  metrics.count(`autofetch.skip.${r}`);
  skipCounts.set(r, (skipCounts.get(r) || 0) + 1);
  const raw = stream as { _br?: unknown; _dubbed?: unknown; _quality?: unknown; infoHash?: string } | null | undefined;
  autofetchTrace.note({
    adapter: adapterId,
    pool,
    reason: r,
    label: labelOf(stream),
    br: Boolean(raw?._br),
    dubbed: Boolean(raw?._dubbed),
    quality: raw?._quality != null ? String(raw._quality) : '',
    hash12: raw?.infoHash ? autofetchTrace.hash12(String(raw.infoHash)) : '',
  });
}

function clearSkips(): void {
  skipCounts.clear();
  autofetchTrace.clear();
}

/**
 * Warn do gate UMA vez por transição, não por candidato × busca: com a conta
 * cheia toda busca é gateada, e o log virava spam. A métrica continua
 * contando sempre; só o log silencia dentro da janela (reaproveita o refresh
 * do memo do gate, ~15 min).
 */
const lastGatedWarnAt = new Map<string, number>();

function warnAccountGated(adapter: DebridAdapter, account: string) {
  metrics.count('autofetch.account-gated');
  const key = `${adapter.id}:${account}`;
  const last = lastGatedWarnAt.get(key) || 0;
  if (Date.now() - last < autofetchLive.effective().autoFetchPauseRefreshMs) return;
  lastGatedWarnAt.set(key, Date.now());
  log.warn(
    `[autofetch] ${adapter.label} com conta cheia — nenhum download enfileirado; ` +
    'a varredura automática (DEBRID_SWEEP_UNDUBBED*) remove o excesso respeitando o acervo; ' +
    'o painel /dashboard mostra a ocupação',
  );
}

export { skipCountsSnapshot, noteSkip, clearSkips, warnAccountGated };
