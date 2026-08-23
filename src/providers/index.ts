import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import * as demo from './demo.js';
import jackett from './jackett.js';
import prowlarr from './prowlarr.js';
import bludv from './bludv.js';
import * as account from './account.js';
import { getMeta } from '../utils/cinemeta.js';
import {
  parseStremioId,
  buildSearchQuery,
  resolveSearchNames,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasExplicitForeignAudio,
  filterRelevantRaw,
  extractInfoHash,
  qualityFromTitle,
  audioFromTitle,
  explicitPtAudio,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import * as tmdb from '../utils/tmdb.js';
import { accountScope, streamsCacheKey } from '../utils/request-key.js';
import { createLatestWriter } from '../utils/latest-writer.js';
import { planJackettQueries, ptSweepIndexers, ptSweepQueryFor, liveIndexers } from './search-plan.js';
import { collectWithinWindow } from './collection-window.js';
import { raceWithDeadline, remainingCheckBudget } from '../utils/deadline.js';
import * as releaseIndex from '../utils/release-index.js';
import * as harvester from './harvester.js';
import { opts, prefix, capture, run, origin } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { noteUserRequest } from './activity.js';
import { registerSeasonSearchKey, autofetchRunnerStatus } from './autofetch-runner.js';
import { applyDebrid, nomeiaEpisodio } from './debrid-pipeline.js';
import { SAFE_INDEXER_ID, buildStreams, applyNoticeOrigin, onlyNotice } from './stream-builder.js';

// Buscas idênticas simultâneas (Stremio pede stream de vários clientes) compartilham a mesma promise.
const inFlight = new Map();


// Refresh de fundo do stale-while-revalidate: mapa PRÓPRIO, separado do
// inFlight — a revalidação não coalesce com a busca síncrona do cliente nem a
// impede de começar; e uma busca síncrona em voo já reescreve o cache fresco.
const refreshing = new Map();

/**
 * A lista tem play de verdade: pelo menos um stream com url ou infoHash. O
 * item de aviso carrega só name + externalUrl. O `complete` do finish e a
 * elegibilidade do SWR usam o MESMO teste, senão os critérios divergem e o
 * stale serviria uma lista que nunca deveria ter sido promovida a completa.
 */
function hasPlayableStream(streams: any[]) {
  return Array.isArray(streams) && streams.some((s) => s && (s.url || s.infoHash));
}

/**
 * Normaliza releases (tanto do índice quanto itens crus/debrid) e verifica se
 * cobrem os requisitos de pool.
 *
 * Se requireDubbed for true:
 *   - BR dublado -> global dublado.
 * Se requireDubbed for false:
 *   - BR dublado -> global dublado -> melhor swarm saudável (pickTopSeededCandidates).
 */
function poolCovered(
  items: any[],
  { season, requireDubbed = false }: { season?: number | null; requireDubbed?: boolean } = {},
) {
  if (!Array.isArray(items) || items.length === 0) return false;
  const pseudo = items.map((r) => {
    const title = String(r.title || r.Title || r.name || '').trim();
    const isBr = Boolean(r.isBr);
    const dubbed = r.dubbed !== undefined
      ? Boolean(r.dubbed)
      : isBr
        ? ['Dublado', 'Dual', 'Nacional'].includes(String(audioFromTitle(title)))
        : explicitPtAudio(title);
    const quality = r.quality || qualityFromTitle(title);
    const seeders = Number(r.seeders ?? r.Seeders ?? r._seeders ?? 0) || 0;
    const hash = String(r.hash || extractInfoHash(r.infoHash || r.magnet || '') || '').toLowerCase();

    return {
      title,
      name: title,
      infoHash: hash,
      _seeders: seeders,
      _quality: quality,
      _br: isBr,
      // O degrau "dublado global" do pool lê este flag: sem ele anyDubbedPool
      // devolveria vazio SEMPRE e o degrau seria código morto.
      _dubbed: dubbed,
      season: r.season,
      episode: r.episode,
    };
  });

  if (pickBrDubbedCandidates(pseudo as any, new Set(), 1).length > 0) return true;
  if (pickAnyDubbedCandidates(pseudo as any, new Set(), 1).length > 0) return true;
  if (requireDubbed) return false;
  return pickTopSeededCandidates(pseudo as any, new Set(), 1, {
    minSeeders: config.debrid.autoFetchMinSeeders,
  }).length > 0;
}



/**
 * "Índice cobre" NUNCA é contagem pura. Uma temporada indexada só com
 * legendado não pode impedir a busca BR dublada de rodar — então o critério é
 * a MESMA noção de pool que o autofetch já usa: BR dublado → global dublado →
 * melhor swarm saudável. Qualquer um desses pools com candidato serve.
 *
 * E, em busca de EPISÓDIO, pack de temporada não decide sozinho. O caso
 * medido: "True Detective 2ª Temporada [1080p DUBLADO 22.41 GB]" sustentava a
 * cobertura de S02E01, a busca era servida do índice, e o dublado DO EPISÓDIO
 * que a coleta ao vivo traria nunca aparecia — o pack promete a temporada, não
 * a faixa de áudio daquele episódio, e quem descobre a diferença é o usuário
 * no play. Mesmo princípio do `isSeasonPackFillEligible`: pack só vale como
 * promessa quando prova o que promete.
 *
 * O pack continua ENTRANDO na lista (ele é fonte tocável de verdade); ele só
 * não decide mais que o Jackett pode ficar de fora.
 */
function idxPoolCovered(
  releases: any[],
  { season = null, episode = null }: { season?: number | null; episode?: number | null } = {},
) {
  if (season != null && episode != null) {
    const nomeados = releases.filter((r) => nomeiaEpisodio(r?.title, season, episode));
    if (nomeados.length === 0) {
      metrics.count('search.idx.packOnly');
      return false;
    }
  }
  return poolCovered(releases, { season, requireDubbed: false });
}

/** Release do índice → item cru no formato que o buildStreams já consome. */
function idxReleasesToRaw(releases: any[]) {
  return releases.map((r) => ({
    title: r.title,
    infoHash: r.hash,
    seeders: r.seeders,
    size: r.size ?? undefined,
    indexer: r.indexer,
    tracker: r.indexer,
    isBr: r.isBr,
    dubbed: r.dubbed,
    lied: Boolean(r.lied),
  }));
}

async function collectRaw(
  query: string,
  type: string,
  imdbId: string,
  ptQuery: string | null,
  matchContext: MatchContext,
  onLate: ((items: any[], grew: boolean, partial?: boolean) => any) | null,
  sweepQuery: string | null = null,
  deadlineAt: number | null = null,
) {
  const { providers } = opts();
  const mode = providers.includes('both') ? 'both' : providers[0] || config.provider;
  const tasks: { promise: Promise<any>; priority: boolean; source?: string }[] = [];
  const addTask = (promise: Promise<any>, priority = false, source?: string) => tasks.push({ promise, priority, source });
  let sweepInline = false;

  if (mode === 'demo') {
    return {
      items: await demo.search({ type, imdbId }), partial: false, completion: Promise.resolve(), sweepInline: false,
    };
  }

  const wants = (name: string) => mode === 'both' || providers.includes(name);
  const rawSelected: string[] = [...new Set((opts().jackettIndexers || []).filter((id: any) =>
    SAFE_INDEXER_ID.test(String(id)),
  ))].map(String);
  // Index-only ficam fora do caminho da resposta (colhem em fundo para o
  // índice). O filtro é ANTES do plano: se o operador mandou todos os
  // selecionados embora, o resultado é NENHUMA consulta Jackett — cair no
  // fallback `/all` reabriria a porta que o filtro acabou de fechar.
  const selectedIndexers = liveIndexers(rawSelected, config.jackett.indexOnlyIndexers);
  if (selectedIndexers.length < rawSelected.length) {
    metrics.count('search.indexonly.excluded', rawSelected.length - selectedIndexers.length);
  }

  // demo sempre disponível como fallback de teste se quiser both+demo — aqui só jackett/prowlarr
  if (wants('jackett')) {
    if (rawSelected.length > 0 && selectedIndexers.length === 0) {
      // Todos os selecionados são index-only: a resposta sai do índice +
      // inventário; a obra entra na fila do colhedor pelo caminho de sempre.
      metrics.count('search.indexonly.all');
    } else if (selectedIndexers.length === 0) {
      addTask(jackett.search(query, type));
    } else {
      const plan = planJackettQueries(
        query,
        ptQuery,
        selectedIndexers,
        config.jackett.ptBrIndexers,
        config.jackett.slowIndexers,
        sweepQuery,
      );
      for (const planned of plan) {
        const priority = planned.indexers.some((indexer) =>
          config.jackett.ptBrIndexers.includes(indexer),
        );
        const inlineSweep = Boolean(sweepQuery) && sweepQuery !== query && planned.query === sweepQuery;
        if (inlineSweep) sweepInline = true;
        addTask(jackett.search(planned.query, type, planned.indexers, {
          fallbackQuery: planned.fallback,
          variantQuery: planned.variant,
          matchContext,
          // A mesma busca principal atualiza o status deste indexer. Falha da
          // variante pt-BR não pode sobrescrever aquele resultado como offline.
          recordStatus: inlineSweep ? false : undefined,
        }), priority);
      }
    }
  }
  if (wants('prowlarr')) {
    addTask(prowlarr.search(query));
  }

  // Se misconfigurou PROVIDER, tenta jackett
  const validProvider = providers.some((name: string) => ['jackett', 'prowlarr', 'demo', 'both'].includes(name));
  if (tasks.length === 0 && providers.length > 0 && !validProvider) {
    addTask(jackett.search(query, type));
  }

  // Fonte BR dublada, independente do PROVIDER: entra no mesmo allSettled,
  // então se o site cair ou demorar, o resto da busca sai normalmente.
  if (config.bludv.enabled) {
    // Sites BR indexam por título pt-BR ("Coringa", não "Joker").
    addTask(bludv.search(ptQuery || query), true);
  }

  // A conta do debrid como fonte: o que já está pronto lá entra com ⚡ sem
  // indexer nenhum. Teto curto dentro da própria tarefa (ver account.js)
  // para a primeira leitura não segurar a resposta.
  const accountSource = config.debrid.inventorySource && Boolean(debrid.current());
  if (accountSource) {
    addTask(account.search(matchContext), false, 'account');
  }

  // Orçamento menor que o deadline da resposta: o resto do tempo é da checagem
  // no debrid, que ainda precisa rodar em cima do que foi coletado.
  //
  // PLANO_MELHORIAS 4.3: o piso de 500ms é intencional, não sobra de fatia
  // fixa. Quando metadados lentos (Cinemeta+TMDB) já corroeram a reserva, o
  // valor calculado fica negativo — sem piso, a coleta abriria mão de tentar
  // e a resposta sairia de bandeja para known:false/lista vazia. Isso NUNCA
  // estoura o `replyDeadline`: o `raceWithDeadline` de `findStreams` corta
  // `doSearch` no relógio absoluto (mesmo `deadlineAt`), independente do que
  // este orçamento interno decide — o pior caso é a resposta chegar ATÉ 500ms
  // mais perto do corte externo, nunca depois dele. Trocar por 0 no lugar do
  // piso não evita esse corte (o relógio externo já protege), só troca uma
  // tentativa de coleta real por known:false garantido — pior para o usuário.
  const budget = deadlineAt == null
    ? Math.max(1000, config.replyDeadline - config.debridReserve)
    : Math.max(500, (remainingCheckBudget(deadlineAt) ?? 0) - config.debridReserve);
  // A graça sai da reserva, mas nunca invade o piso configurado pro debrid. No
  // caso
  // medido de Disclosure Day, a primeira fonte BR chegava pouco depois dos 5s;
  // sem esta janela a UI ficava para sempre com os 11 globais do passe parcial.
  // Série também precisa dela (medido em A Casa do Dragão: os BR terminavam a
  // 5,9-8,7s e o E01 dublado nunca entrava na primeira resposta), mas SÓ com
  // itens no balde: balde vazio cai no fallback de pack, e consumir a graça
  // nessa hora roubaria o tempo dele.
  const priorityGrace = Math.min(
    config.brPartialGrace,
    Math.max(0, config.debridReserve - config.debridCheckFloor),
  );
  let watchLate = false;
  let firstLateBatch = false;
  let lateQueue = Promise.resolve();
  // Fast-path da conta: inventário suficiente responde NA HORA e o resto da
  // coleta segue em fundo. A resposta sai partial de propósito — é isso que
  // faz o passe tardio promovê-la quando os indexers fecharem.
  const fastPathOn = config.accountFastPath.enabled && accountSource;
  const collected = await collectWithinWindow(tasks, {
    budgetMs: budget,
    priorityGraceMs: priorityGrace,
    graceRequiresItems: type !== 'movie',
    stopWhen: fastPathOn
      ? (batch: any[], _items: any[], meta: any) => {
        if (meta?.source !== 'account' || !Array.isArray(batch)) return false;
        if (batch.length < config.accountFastPath.minReleases) {
          metrics.count('search.fastPath.skipped');
          return false;
        }
        const userPreferDubbed = opts().preferDubbed;
        if (userPreferDubbed) {
          const covered = poolCovered(batch, { season: matchContext.season, requireDubbed: true });
          if (!covered) {
            metrics.count('search.fastPath.skipped');
            return false;
          }
        }
        metrics.count('search.account.sufficient');
        metrics.count('search.fastPath');
        metrics.count('search.fastPath.covered');
        log.info(`[search] conta suficiente (${batch.length} release(s)); respondendo sem esperar a coleta`);
        return true;
      }
      : undefined,
    onError: (err) => log.warn('[search] provider falhou:', err?.message || err),
    onBatch: (batch, allItems) => {
      if (!watchLate || firstLateBatch || !batch.length || !onLate) return;
      firstLateBatch = true;
      const snapshot = [...allItems];
      log.info(`[search] primeira fonte tardia chegou; recacheando ${snapshot.length} resultado(s)`);
      // Atualiza cedo a lista que o cliente está repetindo, mas mantém partial:
      // outros indexers ainda trabalham e a promoção definitiva vem abaixo.
      lateQueue = Promise.resolve(onLate(snapshot, true, true)).catch((err) => {
        log.warn('[search] passe tardio intermediário falhou:', err?.message || err);
      });
    },
  });
  if (collected.stoppedEarly) log.info(`[search] fast-path da conta: resposta antecipada com ${collected.items.length} resultado(s)`);
  const bucket = collected.items;
  const done = collected.done;
  let completion = collected.completion;

  if (!done) {
    if (collected.prioritySeen && priorityGrace) {
      log.info(`[search] primeira fonte BR incluída na janela extra de até ${priorityGrace}ms`);
    }
    log.warn(`[search] orçamento de ${budget}ms esgotado; seguindo com ${bucket.length} resultado(s) parcial(is)`);
    // Os providers continuam trabalhando depois que a resposta sai. Quem paga
    // esse atraso são justamente as fontes BR (raspam WordPress e ainda seguem
    // protetor de link): descartar o que elas trouxeram atrasadas obrigava o
    // usuário a fechar e reabrir a lista pra vê-las. Aqui o resultado completo
    // reescreve o cache, então a próxima chamada do Stremio já vem cheia.
    const soFar = bucket.length;
    if (onLate) {
      watchLate = true;
      completion = collected.completion
        .then(() => lateQueue)
        .then(() => {
          const grew = bucket.length > soFar;
          if (grew) {
            log.info(`[search] fontes lentas chegaram: ${soFar} → ${bucket.length} resultado(s); recacheando`);
          }
          // Mesmo sem nada novo o passe tardio precisa avisar: a lista servida
          // saiu marcada como parcial (cacheMaxAge 0) e, sem esta chamada, ela
          // ficava parcial até o TTL expirar — o cliente repergunta em loop e
          // nunca recebe uma resposta que possa guardar.
          return onLate(bucket, grew, false);
        })
        .catch((err) => log.warn('[search] passe tardio falhou:', err?.message || err));
    }
  }
  // `partial` acompanha o lote até a resposta HTTP: quem recebe uma lista
  // incompleta não pode cacheá-la por 15 minutos (ver o handler em addon.js).
  return { items: bucket, partial: !done, completion, sweepInline };
}

async function findStreams({ type, id, background }: { type: string; id: string; background?: boolean }) {
  if (!background) {
    noteUserRequest();
  }
  if (!id || !String(id).startsWith('tt')) {
    return { streams: [], partial: false };
  }
  if (!background) {
    metrics.count('stream.request');
  } else {
    metrics.count('autofetch.prefetch');
  }

  // A config do usuário entra na chave: dois install URLs com qualidades ou
  // debrid diferentes não podem compartilhar o mesmo resultado cacheado.
  // A URL de play leva a configuração e a assinatura da conta que construiu o
  // stream. Compartilhar cache entre duas API keys entregaria a URL (e a conta)
  // do primeiro usuário ao segundo; o digest isola sem persistir a credencial.
  // É configuração do operador, mas muda url/infoHash de cada stream e por
  // isso precisa fazer parte do shape persistido como as opções da instalação.
  const requestOpts = opts();
  const cacheKey = streamsCacheKey(type, id, { ...requestOpts, resolveUncached: config.debrid.resolveUncached });
  if (type === 'series' && requestOpts.debridApiKey) {
    const { imdbId, season } = parseStremioId(id);
    const adapter = debrid.current();
    if (season != null && adapter) {
      registerSeasonSearchKey(adapter.id, accountScope(requestOpts.debridApiKey), imdbId, season, cacheKey);
    }
  }
  // getWithStale em vez de get(): o get() APAGA a entrada expirada, e é
  // justamente ela que o SWR quer servir enquanto o refresh de fundo roda.
  // Graça 0 restaura a semântica dura anterior (kill-switch).
  const grace = config.streamStaleGrace;
  const hit = grace > 0
    ? cache.getWithStale(cacheKey, grace)
    : (() => {
        const value = cache.get(cacheKey);
        return value ? { value, stale: false } : null;
      })();
  if (hit) {
    const cached = hit.value;
    // O cache em SQLite sobrevive ao deploy, e a versão anterior gravava só o
    // array de streams. Sem esta linha, a primeira subida serviria `undefined`
    // por até 15 minutos em cima das entradas antigas.
    if (Array.isArray(cached)) {
      if (background && (!cached.length || onlyNotice(cached))) metrics.count('autofetch.prefetch.empty');
      return { streams: cached, partial: false };
    }
    if (!hit.stale) {
      if (background && (!cached?.streams?.length || onlyNotice(cached?.streams))) {
        metrics.count('autofetch.prefetch.empty');
      }
      return cached;
    }
    // Expirada DENTRO da janela de graça: responde na hora e revalida em
    // fundo. Só entra lista completa com debrid conferido e stream tocável —
    // aviso e parcial estenderiam o estado ruim em vez de consertá-lo.
    if (staleRefreshEligible(cached)) {
      metrics.count('search.swr.served');
      scheduleStaleRefresh(cacheKey, { type, id }, capture());
      if (background && (!cached?.streams?.length || onlyNotice(cached?.streams))) {
        metrics.count('autofetch.prefetch.empty');
      }
      return cached;
    }
    // Inelegível: cai na busca síncrona abaixo; a entrada velha fica no cache
    // até a reescrita (getWithStale não apaga).
  }

  // deadlineAt é compartilhado entre o passo de resposta e a checagem de cache:
  // a coleta não pode consumir tudo e deixar zero pro debrid. Passado adiante
  // como parte do input do builder, só o passo de resposta carrega — o passe
  // tardio (late/onBatch) chama finish sem deadlineAt e usa o timeout completo.
  const deadlineAt = Date.now() + config.replyDeadline;

  let task = inFlight.get(cacheKey);
  if (!task) {
    // Mede até a RESPOSTA — que é onde `doSearch` resolve. A coleta pode
    // continuar depois disso (fontes BR não cabem no orçamento), e esse rabo é
    // medido separado, em `search.late`: juntar os dois num número só faria a
    // busca fria parecer lenta e a quente parecer rápida pelo motivo errado.
    const done = metrics.timed('search.response');
    task = doSearch({ type, id, cacheKey, deadlineAt }).finally(() => {
      inFlight.delete(cacheKey);
      done();
    });
    // Se ninguém estiver ouvindo quando ela terminar, o resultado ainda vai pro cache;
    // o catch evita unhandled rejection depois que o deadline devolveu [].
    task.catch((err: any) => log.warn('[search] falhou em background:', err.message));
    inFlight.set(cacheKey, task);
  } else {
    metrics.count('stream.coalesced');
  }

  // O cliente Stremio aborta em 10s. Devolvemos vazio antes disso em vez de
  // estourar o timeout dele — a busca continua e popula o cache pra próxima.
  const res: any = await raceWithDeadline(task, config.replyDeadline, () => {
    // Contador separado do timer: a busca que estoura o prazo termina depois e
    // entra no p95 como sucesso lento. Só isto conta quantas vezes o CLIENTE
    // recebeu lista parcial.
    metrics.count('search.deadline');
    log.warn(`[search] deadline de ${config.replyDeadline}ms atingido para ${id}; segue em background`);
    // Quarto estado do aviso, e o único que NÃO sai do buildStreams: aqui a busca
    // nem terminou, enquanto os outros três explicam uma lista que ficou vazia
    // depois de buscar. Vale para filme também — a coleta segue para os dois, e a
    // próxima pergunta pega o cache já preenchido.
    const streams = config.search.noticeStream
      ? [{ name: 'Procurando fontes — reabra em instantes', notice: true }]
      : [];
    return { streams, partial: true };
  });

  if (background && (!res?.streams?.length || onlyNotice(res.streams))) {
    metrics.count('autofetch.prefetch.empty');
  }
  return res;
}

/**
 * O refresh sem teto só pode ser dispensado quando a entrada cacheada nasceu de
 * uma checagem de cache CONFIÁVEL. `partial:false` sozinho não prova isso: ele
 * diz que a coleta acabou, não que alguém perguntou ao debrid.
 *
 * A diferença aparecia inteira na AllDebrid, cuja consulta disputa o prazo sem
 * poder ser abortada (o /magnet/instant morreu; checar é dar upload). Quando a
 * corrida perdia, a busca respondia sem ⚡ e o passe tardio promovia essa mesma
 * lista a completa; o refresh — que existe justamente pra
 * recuperar o ⚡ — desistia ao ver `partial:false`. Resultado: raio nenhum, e a
 * lista sem raio cacheada como boa por CACHE_TTL.
 *
 * Entrada antiga (gravada antes deste campo existir) não tem `debridKnown`:
 * cai em `false` de propósito, paga UMA checagem tardia e se corrige sozinha.
 */
function debridRefreshSatisfied(entry: any) {
  return Boolean(entry && entry.partial === false && entry.debridKnown === true);
}

/** SWR só serve o que o finish promoveria a completa + checagem confiável. */
function staleRefreshEligible(entry: any) {
  return debridRefreshSatisfied(entry) && hasPlayableStream(entry?.streams);
}

/**
 * Resposta já saiu; a revalidação roda em fundo sem prazo de cliente. Erro
 * só vira log — nunca afeta quem recebeu a lista stale.
 */
function scheduleStaleRefresh(cacheKey: string, { type, id }: { type: string; id: string }, requestCtx: any) {
  if (refreshing.has(cacheKey)) return;
  // Busca síncrona da mesma chave já em voo reescreve o cache fresco: o
  // refresh seria trabalho duplicado.
  if (inFlight.has(cacheKey)) return;
  refreshing.set(cacheKey, true);
  metrics.count('search.swr.scheduled');
  // Fora do AsyncLocalStorage da requisição: sem restaurar o contexto,
  // opts() leria os defaults do .env e o refresh regravaria o cache com a
  // config ERRADA — mesmo padrão do runRecheck. Sem contexto capturado,
  // roda com os defaults mesmo (caso de teste/chamada fora de request).
  const ctx = requestCtx || { opts: opts(), encoded: '' };
  Promise.resolve(run(ctx, async () => {
    // Revalida antes de pagar a busca: passe tardio, recheck do autofetch ou
    // outra requisição podem ter reescrito a entrada fresca nesse meio tempo.
    const current = cache.getWithStale(cacheKey, config.streamStaleGrace);
    if (current && !current.stale) return;
    const started = Date.now();
    // Sem deadlineAt encurtado: passe de fundo tem o orçamento completo.
    await doSearch({ type, id, cacheKey, deadlineAt: Date.now() + config.replyDeadline });
    metrics.observe('search.swr', Date.now() - started);
  }))
    .catch((err) => log.warn('[search] refresh SWR falhou:', err?.message || err))
    .finally(() => refreshing.delete(cacheKey));
}

async function doSearch({ type, id, cacheKey, deadlineAt }: { type: string; id: string; cacheKey: string; deadlineAt: number }) {
  const isDemo = opts().providers.includes('demo');
  const { imdbId, season, episode } = parseStremioId(id);
  // Cinemeta e TMDB em paralelo: o título pt-BR não pode atrasar a busca.
  const [meta, titles] = await Promise.all([getMeta(type, imdbId), tmdb.getTitles(imdbId)]);
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
  let tail = Promise.resolve();
  const enqueueTail = (task: () => any) => {
    tail = tail.then(() => new Promise((resolve) => {
      const handle = setImmediate(async () => {
        try {
          await task();
        } catch (err) {
          // A fila é genérica: um task sem try/catch próprio derrubaria o processo.
          log.warn('[search] tarefa tardia falhou:', err?.message || err);
        } finally {
          resolve();
        }
      });
      handle.unref();
    }));
    return tail;
  };

  log.info(
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${opts().providers.join('+')}`,
  );

  // Fecha o pipeline sobre um lote de resultados brutos. É chamado duas vezes na
  // busca fria: com o que chegou dentro do prazo e, depois, com o lote completo
  // quando as fontes lentas terminam (aí só pra reescrever o cache).
  const finish = createLatestWriter(
    async ({ items, partial, deadlineAt: inputDeadline }) => {
      let needsDebridRefresh = false;
      let autofetchCount = 0;
      const streams = await buildStreams(items, {
        meta, titles, imdbId, season, episode, isDemo, searchKey: cacheKey,
        deadlineAt: inputDeadline,   // presente SÓ no passo de resposta
         onDebridResult: (result: any) => {
           needsDebridRefresh = needsDebridRefresh || result.needsFullRefresh;
           autofetchCount += result.autofetchCount || 0;
         },
      });
      return { streams, partial, needsDebridRefresh, autofetchCount };
    },
    ({ streams, partial, needsDebridRefresh }) => {
      // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco
      // tempo. Lote parcial idem: o passe tardio reescreve, mas se ele falhar o
      // TTL curto evita servir a lista sem as fontes BR por 15 minutos.
      const complete = hasPlayableStream(streams) && !partial && !needsDebridRefresh;
      // `debridKnown` registra se ESTA lista nasceu de uma checagem de cache
      // confiável. Sem ele, `partial:false` era usado como prova de "já
      // processado" — e o passe tardio promove a entrada SEM refazer a
      // checagem, o que congelava a lista sem ⚡ pelo TTL inteiro.
      cache.set(
        cacheKey,
        { streams, partial, debridKnown: !needsDebridRefresh },
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
    const debridKnown = hit.debridKnown === true;
    cache.set(
      cacheKey,
      { streams: hit.streams, partial: false, debridKnown },
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

  // Fase 0 do índice: simular a consulta por obra usando o raw:v1 que já
  // existe — se alguma chave bruta da obra está quente ANTES de qualquer rede,
  // um índice por obra teria acertado. É o número que autoriza (ou não) as
  // fases seguintes; não muda comportamento nenhum.
  if (config.releaseIndex.enabled && providerMode !== 'demo' && wantsJackettSweep) {
    const simIndexers: string[] = [...new Set(
      ((opts().jackettIndexers?.length ? opts().jackettIndexers : config.jackett.indexers) || [])
        .filter((i: any) => SAFE_INDEXER_ID.test(String(i))),
    )].map(String);
    if (simIndexers.length > 0) {
      const warm = jackett.rawKeysFor(simIndexers, query, type).some((k) => cache.peekRemaining(k) != null);
      metrics.count(warm ? 'search.idx.wouldHit' : 'search.idx.wouldMiss');
    }
  }

  // Fase 3: o índice é LIDO antes de qualquer indexer. Coberto pelo pool →
  // responde já e o Jackett vira segundo (tail que enriquece e promove pelo
  // mesmo SWR de sempre). Lacuna → o caminho atual roda inteiro, sem regressão.
  let servedFromIndex = false;
  let raw!: { items: any[]; partial: boolean; completion: Promise<void>; sweepInline: boolean };
  if (!isDemo && config.releaseIndex.enabled) {
    const indexed = releaseIndex.lookup(imdbId, { season, episode });
    if (indexed.length === 0) {
      metrics.count('search.idx.miss');
      harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason: 'miss' });
    } else if (idxPoolCovered(indexed, { season, episode })) {
      metrics.count('search.idx.hit');
      metrics.count('search.idx.served', indexed.length);
      servedFromIndex = true;
      // dinv entra na resposta imediata junto (idx + conta): o que já está
      // pronto na conta vira ⚡ sem indexer nenhum. Teto curto: a primeira
      // leitura do inventário custa ~700ms e a resposta não pode esperá-la.
      const accountItems = await raceWithDeadline(
        account.search(matchContext),
        config.accountFastPath.waitMs,
        () => [] as any[],
      );
      log.info(`[search] servido só pela memória: ${indexed.length} release(s) do índice para ${id}`);
      raw = {
        items: [...idxReleasesToRaw(indexed), ...accountItems],
        // partial DE PROPÓSITO: cacheMaxAge curto enquanto a coleta não fechou,
        // e o tail abaixo promove a lista enriquecida.
        partial: true,
        completion: Promise.resolve(),
        sweepInline: false,
      };
    } else {
      // Existe, mas não cobre o pool (ex.: só legendado): NUNCA impede a busca
      // BR dublada de rodar. O colhedor completa o que falta.
      metrics.count('search.idx.gap');
      harvester.enqueue({ imdbId, type: type as 'movie' | 'series', season, episode, reason: 'gap' });
    }
  }
  if (!servedFromIndex) {
    raw = await collectRaw(query, type, imdbId, ptQuery, matchContext, (items: any[], grew: boolean, partial?: boolean) =>
      late(items, grew, episodePhase, partial),
      sweepQuery,
      deadlineAt,
    );
  }

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
        const live = await collectRaw(query, type, imdbId, ptQuery, matchContext, null, sweepQuery);
        if (live.partial && live.completion) await live.completion;
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

  // Varredura pt-BR nos indexers GLOBAIS: tracker global hospeda bastante
  // dublado titulado em português ("Jornada Nas Estrelas … Dublado") que a
  // query em inglês não encontra. Roda FORA do caminho da resposta (nunca
  // disputa o orçamento), com `recordStatus:false` para a segunda consulta
  // não poluir o card de status, e `ignoreBreaker:true` para consultar
  // mesmo indexer recém-derrubado — o dublado raro mora justamente ali.
  // Só adiciona hashes novos: título pt para hash já listado é assunto do
  // merge, não da varredura.
  const configuredIndexers = opts().jackettIndexers?.length ? opts().jackettIndexers : config.jackett.indexers;
  const sweepSelectedIndexers: string[] = [...new Set((configuredIndexers || []).filter((idx: any) =>
    SAFE_INDEXER_ID.test(String(idx)),
  ))].map(String);
  // A query já foi anexada ao plano crítico: título pt-BASE para filme e série,
  // sem subtítulo, ano ou SxxEyy. Os globais publicam episódios como
  // "T01 E004"; o matchContext faz o corte preciso depois da coleta.
  if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepQuery && sweepSelectedIndexers.length > 0) {
    const sweepTargets = ptSweepIndexers(sweepSelectedIndexers, config.jackett.ptBrIndexers);
    if (sweepTargets.length > 0) {
      if (raw.partial || !raw.sweepInline) enqueueTail(async () => {
        metrics.count('search.pt-sweep.run');
        const sweepStarted = Date.now();
        try {
          // Se a coleta ainda estava aberta, espera o balde estabilizar para o
          // inventário de hashes conhecidos não sair incompleto.
          if (raw.partial && raw.completion) await raw.completion;
          const found = await jackett.search(sweepQuery, type, sweepTargets, {
            matchContext,
            recordStatus: false,
            ignoreBreaker: true,
          });
          metrics.count('search.pt-sweep.found', found.length);
          if (!found.length) return;
          const known = new Set(
            raw.items.map((item) => extractInfoHash(item.infoHash || item.magnet)).filter(Boolean),
          );
          const fresh = found.filter((item: any) => {
            const h = extractInfoHash(item.infoHash || item.magnet);
            return h && !known.has(h);
          });
          if (!fresh.length) {
            // Achou, mas tudo já era conhecido: a métrica distingue "não
            // achou" de "achou e já tínhamos" — juntar os dois escondia o
            // caso real de "varredura está caindo cedo demais".
            metrics.count('search.pt-sweep.known');
            log.info(`[search] varredura pt-BR: ${found.length} resultado(s), nenhum novo (query "${sweepQuery}")`);
            return;
          }
          raw.items.push(...fresh);
          metrics.count('search.pt-sweep.hit');
          log.info(`[search] varredura pt-BR nos globais trouxe ${fresh.length} resultado(s) novo(s) (query "${sweepQuery}"); recacheando`);
          await finish({ items: raw.items, partial: false }, responsePhase);
        } catch (err) {
          log.warn('[search] varredura pt-BR nos globais falhou:', err?.message || err);
        } finally {
          metrics.observe('search.pt-sweep', Date.now() - sweepStarted);
        }
      });
    } else {
      log.debug('[search] varredura pt-BR não executada: nenhum indexer global selecionado');
    }
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && !sweepQuery) {
    log.debug('[search] varredura pt-BR não executada: não há query localizada ativa');
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepSelectedIndexers.length === 0) {
    log.debug('[search] varredura pt-BR não executada: nenhum indexer selecionado');
  }
  return result;
}



/** Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário. */
function autofetchStatus() {
  return {
    ...autofetchRunnerStatus(),
    searchesInFlight: inFlight.size,
  };
}

export {
  findStreams, applyDebrid, buildStreams, debridRefreshSatisfied, applyNoticeOrigin, onlyNotice,
  autofetchStatus, idxPoolCovered, poolCovered,
};
