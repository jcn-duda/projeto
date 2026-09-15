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
import { idxPoolCovered, idxReleasesToRaw } from './search-pool-coverage.js';
import { shouldBrGap, hasBrDubbed } from '../utils/br-gap.js';
import { requestBrProbe } from './br-probe.js';
import type { StreamTraceState } from '../utils/stream-trace.js';

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
 * Fase 3: o índice é LIDO antes de qualquer indexer. Coberto pelo pool →
 * responde já e o Jackett vira segundo (tail que enriquece e promove pelo mesmo
 * SWR de sempre). Lacuna → o caminho atual roda inteiro, sem regressão (devolve
 * `servedFromIndex:false`, `raw:null`).
 */
export async function attemptIndexFastPath(input: IndexAttemptInput): Promise<{ servedFromIndex: boolean; raw: RawBatch | null }> {
  const { query, type, id, imdbId, season, episode, ptQuery, originalQuery, matchContext, sweepQuery, deadlineAt, isDemo, firstObserver, trace } = input;
  let servedFromIndex = false;
  let raw: RawBatch | null = null;
  if (!isDemo && config.releaseIndex.enabled) {
    const indexed = releaseIndex.lookup(imdbId, { season, episode });
    const partial = indexed.length > 0 && releaseIndex.isPartial(imdbId, { season, episode });
    const covered = indexed.length > 0 && !partial && idxPoolCovered(indexed, { season, episode });
    const autofetchSeeded = indexed.some((r) => r.source === 'autofetch');
    if (indexed.length === 0) {
      metrics.count('search.idx.miss');
      harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason: 'miss' });
    } else if (!partial && (covered || autofetchSeeded)) {
      if (covered) metrics.count('search.idx.hit');
      else {
        // A release submetida pelo Chupim entra na resposta imediatamente,
        // mas a coleta continua no tail: visibilidade não vira cobertura falsa.
        metrics.count('search.idx.autofetchSeed');
        metrics.count('search.idx.gap');
        harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason: 'gap' });
      }
      metrics.count('search.idx.served', indexed.length);
      servedFromIndex = true;
      // BR-gap: o pool está coberto, mas o índice não traz BR dublado comprovado
      // ou só traz faixa conhecida abaixo de 1080p. Os index-only nunca entram
      // pela busca viva nem pelo tail; o colhedor busca a ausência ou o upgrade
      // em background. O dedupe TTL (obra+razão) evita repetir a fila a cada
      // abertura; a métrica conta a tentativa porque `enqueue` devolve void.
      if (covered && shouldBrGap(indexed, config.jackett.indexOnlyIndexers.length > 0)) {
        // Sem BR nenhum é `attempt` (lacuna original); BR só em faixa inferior
        // à alvo é `upgrade` (mesma fila, métrica separada para o diagnóstico
        // distinguir ausência de falta de 1080p).
        metrics.count(hasBrDubbed(indexed) ? 'search.idx.brGap.upgrade' : 'search.idx.brGap.attempt');
        // A sonda dirigida substitui o enqueue simples: ela agenda a MESMA
        // entrada `br-gap` (com a flag brProbe) e, quando não é elegível
        // (toggle off / sem interseção / índice off), devolve `fallbackBrGap`
        // para o colhedor continuar sendo a rede de segurança de sempre —
        // desligar a sonda não pode perder o br-gap normal.
        const probe = requestBrProbe({ type: type as 'movie' | 'series', imdbId, season, episode });
        if (probe.fallbackBrGap) {
          harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason: 'br-gap' });
        }
      } else if (covered && hasBrDubbed(indexed)) {
        metrics.count('search.idx.brGap.served');
      }
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
    } else {
      // Existe, mas não cobre o pool (ex.: só legendado) ou é registro
      // PARCIAL (colheita interrompida): NUNCA impede a busca BR dublada de
      // rodar — o caminho completo segue e o colhedor termina o trabalho.
      // Partial só bloqueia o fast-path; ele nunca libera sozinho.
      if (partial) metrics.count('search.idx.partial');
      metrics.count('search.idx.gap');
      harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason: 'gap' });
    }
  }
  return { servedFromIndex, raw };
}
