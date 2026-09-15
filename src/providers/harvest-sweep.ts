// Varredura pt-BR nos indexers GLOBAIS do colhedor, extraída do
// `harvest-worker.ts` para a catraca de linhas. O dublado titulado em PT mora
// em tracker global e a query em inglês não o encontra — sem esta varredura o
// índice ficava sistematicamente cego para a release que só ela acha.
//
// Divergência DE PROPÓSITO do caminho ao vivo: aqui o breaker é RESPEITADO
// (sem ignoreBreaker) — colheita de fundo não precisa acordar indexer
// recém-derrubado, o dublado raro espera o cooldown. Index-only ficam FORA
// (são consultados individualmente no laço do worker, com orçamento dedicado)
// e o modo dirigido da sonda não roda a varredura (ele já consulta a própria
// interseção individualmente).
import config from '../config.js';
import * as activity from './activity.js';
import jackett from './jackett.js';
import { ptSweepIndexers, ptSweepQueryFor } from './search-plan.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { HarvestEntry } from './harvest-queue.js';

/**
 * Fatia circular da varredura pt-BR parcial. Quando o teto horário corta
 * (restante < targets.length), o ponto de partida rotaciona com o cursor para
 * o teto não congelar a varredura sempre nos MESMOS primeiros alvos — o
 * dublado titulado em PT mora em qualquer um deles, e uma fatia sempre-limitada
 * deixaria os de trás eternamente invisíveis. Quando o teto comporta tudo,
 * devolve a lista inteira (comportamento antigo) e o cursor zera.
 */
export function sliceSweepFatia(targets: string[], restante: number, cursor: number): { fatia: string[]; next: number } {
  const total = targets.length;
  if (total === 0 || restante <= 0) return { fatia: [], next: cursor };
  if (restante >= total) return { fatia: targets, next: 0 };
  const start = cursor % total;
  const fatia: string[] = [];
  for (let i = 0; i < restante; i += 1) fatia.push(targets[(start + i) % total]);
  return { fatia, next: (start + restante) % total };
}

let sweepCursor = 0;

/** Zera o cursor do round-robin — os testes precisam de uma partida conhecida. */
export function resetSweepCursor() {
  sweepCursor = 0;
}

export type SweepInput = {
  entry: HarvestEntry;
  titles: unknown;
  matchContext: unknown;
  /** Indexers do laço (globais no modo normal). */
  indexers: string[];
  directed: boolean;
  /** Urgência (next-episode/brProbe) fura SÓ o gate de inatividade. */
  urgent: boolean;
  harvestMaxPerHour: number;
  harvestIdleWindowMs: number;
  /** Consultas já gastas na hora corrente (o orçamento da varredura é o resto). */
  queriesThisHour: number;
  awaitGap: (indexer: string) => Promise<void>;
  markQueried: (indexer: string) => void;
};

/**
 * Executa a varredura pt-BR agrupada e devolve a contabilidade dela. ANTES do
 * laço de propósito: é a consulta de maior valor por unidade, então quando o
 * teto corta, quem fica pelo caminho é a cauda do laço — não ela.
 */
export async function runPtSweep(input: SweepInput): Promise<{ attempted: number; succeeded: number; items: any[] }> {
  const {
    entry, titles, matchContext, indexers, directed, urgent,
    harvestMaxPerHour, harvestIdleWindowMs, queriesThisHour, awaitGap, markQueried,
  } = input;
  const out = { attempted: 0, succeeded: 0, items: [] as any[] };
  const sweepQuery = config.jackett.ptSweepGlobal ? ptSweepQueryFor({ titles: titles as any }) : null;
  const sweepTargets =
    !directed && sweepQuery && (urgent || !activity.recentUserTraffic(harvestIdleWindowMs))
      ? ptSweepIndexers(indexers, config.jackett.ptBrIndexers, config.jackett.indexOnlyIndexers)
      : [];
  if (!sweepQuery || sweepTargets.length === 0) return out;

  // A varredura agrupada dispara uma consulta HTTP por alvo: conta no teto com
  // a mesma moeda do laço, antes de decidir. A fatia parcial permite colher o
  // que couber no orçamento em vez de tudo-ou-nada, e o round-robin rotaciona o
  // ponto de partida para o teto não congelar sempre nos MESMOS primeiros alvos.
  const restante = harvestMaxPerHour - queriesThisHour;
  const { fatia, next } = sliceSweepFatia(sweepTargets, restante, sweepCursor);
  sweepCursor = next;
  const ativos = fatia.filter((target) => !jackett.breakerTripped(target));
  if (fatia.length < sweepTargets.length) metrics.count('harvest.sweep.partial');
  if (ativos.length < fatia.length) metrics.count('harvest.sweep.breaker');
  if (!ativos.length) {
    log.debug(
      fatia.length > 0
        ? `[harvest] varredura pt: ${fatia.length} alvo(s) com breaker aberto, nada a consultar`
        : '[harvest] teto horário atingido antes da varredura pt',
    );
    return out;
  }
  for (const target of ativos) {
    await awaitGap(target);
  }
  out.attempted += ativos.length;
  metrics.count('harvest.sweep');
  try {
    const items = await jackett.search(sweepQuery, entry.type, ativos, {
      matchContext,
      recordStatus: false,
      // Descoberta do índice: zero-sobrevivente aqui é sonda negativa, não
      // desperdício do caminho de resposta (ver jackett.search).
      background: true,
    } as any);
    for (const target of ativos) markQueried(target);
    out.succeeded += ativos.length;
    out.items.push(...items.filter((i: any) => !i.fromAccount));
  } catch (err: unknown) {
    for (const target of ativos) markQueried(target);
    log.warn('[harvest] varredura pt falhou:', log.errorMessage(err));
  }
  return out;
}
