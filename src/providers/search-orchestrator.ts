import config from '../config.js';
import { getMeta } from '../utils/cinemeta.js';
import {
  parseStremioId,
  buildSearchQuery,
  resolveSearchNames,
  hasExplicitForeignAudio,
  filterRelevantRaw,
  extractInfoHash,
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
import { createStreamTrace, serializeTrace } from '../utils/stream-trace.js';
import type { StreamTraceState, SerializedStreamTrace } from '../utils/stream-trace.js';
import { collectRaw } from './collect-orchestrator.js';
import { attemptIndexFastPath, noteWouldHitIndex } from './search-index-path.js';
import type { RawBatch } from './search-index-path.js';
import { schedulePtSweepTail } from './search-sweep-tail.js';
import { createTailQueue } from './tail-enqueue.js';

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
  // Cinemeta e TMDB em paralelo: o título pt-BR não pode atrasar a busca.
  const metadataDone = metrics.timed('search.metadata');
  let metadataComplete = false;
  let meta: any;
  let titles: any;
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
  // Cinemeta é a fonte preferida, mas ele volta 404 em título obscuro/regional
  // ou lançamento novo demais — ver `resolveSearchNames`.
  const searchMeta = resolveSearchNames({ meta, titles, imdbId });
  const query = buildSearchQuery(searchMeta, { season, episode });

  // Só vale uma query separada quando o título PT difere do original.
  const ptQuery =
    titles?.pt && titles.pt !== titles.original
      ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season, episode })
      : null;
  const providerMode = opts().providers.includes('both') ? 'both' : opts().providers[0] || config.provider;
  const wantsJackettSweep =
    providerMode !== 'demo' && (providerMode === 'both' || opts().providers.includes('jackett'));
  const sweepQuery = config.jackett.ptSweepGlobal && wantsJackettSweep
    ? ptSweepQueryFor({ titles })
    : null;
  // Refresh de debrid e varredura pt-BR compartilham uma fila tardia para não
  // executar applyDebrid/upload concorrentes na mesma chave.
  const enqueueTail = createTailQueue();

  log.info(
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${opts().providers.join('+')}`,
  );

  // Fecha o pipeline sobre um lote de resultados brutos. É chamado duas vezes na
  // busca fria: com o que chegou dentro do prazo e, depois, com o lote completo
  // quando as fontes lentas terminam (aí só pra reescrever o cache).
  const finish = createLatestWriter(
    async ({ items, partial, deadlineAt: inputDeadline }) => {
      // I0 — reclama a passada first ATOMICAMENTE no início, antes de qualquer
      // await/build, via helper puro: só uma busca síncrona real com prazo de
      // resposta presente reclama; recaches sem `inputDeadline` nunca — e, se
      // correrem antes do first confirmar, não observam (firstCounted=false).
      const { observeFirstPass, observeLatePass } = firstObserverClaim(firstObserver, inputDeadline != null);
      let needsDebridRefresh = false;
      let autofetchCount = 0;
      let debridKnown: boolean | undefined = undefined;
      // P5 — um ledger POR build. Criado só quando o kill-switch está ligado;
      // desligado, `trace` null e toda a instrumentação é no-op. O estado
      // observa os cortes SEM mudar nenhum deles.
      const trace: StreamTraceState | null = config.search.streamTrace ? createStreamTrace() : null;
      const streams = await buildStreams(items, {
        meta, titles, imdbId, season, episode, isDemo, searchKey: cacheKey,
        deadlineAt: inputDeadline,   // presente SÓ no passo de resposta (orçamento do debrid e gate de prazo do first)
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
      return { streams, partial, needsDebridRefresh, autofetchCount, debridKnown: isDebridKnown, trace };
    },
    ({ streams, partial, needsDebridRefresh, debridKnown, trace }) => {
      // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco
      // tempo. Lote parcial idem: o passe tardio reescreve, mas se ele falhar o
      // TTL curto evita servir a lista sem as fontes BR por 15 minutos.
      const isDebridKnown = debridKnown !== undefined ? Boolean(debridKnown && !needsDebridRefresh) : !needsDebridRefresh;
      const complete = hasPlayableStream(streams) && !partial && isDebridKnown;
      // `debridKnown` registra se ESTA lista nasceu de uma checagem de cache
      // confiável. Sem ele, `partial:false` era usado como prova de "já
      // processado" — e o passe tardio promove a entrada SEM refazer a
      // checagem, o que congelava a lista sem ⚡ pelo TTL inteiro.
      // P5 — o trace vai serializado (payload) junto da lista: é ele que o
      // /stream-trace.json lê offline. Kill-switch desligado => null.
      // P5 recompute — `searchMeta` (nomes + ano) viaja junto: é o mínimo que
      // o diagnóstico precisa para re-aplicar o filtro de TÍTULO na matéria-
      // prima local (idx/raw/inventário) sem refazer Cinemeta/TMDB. Aditivo:
      // entrada antiga sem o campo => recompute nota 'no-names' e o filtro de
      // título não roda (comportamento do pipeline com nomes vazios).
      cache.set(
        cacheKey,
        { streams, partial, debridKnown: isDebridKnown, trace: serializeTrace(trace), searchMeta },
        complete ? config.cacheTtl : Math.min(config.cacheTtl, 60),
      );
      log.info(`[search] ${streams.length} stream(s)${partial ? ' (parcial)' : ''} para ${id}`);
    },
    (value) => Array.isArray(value?.streams) && value.streams.length > 0,
  );

  /**
   * Fim da coleta. Se as fontes lentas trouxeram algo, reconstrói tudo; se não
   * trouxeram, só promove a entrada do cache a completa — sem refazer a
   * checagem no debrid, que é a parte cara e não mudaria de resposta.
   */
  const late = (items: any[], grew: boolean, phase: any, partial = false) => {
    if (grew) return finish({ items, partial }, phase);
    if (partial) return undefined;
    // Fase diferente = o fallback de pack assumiu; promover o lote antigo aqui
    // marcaria como pronta uma busca que ainda está em andamento.
    if (phase !== finish.phase()) return undefined;
    const hit = cache.get(cacheKey);
    if (!hit?.partial) return undefined;
    // Promover NÃO refaz a checagem de cache, então `debridKnown` é copiado
    // como está: promessa de completude da COLETA não é promessa de ⚡.
    // P5 — `hit.trace` copiado OBRIGATORIAMENTE: a promoção substitui a entrada
    // inteira, e sem o campo o ledger da primeira build seria apagado numa
    // coleta que não trouxe nada novo — exatamente o caso que o endpoint lê.
    const debridKnown = hit.debridKnown === true;
    cache.set(
      cacheKey,
      { streams: hit.streams, partial: false, debridKnown, trace: (hit as { trace?: SerializedStreamTrace | null }).trace ?? null, searchMeta: (hit as { searchMeta?: unknown }).searchMeta ?? null },
      debridKnown ? config.cacheTtl : Math.min(config.cacheTtl, 60),
    );
    log.info(`[search] coleta encerrada sem novidade; ${hit.streams.length} stream(s) para ${id}`);
    return undefined;
  };

  const matchContext = {
    names: searchMeta.names,
    year: searchMeta.year,
    isSeries: season != null,
    season,
    episode,
  };
  const episodePhase = finish.phase();

  // Fase 0 do índice (observacional) e Fase 3 (leitura do índice antes de
  // qualquer indexer). Extraídas para `search-index-path.ts`; o facade só decide
  // se cai na coleta ao vivo quando o índice NÃO cobriu a obra.
  noteWouldHitIndex({ query, type, providerMode, wantsJackettSweep });
  const { servedFromIndex, raw: indexedRaw } = await attemptIndexFastPath({
    query, type, id, imdbId, season, episode, ptQuery, matchContext, sweepQuery, deadlineAt, isDemo, firstObserver,
  });
  let raw: RawBatch = indexedRaw ?? await collectRaw(
    query, type, imdbId, ptQuery, matchContext,
    (items: any[], grew: boolean, partial?: boolean) => late(items, grew, episodePhase, partial),
    sweepQuery, deadlineAt, undefined, firstObserver,
  );

  // Série sem candidato útil por episódio tenta o pack. Lote parcial não-vazio
  // ainda pode receber a fonte BR no passe tardio; só ampliamos o gatilho antigo
  // quando a coleta terminou e o filtro compartilhado provou que tudo era lixo.
  const relevant = filterRelevantRaw(raw.items, matchContext);
  // Fraqueza do episodio: ninguem alcanca o piso de seeders. Avaliada sobre o
  // lote informado; no gatilho TARDIO ela e recalculada depois da coleta
  // fechar, porque um lote parcial ainda pode receber a release saudavel.
  //
  // Idioma estrangeiro explicito NAO conta como saudavel: medido em Lost Girl
  // S01E01, um "FRENCH HDTV" de 12 seeders passava do piso sozinho e desligava
  // a busca de pack, deixando o usuario com frances, holandes e 272p. A guarda
  // poupa MULTI/DUAL (carregam a faixa original) e qualquer marca PT. Isso muda
  // so o GATILHO: a release estrangeira continua saindo na lista, porque em
  // titulo sem mais nada ela ainda e a unica opcao.
  const isHealthy = (item: any) => {
    const title = item.title || item.Title || '';
    return Number(item.seeders ?? item.Seeders ?? 0) >= config.search.packMinSeeders &&
      !hasExplicitForeignAudio(title);
  };
  const episodeIsWeak = (items: any[]) => {
    const rel = items === raw.items ? relevant : filterRelevantRaw(items, matchContext);
    return rel.length > 0 && !rel.some(isHealthy);
  };
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
    log.info(
      `[search] sem resultados; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`,
    );
    raw = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, (items: any[], grew: boolean, partial?: boolean) =>
      late(items, grew, packPhase, partial),
      sweepQuery,
      deadlineAt,
      undefined,
      firstObserver,
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
        // tail; só o restante enriquece o índice.
        const live = await collectRaw(query, type, imdbId, ptQuery, matchContext, null, sweepQuery, null, 'nonpriority');
        if (live.partial && live.completion) await live.completion;
        // A janela crítica pode ter devolvido antes do BR terminar. Espera-o
        // aqui, no único writer do caminho do índice, para mesclar o lote no
        // `raw` compartilhado antes de promover a coleta completa.
        if (raw.partial && raw.completion) await raw.completion;
        const known = new Set(
          raw.items.map((item) => String(extractInfoHash(item.infoHash || item.magnet) || '').toLowerCase()).filter(Boolean),
        );
        const fresh = live.items.filter((item: any) => {
          const h = String(extractInfoHash(item.infoHash || item.magnet) || '').toLowerCase();
          return h && !known.has(h);
        });
        if (fresh.length) {
          log.info(`[search] enriquecimento do índice trouxe ${fresh.length} resultado(s) novo(s); recacheando`);
          raw.items.push(...fresh);
        }
        await finish({ items: raw.items, partial: false }, responsePhase);
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

  // O episódio fraco já ocupou o caminho crítico; o pack é uma segunda busca
  // complementar no tail. Mesclar, em vez de substituir, preserva releases do
  // episódio e permite ao autofetch escolher o swarm saudável do pack.
  if (config.search.packTail && !usedPackFallback && !servedFromIndex && season != null && !isDemo) {
    const s = String(season).padStart(2, '0');
    const packQuery = `${searchMeta.name} S${s}`;
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    enqueueTail(async () => {
      const started = Date.now();
      try {
        // Lote parcial nao decide nada: com Jackett frio a coleta estoura o
        // orcamento e a release saudavel pode chegar depois da resposta. Quem
        // julga e o balde ja estabilizado — mesmo padrao da varredura pt-BR.
        if (raw.partial && raw.completion) await raw.completion;
        if (!episodeIsWeak(raw.items)) return;
        metrics.count('search.pack-tail.run');
        log.info(`[search] sem candidato saudável; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`);
        const pack = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, null, sweepQuery);
        if (pack.partial && pack.completion) await pack.completion;
        const known = new Set(raw.items.map((item) => extractInfoHash(item.infoHash || item.magnet)).filter(Boolean));
        const fresh = pack.items.filter((item) => {
          const hash = extractInfoHash(item.infoHash || item.magnet);
          return hash && !known.has(hash);
        });
        if (!fresh.length) return;
        raw.items.push(...fresh);
        metrics.count('search.pack-tail.hit');
        log.info(`[search] pack tardio trouxe ${fresh.length} resultado(s) novo(s); recacheando`);
        await finish({ items: raw.items, partial: false }, responsePhase);
      } finally {
        metrics.observe('search.pack-tail', Date.now() - started);
      }
    });
  }

  // Quanto a coleta ainda levou DEPOIS de responder. É o número que diz se o
  // passe tardio virou a regra — e ele só existe quando a resposta saiu
  // parcial, então a contagem de `search.late` também é a contagem de buscas
  // que não couberam no orçamento.
  if (raw.partial && raw.completion) {
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
        await finish({ items: raw.items, partial: false }, responsePhase);
      } catch (err) {
        log.warn('[search] atualização completa do debrid falhou:', err?.message || err);
      }
    });
  }

  // Varredura pt-BR nos globais (fila tardia). Extraída para
  // `search-sweep-tail.ts`; recebe a fila serial compartilhada e o writer da
  // execução corrente. O facade só entrega as dependências fechadas.
  schedulePtSweepTail({ raw, finish, responsePhase, enqueueTail, type, matchContext, sweepQuery, wantsJackettSweep });
  return result;
}
