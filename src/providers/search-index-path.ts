import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import jackett from './jackett.js';
import * as account from './account.js';
import * as cache from '../utils/cache.js';
import * as releaseIndex from '../utils/release-index.js';
import * as harvester from './harvester.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { SAFE_INDEXER_ID } from './stream-builder.js';
import type { FirstObserverState } from './stream-builder.js';
import { collectRaw } from './collect-orchestrator.js';
import { collectInstantItems } from './magnet-bank-instant.js';
import { idxPoolCovered, idxReleasesToRaw } from './search-pool-coverage.js';
import { shouldBrGap, hasBrDubbed, hasBrEvidence } from '../utils/br-gap.js';
import { requestBrProbe } from './br-probe.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import type { LiveIndexerState } from './live-indexer-state.js';

export interface IndexAttemptInput {
  query: string;
  type: string;
  id: string;
  imdbId: string;
  season: number | null;
  episode: number | null;
  ptQuery: string | null;
  originalQuery?: string | null;
  matchContext: MatchContext;
  sweepQuery: string | null;
  deadlineAt: number;
  isDemo: boolean;
  firstObserver?: FirstObserverState | null;
  trace?: StreamTraceState | null;
}

export interface RawBatch {
  items: any[];
  partial: boolean;
  completion: Promise<void>;
  sweepInline: boolean;
  /**
   * Estado vivo de falha por indexer da coleta (Etapa 4). É o MESMO objeto que
   * o `onQueryResult` muta: o build lê os falhos/pendentes para o fallback do
   * banco e a resposta tardia do indexer o remove. Ausente em lotes que não
   * consultaram Jackett (ex.: demo).
   */
  live?: LiveIndexerState | null;
  /**
   * Resposta instantânea do banco vivo: a janela crítica NÃO esperou o BR
   * prioritário; o tail roda a coleta completa (`'all'`) para promover.
   */
  instant?: boolean;
}

/**
 * Fase 0 do índice (observacional): simular a consulta por obra usando o
 * raw:v1 que já existe — se alguma chave bruta da obra está quente ANTES de
 * qualquer rede, um índice por obra teria acertado. É o número que autoriza (ou
 * não) as fases seguintes; não muda comportamento nenhum.
 */
export function noteWouldHitIndex({ query, type, providerMode, wantsJackettSweep }: {
  query: string; type: string; providerMode: string; wantsJackettSweep: boolean;
}) {
  if (!(config.releaseIndex.enabled && providerMode !== 'demo' && wantsJackettSweep)) return;
  const simIndexers: string[] = [...new Set(
    ((opts().jackettIndexers?.length ? opts().jackettIndexers : config.jackett.indexers) || [])
      .filter((i: any) => SAFE_INDEXER_ID.test(String(i))),
  )].map(String);
  if (simIndexers.length === 0) return;
  const warm = jackett.rawKeysFor(simIndexers, query, type).some((k) => cache.peekRemaining(k) != null);
  metrics.count(warm ? 'search.idx.wouldHit' : 'search.idx.wouldMiss');
}

/**
 * Trabalho de fundo do índice/colhedor que a cobertura do `idx` exige: `miss`
 * sem release nenhuma; `gap` quando há release mas não cobre o pool (ou é
 * registro parcial); e a sonda dirigida dos index-only (`br-gap`) quando cobre
 * mas falta BR dublado / a faixa alvo. É o MESMO critério do fast-path do
 * índice, extraído para a via INSTANTÂNEA do banco poder preservá-lo: o acervo
 * responde, mas a obra precisa continuar entrando no índice e no colhedor.
 * `countMetrics:false` mantém o funil `search.idx` fora do caminho do banco.
 */
function enqueueIndexFollowUp(args: {
  indexed: readonly any[];
  partial: boolean;
  covered: boolean;
  type: string;
  imdbId: string;
  season: number | null;
  episode: number | null;
  countMetrics: boolean;
}): void {
  const { indexed, partial, covered, type, imdbId, season, episode, countMetrics } = args;
  if (!config.releaseIndex.enabled) return;
  const enqueue = (reason: 'miss' | 'gap' | 'br-gap') =>
    harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason });
  const autofetchSeeded = indexed.some((r) => r.source === 'autofetch');
  if (indexed.length === 0) {
    if (countMetrics) metrics.count('search.idx.miss');
    enqueue('miss');
    return;
  }
  if (!partial && (covered || autofetchSeeded)) {
    if (covered) {
      if (countMetrics) metrics.count('search.idx.hit');
    } else {
      // A release submetida pelo Chupim entra na resposta imediatamente, mas a
      // coleta continua no tail: visibilidade não vira cobertura falsa.
      if (countMetrics) {
        metrics.count('search.idx.autofetchSeed');
        metrics.count('search.idx.gap');
      }
      enqueue('gap');
    }
    if (covered && shouldBrGap(indexed, config.jackett.indexOnlyIndexers.length > 0)) {
      const upgrade = hasBrDubbed(indexed);
      if (countMetrics) metrics.count(upgrade ? 'search.idx.brGap.upgrade' : 'search.idx.brGap.attempt');
      // Gate de plausibilidade (C6): a sonda só faz sentido quando o índice JÁ
      // provou alguma release BR; sem vestígio, a colheita regular de gap cuida
      // da descoberta. `fallbackBrGap` mantém a rede quando a sonda não é
      // elegível com evidência (toggle off/índice off/sem interseção).
      if (hasBrEvidence(indexed)) {
        const probe = requestBrProbe(
          { type: type as 'movie' | 'series', imdbId, season, episode },
          { mode: upgrade ? 'upgrade' : 'evidence' },
        );
        if (probe.fallbackBrGap) enqueue('br-gap');
      } else if (countMetrics) {
        metrics.count('search.idx.brGap.no-evidence');
      }
    } else if (covered && hasBrDubbed(indexed) && countMetrics) {
      metrics.count('search.idx.brGap.served');
    }
    return;
  }
  // Não cobre (ou é parcial): NUNCA impede a busca dublada de rodar — o
  // caminho completo segue e o colhedor termina o trabalho.
  if (partial && countMetrics) metrics.count('search.idx.partial');
  if (countMetrics) metrics.count('search.idx.gap');
  enqueue('gap');
}

/**
 * Fase 3: o índice é LIDO antes de qualquer indexer. Coberto pelo pool →
 * responde já e o Jackett vira segundo (tail que enriquece e promove pelo mesmo
 * SWR de sempre). Lacuna → o caminho atual roda inteiro, sem regressão (devolve
 * `servedFromIndex:false`, `raw:null`).
 */
export async function attemptIndexFastPath(input: IndexAttemptInput): Promise<{ servedFromIndex: boolean; instant: boolean; raw: RawBatch | null }> {
  const { query, type, id, imdbId, season, episode, ptQuery, originalQuery, matchContext, sweepQuery, deadlineAt, isDemo, firstObserver, trace } = input;
  let servedFromIndex = false;
  let instant = false;
  let raw: RawBatch | null = null;
  if (isDemo) return { servedFromIndex, instant, raw };

  // O índice é lido ANTES de qualquer indexer também para a via instantânea:
  // hash já indexado é evidência melhor e é excluído do 📦 (e somado na
  // cobertura). `partial` só bloqueia o fast-path do índice, nunca a instantânea.
  const indexed = config.releaseIndex.enabled ? releaseIndex.lookup(imdbId, { season, episode }) : [];
  const partial = indexed.length > 0 && config.releaseIndex.enabled && releaseIndex.isPartial(imdbId, { season, episode });

  // Via instantânea (banco vivo): quando a foto do acervo é confiável pela
  // janela adaptativa, a resposta sai JÁ com idx + banco + conta e a coleta ao
  // vivo inteira (BR + globais) roda no tail. Não exige o índice cobrir — a
  // cobertura é do pool formado por banco(passed_filter)+idx.
  const instantResult = collectInstantItems({
    type, imdbId, season, episode,
    meta: { year: matchContext.year, released: matchContext.released, firstAired: matchContext.firstAired },
    preferDubbed: opts().preferDubbed,
    indexReleases: indexed,
  });
  if (instantResult.eligible) {
    // A resposta sai do BANCO, mas a obra ainda precisa entrar no índice e no
    // colhedor (inclusive os index-only): sem isto o acervo vira a única fonte
    // e a busca nunca mais enxerga release nova. Métricas `search.idx.*` ficam
    // FORA do caminho do banco (o dado é do acervo, não do índice).
    if (config.releaseIndex.enabled) {
      const covered = indexed.length > 0 && !partial && idxPoolCovered(indexed, { season, episode, countMetrics: false });
      enqueueIndexFollowUp({ indexed, partial, covered, type, imdbId, season, episode, countMetrics: false });
    }
    // dinv entra junto (idx + banco + conta), com o mesmo teto curto da via do
    // índice: a primeira leitura do inventário não pode segurar a resposta.
    const accountItems = await raceWithDeadline(
      account.search(matchContext, trace),
      config.accountFastPath.waitMs,
      () => [] as any[],
    );
    raw = {
      items: [...idxReleasesToRaw(indexed), ...instantResult.items, ...accountItems],
      // `partial` de propósito: TTL curto/cacheMaxAge 0 até o tail promover.
      partial: true,
      completion: Promise.resolve(),
      sweepInline: false,
      live: null,
      instant: true,
    };
    instant = true;
    servedFromIndex = true;
    log.info(`[search] instantâneo do banco (${instantResult.items.length} item(ns)) para ${id}; coleta ao vivo no tail`);
    return { servedFromIndex, instant, raw };
  }

  if (config.releaseIndex.enabled) {
    const covered = indexed.length > 0 && !partial && idxPoolCovered(indexed, { season, episode });
    const autofetchSeeded = indexed.some((r) => r.source === 'autofetch');
    // Métricas + enqueue do índice/colhedor (miss/gap e a sonda br-gap dos
    // index-only) num só lugar — o mesmo helper que a via instantânea usa.
    enqueueIndexFollowUp({ indexed, partial, covered, type, imdbId, season, episode, countMetrics: true });
    if (!partial && (covered || autofetchSeeded)) {
      metrics.count('search.idx.served', indexed.length);
      servedFromIndex = true;
      // dinv entra na resposta imediata junto (idx + conta): o que já está
      // pronto na conta vira ⚡ sem indexer nenhum. Teto curto: a primeira
      // leitura do inventário custa ~700ms e a resposta não pode esperá-la.
      const accountItems = await raceWithDeadline(
        account.search(matchContext, trace),
        config.accountFastPath.waitMs,
        () => [] as any[],
      );
      // O índice responde mesmo sem Jackett, mas não pode esconder a primeira
      // fonte BR saudável que ainda cabe na janela crítica. Consultamos apenas
      // as tarefas BR isoladas; globais e index-only continuam no enriquecimento
      // em fundo, como antes.
      raw = await collectRaw(
        query,
        type,
        imdbId,
        ptQuery,
        matchContext,
        // O BR prioritário compartilha `raw.items` com o tail abaixo. Não pode
        // ter writer próprio: se chegar atrasado, ele ainda não conhece os
        // globais e promoveria uma coleta incompleta antes da reconciliação.
        null,
        sweepQuery,
        deadlineAt,
        'priority',
        firstObserver,
        trace,
        originalQuery || null,
      );
      raw.items.unshift(...idxReleasesToRaw(indexed), ...accountItems);
      // Mesmo se as tarefas BR fecharem cedo, o lote global ainda será buscado
      // abaixo. Mantém cache curto até o enriquecimento completar a lista.
      raw.partial = true;
      log.info(`[search] índice + ${raw.items.length - indexed.length - accountItems.length} resultado(s) BR ao vivo para ${id}`);
    }
  }
  return { servedFromIndex, instant, raw };
}
