import config from '../config.js';
import { getMeta } from '../utils/cinemeta.js';
import {
  parseStremioId,
  buildSearchQuery,
  resolveSearchNames,
  resolveOriginalStepName,
  filterRelevantRaw,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import * as tmdb from '../utils/tmdb.js';
import { createLatestWriter } from '../utils/latest-writer.js';
import { ptSweepQueryFor } from './search-plan.js';
import * as harvester from './harvester.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { buildStreams, createFirstObserver, firstObserverClaim, stageFirstTiming } from './stream-builder.js';
import type { FirstObserverState } from './stream-builder.js';
import { debridRefreshSatisfied, hasPlayableStream } from './search-cache.js';
import { cloneStreamTrace, createStreamTrace, serializeTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import { collectRaw } from './collect-orchestrator.js';
import { attemptIndexFastPath, noteWouldHitIndex } from './search-index-path.js';
import { fuseIndexEnrichment } from './index-evidence.js';
import type { RawBatch } from './search-index-path.js';
import { schedulePtSweepTail } from './search-sweep-tail.js';
import { createTailQueue } from './tail-enqueue.js';
import { startMultiWorkDiscovery, resolveMultiWork } from './search-multiwork.js';
import type { MultiWorkCollection, MatchContext, RawItem } from '../../types/domain.js';
import { collectFallbackForBuild } from './magnet-bank-fallback.js';
import { promoteInstantTail } from './magnet-bank-instant.js';
import { createLatePromoter } from './search-late-promoter.js';
import { mergeLiveIndexerStates } from './live-indexer-state.js';
import type { LiveIndexerState } from './live-indexer-state.js';

// Fachada pós-split: `poolCovered`/`idxPoolCovered`/`idxReleasesToRaw` vivem em
// `search-pool-coverage.ts`, `collectRaw` em `collect-orchestrator.ts`. As
// reexports abaixo preservam os caminhos de import públicos (`index.ts`,
// `test/torrentio-provider.test.ts`) e o degrau `franchiseQuery` da coleta.
export { poolCovered, idxPoolCovered, idxReleasesToRaw } from './search-pool-coverage.js';
export { collectRaw } from './collect-orchestrator.js';

interface SearchProgress {
  metadataDone: boolean;
  metadataConsumedProviderBudget: boolean;
}

export async function doSearch({
  type,
  id,
  cacheKey,
  deadlineAt,
  progress,
  firstObserver = createFirstObserver(false),
}: {
  type: string;
  id: string;
  cacheKey: string;
  deadlineAt: number;
  progress?: SearchProgress;
  /** Estado compartilhado do observador de primeira resposta (search-cache o
   * cria, pode promovê-lo via coalescing e o reusa entre os passes do finish). */
  firstObserver?: FirstObserverState;
}) {
  const isDemo = opts().providers.includes('demo');
  const { imdbId, season, episode } = parseStremioId(id);
  // Opt-in multiobra: a coleção (TMDB) é lida em paralelo com os metadados.
  const collectionPromise = startMultiWorkDiscovery({ imdbId, season, isDemo, deadlineAt });
  // Cinemeta e TMDB em paralelo: o título pt-BR não pode atrasar a busca.
  const metadataDone = metrics.timed('search.metadata');
  let metadataComplete = false;
  let meta: any;
  let titles: any;
  let collection: MultiWorkCollection | null = null;
  const metadataStartedAt = Date.now();
  try {
    [meta, titles] = await Promise.all([getMeta(type, imdbId), tmdb.getTitles(imdbId)]);
    metadataComplete = true;
  } finally {
    const endedAt = Date.now();
    metadataDone();
    // I0 — estagia a parede de tempo dos metadados na primeira resposta, SEM
    // substituir o timer `search.metadata` já existente. O valor só é comitado
    // no mesmo denominador de `search.first.responses`.
    stageFirstTiming(firstObserver, 'metadata', endedAt - metadataStartedAt);
    if (progress) {
      progress.metadataDone = metadataComplete;
      // Esta é a fronteira do orçamento normal de providers. A coleta ainda
      // ganha o piso de 500ms para degradar com alguma lista, mas esse piso não
      // transforma metadata lenta em culpa do indexer.
      progress.metadataConsumedProviderBudget = endedAt >= deadlineAt - config.debridReserve;
    }
  }
  // M3: a espera da coleção acontece FORA do timer de metadados (não contamina
  // `search.first.metadata`) e usa o deadline absoluto já em curso — a coleta
  // segue com o que sobrou, sem timeout adicional.
  collection = await collectionPromise;
  // Cinemeta é a fonte preferida, mas ele volta 404 em título obscuro/regional
  // ou lançamento novo demais — ver `resolveSearchNames`.
  const searchMeta = resolveSearchNames({ meta, titles, imdbId });
  const query = buildSearchQuery(searchMeta, { season, episode });
  const { collection: multiWork, query: multiWorkQuery } = resolveMultiWork(collection, searchMeta.year);

  // Só vale uma query separada quando o título PT difere do original.
  const ptQuery =
    titles?.pt && titles.pt !== titles.original
      ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season, episode })
      : null;
  // Degrau opcional do título original, NOME CRU de propósito (sem ano nem SxxEyy —
  // magnetdownload achou "Adım Farah" por consulta ampla; ano/episódio filtram no matchContext).
  const originalQuery = resolveOriginalStepName(titles?.original, searchMeta.name);
  const providerMode = opts().providers.includes('both') ? 'both' : opts().providers[0] || config.provider;
  const wantsJackettSweep =
    providerMode !== 'demo' && (providerMode === 'both' || opts().providers.includes('jackett'));
  const sweepQuery = config.jackett.ptSweepGlobal && wantsJackettSweep
    ? ptSweepQueryFor({ titles })
    : null;
  // Refresh de debrid e varredura pt-BR compartilham uma fila tardia para não
  // executar applyDebrid/upload concorrentes na mesma chave.
  const enqueueTail = createTailQueue();
  // O inventário roda durante a coleta, antes de buildStreams. Seu ledger é
  // compartilhado só como matéria-prima; cada build recebe um clone para a
  // passada parcial não contaminar a tardia.
  const collectionTrace: StreamTraceState | null = config.search.streamTrace ? createStreamTrace() : null;

  log.info(
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${opts().providers.join('+')}`,
  );

  // Fecha o pipeline sobre um lote de resultados brutos. É chamado duas vezes na
  // busca fria: com o que chegou dentro do prazo e, depois, com o lote completo
  // quando as fontes lentas terminam (aí só pra reescrever o cache).
  const finish = createLatestWriter(
    async ({ items, partial, deadlineAt: inputDeadline, live }: { items: RawItem[]; partial: boolean; deadlineAt?: number | null; live?: LiveIndexerState | null }) => {
      // I0 — reclama a passada first ATOMICAMENTE no início, antes de qualquer
      // await/build, via helper puro: só uma busca síncrona real com prazo de
      // resposta presente reclama; recaches sem `inputDeadline` nunca.
      const { observeFirstPass, observeLatePass } = firstObserverClaim(firstObserver, inputDeadline != null);
      let needsDebridRefresh = false;
      let autofetchCount = 0;
      let debridKnown: boolean | undefined = undefined;
      // P5 — um ledger POR build. Kill-switch desligado => null (no-op).
      const trace: StreamTraceState | null = cloneStreamTrace(collectionTrace);
      const fallback = collectFallbackForBuild({ live, items, type, imdbId, season, episode, trace });
      const buildInput = fallback.items.length ? [...items, ...fallback.items] : items;
      const streams = await buildStreams(buildInput, {
        meta, titles, imdbId, season, episode, isDemo, searchKey: cacheKey,
        deadlineAt: inputDeadline,   // presente SÓ no passo de resposta (orçamento do debrid e gate de prazo do first)
        multiWork,
        observeFirstPass,             // só a passada reclamada
        observeLatePass,              // recache tardio com o first já contado
        firstObserver,                // estado persistido entre os passes do finish
        trace,
        onDebridResult: (result: any) => {
          needsDebridRefresh = needsDebridRefresh || result.needsFullRefresh;
          autofetchCount += result.autofetchCount || 0;
          if (result.known !== undefined) debridKnown = result.known;
        },
      });
      const isDebridKnown = debridKnown !== undefined ? Boolean(debridKnown && !needsDebridRefresh) : !needsDebridRefresh;
      const fallbackInList = streams.some((s: any) => Boolean(s?._fromFallback || s?._fromSnapshot)); // foto 📦 do idx de indexer falho também é reserva
      // `partial:true` com reserva: o handler responde cacheMaxAge:0 e o TTL
      // curto abaixo dá à próxima abertura a chance de reconsultar o vivo.
      return { streams, partial: partial || fallbackInList, needsDebridRefresh, autofetchCount, debridKnown: isDebridKnown, trace, fallback: fallbackInList };
    },
    ({ streams, partial, needsDebridRefresh, debridKnown, trace, fallback }: any) => {
      const isDebridKnown = debridKnown !== undefined ? Boolean(debridKnown && !needsDebridRefresh) : !needsDebridRefresh;
      const hasFallback = Boolean(fallback);
      // Lista com reserva NUNCA é completa: `partial` + TTL curto; promoção sem
      // novidade não limpa a marca (ver `late`) — só o rebuild com o vivo de volta.
      const complete = hasPlayableStream(streams) && !partial && isDebridKnown && !hasFallback;
      // TTL do fallback RESPEITA o CACHE_TTL: cache desligado (<=0) não grava, e
      // o teto nunca passa do TTL normal (CACHE_TTL menor que o fallback vence).
      const fallbackTtl = Math.min(config.cacheTtl, config.fallbackStreamsTtl);
      if (hasFallback && fallbackTtl <= 0) {
        log.info(`[search] reserva sem cache (CACHE_TTL/FALLBACK_STREAMS_TTL <= 0); ${id}`);
        return;
      }
      // `debridKnown` registra se a lista nasceu de checagem confiável; sem ele
      // o passe tardio promovia sem refazer a checagem e congelava a lista sem ⚡.
      // P5 — trace serializado (o /stream-trace.json lê offline) com `searchMeta`
      // (nomes+ano) para o recompute de título sem refazer Cinemeta/TMDB.
      const ttl = hasFallback ? fallbackTtl : complete ? config.cacheTtl : Math.min(config.cacheTtl, 60);
      cache.set(cacheKey, {
        streams,
        partial: hasFallback ? true : partial,
        debridKnown: isDebridKnown,
        trace: serializeTrace(trace),
        searchMeta,
        ...(hasFallback ? { fallback: true } : {}),
      }, ttl);
      log.info(`[search] ${streams.length} stream(s)${hasFallback ? ' (fallback)' : partial ? ' (parcial)' : ''} para ${id}`);
    },
    (value) => Array.isArray(value?.streams) && value.streams.length > 0,
  );

  // Fim da coleta (promoção tardia) extraído para `search-late-promoter.ts`.
  const late = createLatePromoter({ finish, cacheKey, id });

  const matchContext = {
    names: searchMeta.names,
    year: searchMeta.year,
    isSeries: season != null,
    season,
    episode,
    released: meta?.released ?? null,
    // Série: data do EPISÓDIO pedido; `meta.firstAired` (vazio em série) cobre o filme.
    firstAired: meta?.firstAired ?? (season != null && episode != null ? meta?.episodeAired?.[`${season}:${episode}`] ?? null : null),
    multiWork,
  };
  const episodePhase = finish.phase();

  // Fase 0 do índice (observacional) e Fase 3 (leitura do índice antes de
  // qualquer indexer). Extraídas para `search-index-path.ts`; o facade só decide
  // se cai na coleta ao vivo quando o índice NÃO cobriu a obra.
  noteWouldHitIndex({ query, type, providerMode, wantsJackettSweep });
  const { servedFromIndex, instant, raw: indexedRaw } = await attemptIndexFastPath({
    query, type, id, imdbId, season, episode, ptQuery, originalQuery, matchContext, sweepQuery, deadlineAt, isDemo, firstObserver, trace: collectionTrace,
  });
  let raw: RawBatch = indexedRaw ?? await collectRaw(
    query, type, imdbId, ptQuery, matchContext,
    (items: any[], grew: boolean, partial?: boolean, live?: LiveIndexerState | null) => late(items, grew, episodePhase, partial, live ?? null),
    sweepQuery, deadlineAt, undefined, firstObserver, collectionTrace, originalQuery, multiWorkQuery,
  );

  // Série sem candidato útil por episódio tenta o pack. Lote parcial não-vazio
  // ainda pode receber a fonte BR no passe tardio; só ampliamos o gatilho antigo
  // quando a coleta terminou e o filtro compartilhado provou que tudo era lixo.
  const relevant = filterRelevantRaw(raw.items, matchContext);
  const needsPack = raw.items.length === 0 || (!raw.partial && relevant.length === 0);
  let usedPackFallback = false;
  if (needsPack && season != null && !isDemo) {
    usedPackFallback = true;
    // O passe tardio da busca por episódio não pode sobrescrever o pack que
    // estamos prestes a buscar. `advance` invalida qualquer escrita antiga,
    // inclusive uma build que já começou e ainda está no debrid.
    const packPhase = finish.advance();
    const s = String(season).padStart(2, '0');
    // Mesmo fallback da query principal: sem Cinemeta o pack virava "tt123 S01".
    const packQuery = `${searchMeta.name} S${s}`;
    // O fallback também precisa do título pt-BR: é justamente aqui, quando a
    // busca por episódio falhou, que as fontes BR (que só publicam pack de
    // temporada) teriam algo — e elas não indexam pelo nome em inglês.
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    // Mesmo degrau do original no pack: trackers globais titulam o pack de
    // temporada pelo nome original também.
    const originalPackQuery = originalQuery ? `${originalQuery} S${s}` : null;
    log.info(
      `[search] sem resultados; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`,
    );
    raw = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, (items: any[], grew: boolean, partial?: boolean, live?: LiveIndexerState | null) =>
      late(items, grew, packPhase, partial, live ?? null),
      sweepQuery,
      deadlineAt,
      undefined,
      firstObserver,
      collectionTrace,
      originalPackQuery,
    );
  }

  const responsePhase = finish.phase();
  if (raw.sweepInline) metrics.count('search.pt-sweep.inline');
  const result = await finish({ ...raw, deadlineAt }, responsePhase);

  // Jackett como SEGUNDO: a resposta já saiu do índice; a coleta completa roda
  // no tail, alimenta o índice com o que é novo e promove a lista pelo mesmo
  // latest-writer de sempre. É o mecanismo do passe tardio, reaproveitado.
  if (servedFromIndex) {
    enqueueTail(async () => {
      const enrichStarted = Date.now();
      try {
        // As tarefas BR já rodaram na janela crítica acima. Não as repetimos no
        // tail; só o restante enriquece o índice. Na via INSTANTÂNEA nada rodou
        // na janela crítica (a resposta saiu do banco): o tail faz a coleta
        // COMPLETA — BR + globais.
        const enrichment = await collectRaw(query, type, imdbId, ptQuery, matchContext, null, sweepQuery, null, instant ? 'all' : 'nonpriority', undefined, collectionTrace, originalQuery, multiWorkQuery);
        if (enrichment.partial && enrichment.completion) await enrichment.completion;
        // A janela crítica pode ter devolvido antes do BR terminar. Espera-o
        // aqui, no único writer do caminho do índice, para mesclar o lote no
        // `raw` compartilhado antes de promover a coleta completa.
        if (raw.partial && raw.completion) await raw.completion;
        const mergedLive = mergeLiveIndexerStates([raw.live, enrichment.live]);
        if (instant) {
          // Live MESCLADO + sweepInline no raw: a fila tardia (refresh/pack/
          // sweep) lê em runtime — sem 📦 nem varredura repetida.
          raw.live = mergedLive; raw.sweepInline = raw.sweepInline || enrichment.sweepInline;
          await promoteInstantTail({ rawItems: raw.items, liveItems: enrichment.items, live: mergedLive, phase: responsePhase, late });
          return;
        }
        // Fusão de evidência por hash (caso Mortuary): a cópia ao vivo mais
        // saudável resgata o snapshot velho em vez de ser descartada. A lógica
        // e as travas de origem/áudio vivem em `index-evidence.ts`.
        const { fresh, fused } = fuseIndexEnrichment(raw.items, enrichment.items);
        if (fresh.length) {
          log.info(`[search] enriquecimento do índice trouxe ${fresh.length} resultado(s) novo(s); recacheando`);
          raw.items.push(...fresh);
        }
        if (fused) metrics.count('search.idx.evidenceFused', fused);
        await finish({ items: raw.items, partial: false, live: mergedLive }, responsePhase);
      } catch (err) {
        log.warn('[search] enriquecimento do índice falhou:', err?.message || err);
      } finally {
        metrics.observe('search.idx.enrich', Date.now() - enrichStarted);
      }
    });
  }

  // Alimento do colhedor: série assistida com play de verdade semeia o
  // episódio seguinte (o dedupe por TTL evita re-enfileirar a cada busca).
  if (config.releaseIndex.enabled && season != null && episode != null && hasPlayableStream(result.streams)) {
    harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode: episode + 1, reason: 'next-episode' });
  }

  // Pack da temporada no tail de TODA busca de série. Tracker titula pack sem
  // SxxEyy ("Goliath.S03.COMPLETE"), então a query do episódio nunca o acha.
  // O gatilho antigo (episódio "fraco": ninguém com 3+ seeders) deixava de
  // fora o caso comum — Goliath S03E01 tinha release de 43 seeders, 0/12 em
  // cache na AllDebrid, e os packs mais semeados nunca eram consultados. Vale
  // também para a busca servida pelo índice, que nasce das queries de
  // episódio. O cache cru é por indexer+query (RAW_CACHE_TTL): uma consulta
  // por temporada por janela, e os outros episódios reaproveitam o lote.
  // Mesclar, em vez de substituir, preserva as releases do episódio.
  if (config.search.packTail && !usedPackFallback && season != null && !isDemo) {
    const s = String(season).padStart(2, '0');
    const packQuery = `${searchMeta.name} S${s}`;
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    enqueueTail(async () => {
      const started = Date.now();
      try {
        // A fusão por hash compara contra o balde do episódio JÁ estabilizado:
        // com Jackett frio a coleta passa do orçamento e o lote parcial da
        // resposta ainda não tem tudo — mesmo padrão da varredura pt-BR.
        if (raw.partial && raw.completion) await raw.completion;
        metrics.count('search.pack-tail.run');
        log.info(`[search] buscando pack da temporada "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`);
        const pack = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, null, sweepQuery, null, 'all', undefined, collectionTrace, originalQuery ? `${originalQuery} S${s}` : null);
        if (pack.partial && pack.completion) await pack.completion;
        // Mesma fusão por hash do enriquecimento do índice: a regra é geral —
        // hash conhecido com swarm melhor atualiza a evidência em vez de ser
        // descartado (só o seeders sobe; origem/áudio do vencedor ficam).
        const { fresh, fused } = fuseIndexEnrichment(raw.items, pack.items);
        if (!fresh.length && !fused) return;
        if (fresh.length) {
          raw.items.push(...fresh);
          metrics.count('search.pack-tail.hit');
        }
        if (fused) metrics.count('search.idx.evidenceFused', fused);
        log.info(`[search] pack tardio: ${fresh.length} novo(s), ${fused} evidência fundida; recacheando`);
        // Etapa 4: une o estado da resposta com o da própria coleta de pack.
        await finish({ items: raw.items, partial: false, live: mergeLiveIndexerStates([raw.live, pack.live]) }, responsePhase);
      } finally {
        metrics.observe('search.pack-tail', Date.now() - started);
      }
    });
  }

  // Quanto a coleta ainda levou DEPOIS de responder — só existe quando a
  // resposta saiu parcial, então a contagem de `search.late` também é a de
  // buscas fora do orçamento. A via INSTANTÂNEA tem `completion` já resolvido:
  // medir aí era amostra artificial de ~0ms afundando o p50.
  if (!instant && raw.partial && raw.completion) {
    const tailStarted = Date.now();
    raw.completion
      .then(() => metrics.observe('search.late', Date.now() - tailStarted))
      // A conclusão que falha já é logada por quem a criou; aqui ela só não
      // pode virar rejeição não tratada.
      .catch(() => {});
  }
  if (result.needsDebridRefresh) {
    // A primeira lista já pode sair como "download" dentro do prazo. Repetimos
    // o mesmo pós-processamento sem teto depois que a resposta foi liberada para
    // recuperar ⚡/cachedOnly no cache, mesmo se nenhum provider trouxer item novo.
    enqueueTail(async () => {
      try {
        // Se a coleta ainda estava aberta, esperamos o balde estabilizar. Assim
        // a checagem completa já grava partial:false e não pode rebaixar uma
        // promoção concorrente feita pelo callback de conclusão.
        if (raw.partial && raw.completion) await raw.completion;
        const refreshed = cache.get(cacheKey);
        // O passe tardio pode já ter reconstruído a mesma lista. Não
        // repetimos a consulta cara (e, na AllDebrid, o upload) sem necessidade.
        if (debridRefreshSatisfied(refreshed)) return;
        // Instantâneo com `raw.items` vazio (sem ponte 📦 e sem vivo): o tail
        // já decidiu a reserva; reconstruir aqui regravaria lista vazia.
        if (instant && raw.items.length === 0) return;
        // Na via instantânea `raw.live` é o live MESCLADO do tail: é ele que
        // reinjeta a reserva 📦 — com live nulo o TTL virava longo.
        await finish({ items: raw.items, partial: false, live: raw.live }, responsePhase);
      } catch (err) {
        log.warn('[search] atualização completa do debrid falhou:', err?.message || err);
      }
    });
  }

  // Varredura pt-BR nos globais (fila tardia serial compartilhada).
  schedulePtSweepTail({ raw, finish, responsePhase, enqueueTail, type, matchContext, sweepQuery, wantsJackettSweep, imdbId });
  return result;
}
