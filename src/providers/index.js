const config = require('../config');
const demo = require('./demo');
const jackett = require('./jackett');
const prowlarr = require('./prowlarr');
const bludv = require('./bludv');
const { getMeta } = require('../utils/cinemeta');
const {
  parseStremioId,
  buildSearchQuery,
  toStremioStream,
  sortAndLimit,
  resolveSearchNames,
  matchesEpisode,
  limitReservingBr,
  UNKNOWN_QUALITY,
  markDebridName,
  pickBrDubbedCandidate,
  hasCachedBrDubbed,
  canAutoFetchBr,
  filterKnownCache,
  filterRelevantRaw,
} = require('../utils/format');
const cache = require('../utils/cache');
const debrid = require('../debrid');
const held = require('../debrid/protected');
const tmdb = require('../utils/tmdb');
const { signResolve } = require('../utils/sign');
const { accountScope, streamsCacheKey } = require('../utils/request-key');
const { createLatestWriter } = require('../utils/latest-writer');
const { planJackettQueries } = require('./search-plan');
const { collectWithinWindow } = require('./collection-window');
const { raceWithDeadline, remainingCheckBudget } = require('../utils/deadline');
const autofetch = require('./autofetch');
const { opts, prefix } = require('../runtime');
const log = require('../utils/logger');
const metrics = require('../utils/metrics');

const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Sem fonte BR dublada tocável, manda o debrid baixar a melhor — o play passa a
 * funcionar minutos depois, sem o usuário pedir. Roda em TODA busca, então as
 * travas importam mais que a funcionalidade:
 *
 * - desligável (`autoFetchBr`), e desligado junto quando não há debrid;
 * - exige `known`: sem saber o que está em cache não há como saber o que falta,
 *   e sairíamos enfileirando torrent às cegas (Real-Debrid e Debrid-Link caem
 *   aqui — neles o /resolve do play já adiciona o magnet de qualquer forma);
 * - UM torrent por busca, o melhor candidato;
 * - marca o hash no cache ANTES de chamar a API: a mesma busca é repetida pelo
 *   Stremio e ainda passa pelo passe tardio, e sem isso cada repetição mandaria
 *   o mesmo torrent de novo;
 * - nunca entra no caminho da resposta: erro só vira log.
 */
function autoFetchCandidate(streams) {
  const { autoFetchBr, debridCachedOnly, debridApiKey } = opts();
  const adapter = debrid.current();
  // `cacheCheck: false` (Real-Debrid, Debrid-Link) fica fora: sem saber o que
  // está em cache, enfileiraríamos às cegas — e nesses serviços o /resolve do
  // play já adiciona o magnet de qualquer forma.
  // Sem cachedOnly a fonte já é devolvida como torrent P2P. Baixá-la também no
  // debrid seria um efeito colateral desnecessário na conta do usuário.
  if (!canAutoFetchBr({ autoFetchBr, debridCachedOnly }, adapter)) return null;
  const candidate = pickBrDubbedCandidate(streams);
  if (!candidate) return null;
  // Protege ANTES da checagem de cache: na AllDebrid a própria checagem apaga da
  // conta o que não está pronto, e sem isso a limpeza mataria este download
  // dentro da mesma busca.
  const account = accountScope(debridApiKey);
  held.hold(candidate.infoHash, config.debrid.autoFetchTtl, account);
  return { stream: candidate, account };
}

function autoFetchBrDubbed(streams, selected, { cached, known, season, episode, searchKey }) {
  if (!selected) return;
  const { stream: candidate, account } = selected;
  const adapter = debrid.current();

  if (!known) {
    held.release(candidate.infoHash, account);
    return;
  }

  // Qualquer fonte BR dublada já tocável encerra o autofetch. Baixar a próxima
  // release pior encheria a conta do usuário sem melhorar o play.
  if (hasCachedBrDubbed(streams, cached)) {
    held.release(candidate.infoHash, account);
    return;
  }

  const key = autofetch.markerKey(adapter.id, account, candidate.infoHash);
  if (cache.get(key)) {
    // Marker confirmado significa download iniciado: o hold pertence à chamada
    // que o aceitou e precisa sobreviver ao passe tardio até o TTL.
    return;
  }
  if (!autofetch.acquire(key)) return;
  if (!autofetch.acquireSearch(searchKey)) {
    autofetch.release(key);
    held.release(candidate.infoHash, account);
    return;
  }

  const label = String(candidate.title || candidate.name || '').split('\n')[0].slice(0, 70);
  const qStr = candidate._quality || 'N/A';
  const seedsStr = candidate._seeders != null ? ` · 👤 ${candidate._seeders}` : '';
  debrid
    .enqueue(candidate.infoHash, { season, episode })
    .then((ok) => {
      autofetch.release(key);
      if (ok) {
        // Só o aceite confirmado vira dedupe persistente. O prefixo v2 ignora
        // marcadores antigos que podiam ter sido gravados antes da chamada.
        cache.set(key, 1, config.debrid.autoFetchTtl);
        metrics.count('autofetch.enqueued');
        log.info(`[autofetch] ${adapter.label} baixando fonte BR dublada: ${label} (${qStr}${seedsStr})`);
      } else {
        autofetch.releaseSearch(searchKey);
        held.release(candidate.infoHash, account);
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} não aceitou ${candidate.infoHash}`);
      }
    })
    .catch((err) => {
      autofetch.release(key);
      autofetch.releaseSearch(searchKey);
      held.release(candidate.infoHash, account);
      log.warn('[autofetch] falhou:', err?.message || err);
    });
}

/**
 * Marca quais streams já estão cacheados no debrid e troca o infoHash por um
 * link de play que passa pela nossa rota /resolve.
 */
async function applyDebrid(streams, { season, episode, searchKey, deadlineAt, onCacheResult }) {
  const adapter = debrid.current();
  if (!adapter || streams.length === 0) return streams;

  const {
    debridCachedOnly: cachedOnly,
    showUncachedBr,
    brReservedSlots,
  } = opts();
  const { publicUrl } = config.debrid;

  // Só quem ainda é torrent tem hash pra consultar; stream já resolvido não entra no lote.
  const hashes = streams.map((s) => s.infoHash).filter(Boolean);
  if (hashes.length === 0) return streams;

  // A escolha do candidato vem antes da checagem (ela é que protege o hash da
  // limpeza); o disparo, depois — só aí sabemos se falta dublado em cache.
  const candidate = autoFetchCandidate(streams);
  const checkStarted = Date.now();
  // Teto dinâmico: o que resta do REPLY_DEADLINE menos margem para serialização.
  // null = sem teto (passe tardio usa o timeout completo do adaptador).
  // <=0 degrada na hora para known:false sem rede.
  const timeoutMs = remainingCheckBudget(
    deadlineAt,
    checkStarted,
    config.debrid.checkFormatMargin,
  );
  const { cached, known } = await debrid.checkCached(
    hashes,
    timeoutMs != null ? { timeoutMs } : {},
  );
  const checkMs = Date.now() - checkStarted;
  if (onCacheResult) {
    onCacheResult({
      known,
      // Serviço que sabe consultar cache mas voltou unknown sofreu prazo ou
      // falha. Inclusive no passe tardio isso não pode virar `debridKnown:true`.
      needsFullRefresh: adapter.cacheCheck && !known,
    });
  }
  autoFetchBrDubbed(streams, candidate, { cached, known, season, episode, searchKey });
  const ep = season != null && episode != null ? `?s=${season}&e=${episode}` : '';
  const viaDebrid = (s, instant) => {
    // Assinatura cobre hash + temporada/episódio: sem ela o /resolve rejeita,
    // então conhecer a PUBLIC_URL e um hash não basta pra gastar o debrid.
    const sig = signResolve(s.infoHash, ep);
    return {
      ...s,
      // Formato do Torrentio: [AD⚡] toca na hora, [AD download] ainda baixa.
      name: markDebridName(s.name, adapter.short || adapter.id, instant),
      url: `${publicUrl}${prefix()}/resolve/${s.infoHash}${ep}${ep ? '&' : '?'}sig=${sig}`,
      infoHash: undefined,
      sources: undefined,
    };
  };

  // Serviço que não sabe informar cache (Real-Debrid, Debrid-Link) ou resposta
  // incompleta (lote perdido no timeout): filtrar por "somente em cache"
  // esconderia a lista inteira. Mandamos tudo pelo debrid — a resolução no play
  // dirá se toca ou não. O ⚡ vai só em quem foi confirmado: numa resposta
  // parcial os demais são "não perguntei", não "não tem", e viram "download".
  if (!known) {
    // Antes só virava log: o contador é o que deixa a degradação visível no
    // /metrics.json sem precisar reler saída do container.
    metrics.count('debrid.check.unknown');
    const tetoInfo = timeoutMs != null ? `, teto ${timeoutMs}ms` : '';
    log.info(
      `[debrid] ${adapter.label} sem resposta completa de cache em ${checkMs}ms${tetoInfo}; ${streams.length} stream(s) via debrid` +
        (cached.size ? ` (${cached.size} confirmado(s) em cache)` : ''),
    );
    return streams.map((s) => viaDebrid(s, cached.has(s.infoHash)));
  }

  // O tempo entra no log porque ele é o que decide o teto: a checagem divide o
  // REPLY_DEADLINE com a coleta e disputa o event loop com os resolvedores BR,
  // que rodam neste mesmo processo.
  const tetoInfo = timeoutMs != null ? `, teto ${timeoutMs}ms` : '';
  log.info(`[debrid] ${cached.size}/${streams.length} em cache no ${adapter.label} (${checkMs}ms${tetoInfo})`);
  const filtered = filterKnownCache(streams, cached, {
    cachedOnly,
    showUncachedBr,
    brReservedSlots,
  });
  const { visibleBr } = filtered;
  if (visibleBr.size) {
    log.info(`[debrid] ${visibleBr.size} fonte(s) BR fora do cache mantida(s) como P2P`);
  }
  const out = [];
  for (const s of filtered.streams) {
    if (cached.has(s.infoHash)) {
      out.push(viaDebrid(s, true));
      continue;
    }
    out.push(s);
  }
  return out;
}

// Buscas idênticas simultâneas (Stremio pede stream de vários clientes) compartilham a mesma promise.
const inFlight = new Map();

async function collectRaw(query, type, imdbId, ptQuery, matchContext, onLate) {
  const { providers } = opts();
  const mode = providers.includes('both') ? 'both' : providers[0] || config.provider;
  const tasks = [];
  const addTask = (promise, priority = false) => tasks.push({ promise, priority });

  if (mode === 'demo') {
    return { items: await demo.search({ type, imdbId }), partial: false };
  }

  const wants = (name) => mode === 'both' || providers.includes(name);
  const selectedIndexers = [...new Set((opts().jackettIndexers || []).filter((id) =>
    SAFE_INDEXER_ID.test(String(id)),
  ))];

  // demo sempre disponível como fallback de teste se quiser both+demo — aqui só jackett/prowlarr
  if (wants('jackett')) {
    if (selectedIndexers.length === 0) {
      addTask(jackett.search(query, type));
    } else {
      for (const planned of planJackettQueries(
        query,
        ptQuery,
        selectedIndexers,
        config.jackett.ptBrIndexers,
        config.jackett.slowIndexers,
      )) {
        const priority = planned.indexers.some((indexer) =>
          config.jackett.ptBrIndexers.includes(indexer),
        );
        addTask(jackett.search(planned.query, type, planned.indexers, {
          fallbackQuery: planned.fallback,
          matchContext,
        }), priority);
      }
    }
  }
  if (wants('prowlarr')) {
    addTask(prowlarr.search(query));
  }

  // Se misconfigurou PROVIDER, tenta jackett
  const validProvider = providers.some((name) => ['jackett', 'prowlarr', 'demo', 'both'].includes(name));
  if (tasks.length === 0 && providers.length > 0 && !validProvider) {
    addTask(jackett.search(query, type));
  }

  // Fonte BR dublada, independente do PROVIDER: entra no mesmo allSettled,
  // então se o site cair ou demorar, o resto da busca sai normalmente.
  if (config.bludv.enabled) {
    // Sites BR indexam por título pt-BR ("Coringa", não "Joker").
    addTask(bludv.search(ptQuery || query), true);
  }

  // Orçamento menor que o deadline da resposta: o resto do tempo é da checagem
  // no debrid, que ainda precisa rodar em cima do que foi coletado.
  const budget = Math.max(1000, config.replyDeadline - config.debridReserve);
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
  const collected = await collectWithinWindow(tasks, {
    budgetMs: budget,
    priorityGraceMs: priorityGrace,
    graceRequiresItems: type !== 'movie',
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
  return { items: bucket, partial: !done, completion };
}

async function findStreams({ type, id }) {
  if (!id || !String(id).startsWith('tt')) {
    return { streams: [], partial: false };
  }
  metrics.count('stream.request');

  // A config do usuário entra na chave: dois install URLs com qualidades ou
  // debrid diferentes não podem compartilhar o mesmo resultado cacheado.
  // A URL de play leva a configuração e a assinatura da conta que construiu o
  // stream. Compartilhar cache entre duas API keys entregaria a URL (e a conta)
  // do primeiro usuário ao segundo; o digest isola sem persistir a credencial.
  const cacheKey = streamsCacheKey(type, id, opts());
  const cached = cache.get(cacheKey);
  // O cache em SQLite sobrevive ao deploy, e a versão anterior gravava só o
  // array de streams. Sem esta linha, a primeira subida serviria `undefined`
  // por até 15 minutos em cima das entradas antigas.
  if (Array.isArray(cached)) return { streams: cached, partial: false };
  if (cached) return cached;

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
    task.catch((err) => log.warn('[search] falhou em background:', err.message));
    inFlight.set(cacheKey, task);
  } else {
    metrics.count('stream.coalesced');
  }

  // O cliente Stremio aborta em 10s. Devolvemos vazio antes disso em vez de
  // estourar o timeout dele — a busca continua e popula o cache pra próxima.
  return raceWithDeadline(task, config.replyDeadline, () => {
    // Contador separado do timer: a busca que estoura o prazo termina depois e
    // entra no p95 como sucesso lento. Só isto conta quantas vezes o CLIENTE
    // recebeu lista parcial.
    metrics.count('search.deadline');
    log.warn(`[search] deadline de ${config.replyDeadline}ms atingido para ${id}; segue em background`);
    return { streams: [], partial: true };
  });
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
function debridRefreshSatisfied(entry) {
  return Boolean(entry && entry.partial === false && entry.debridKnown === true);
}

async function doSearch({ type, id, cacheKey, deadlineAt }) {
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

  log.info(
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${opts().providers.join('+')}`,
  );

  // Fecha o pipeline sobre um lote de resultados brutos. É chamado duas vezes na
  // busca fria: com o que chegou dentro do prazo e, depois, com o lote completo
  // quando as fontes lentas terminam (aí só pra reescrever o cache).
  const finish = createLatestWriter(
    async ({ items, partial, deadlineAt: inputDeadline }) => {
      let needsDebridRefresh = false;
      const streams = await buildStreams(items, {
        meta, titles, season, episode, isDemo, searchKey: cacheKey,
        deadlineAt: inputDeadline,   // presente SÓ no passo de resposta
        onDebridResult: (result) => { needsDebridRefresh = result.needsFullRefresh; },
      });
      return { streams, partial, needsDebridRefresh };
    },
    ({ streams, partial, needsDebridRefresh }) => {
      // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco
      // tempo. Lote parcial idem: o passe tardio reescreve, mas se ele falhar o
      // TTL curto evita servir a lista sem as fontes BR por 15 minutos.
      const complete = streams.length && !partial && !needsDebridRefresh;
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
  const late = (items, grew, phase, partial = false) => {
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
  let raw = await collectRaw(query, type, imdbId, ptQuery, matchContext, (items, grew, partial) =>
    late(items, grew, episodePhase, partial),
  );

  // Série sem candidato útil por episódio tenta o pack. Lote parcial não-vazio
  // ainda pode receber a fonte BR no passe tardio; só ampliamos o gatilho antigo
  // quando a coleta terminou e o filtro compartilhado provou que tudo era lixo.
  const relevant = filterRelevantRaw(raw.items, matchContext);
  const needsPack = raw.items.length === 0 || (!raw.partial && relevant.length === 0);
  if (needsPack && season != null && !isDemo) {
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
    raw = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, (items, grew, partial) =>
      late(items, grew, packPhase, partial),
    );
  }

  const responsePhase = finish.phase();
  const result = await finish({ ...raw, deadlineAt }, responsePhase);

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
    const refresh = setImmediate(async () => {
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
    refresh.unref();
  }
  return result;
}

/**
 * Bruto dos providers → streams do Stremio: corte por título, por episódio,
 * ordenação, debrid e limite final.
 */
async function buildStreams(
  rawInput,
  { meta, titles, season, episode, isDemo, searchKey, deadlineAt, onDebridResult },
) {
  let raw = rawInput;

  // No modo demo, se não for BBB, lista vazia (esperado)
  if (isDemo && raw.length === 0) {
    log.info('[search] modo demo: só tt1254207 (Big Buck Bunny) tem stream de teste');
  }

  // Aceita qualquer um dos nomes: release BR vem como "Coringa", a do Jackett
  // como "Joker" — filtrar só pelo inglês jogaria fora a fonte dublada.
  // As releases BR passam pelo filtro mais estrito (`matchesBrTitle`): os
  // buscadores WordPress devolvem posts "parecidos" ("Missão: Impossível –
  // Efeito Fallout" numa busca por "Fallout") que disputavam as vagas
  // reservadas com a fonte real.
  //
  // O gate é a existência de ALGUM nome, não do Cinemeta: quando ele volta 404
  // mas o TMDB responde, os nomes estão ali e o filtro precisa rodar. Preso a
  // `meta?.name` ele se desligava inteiro e a lista saía sem corte nenhum.
  const { names, year: catalogYear } = resolveSearchNames({ meta, titles });
  if (names.length && !isDemo) {
    const before = raw.length;
    raw = filterRelevantRaw(raw, {
      names,
      year: catalogYear,
      isSeries: season != null,
      // O filtro de episódio continua separado abaixo para manter os logs por
      // motivo; aqui compartilhamos apenas a decisão de título.
    });
    if (before !== raw.length) log.info(`[search] ${before - raw.length} resultado(s) fora do título descartado(s)`);
  }

  // Série: o indexer responde a "Nome S01E01" com a temporada inteira, então
  // sem este corte a lista do E01 vinha cheia de E03/E04/E09. Packs (título com
  // a temporada e sem episódio) passam — o debrid escolhe o arquivo no play.
  if (season != null && episode != null && !isDemo) {
    const before = raw.length;
    raw = raw.filter((r) => matchesEpisode(r.title || r.Title || '', { season, episode }));
    if (before !== raw.length) {
      log.info(`[search] ${before - raw.length} resultado(s) de outro episódio descartado(s)`);
    }
  }

  // Pool maior que MAX_RESULTS: o corte final é DEPOIS do debrid, senão fontes
  // sem seeders publicados (BLUDV) e não-cacheados ocupariam as vagas e sumiriam.
  const {
    minSeeders,
    maxResults,
    qualities,
    preferDubbed,
    excludeCam,
    maxSizeGb,
    max2160p,
    max1080p,
    max720p,
    max480p,
    maxSd,
    maxUnknown,
    maxPerIndexer,
    indexerLimits,
    brReservedSlots,
    brOnly,
    brFirst,
    indexerPriority,
  } = opts();
  const safeIndexerPriority = indexerPriority
    .filter((id) => SAFE_INDEXER_ID.test(String(id)))
    .slice(0, 100);
  const safeIndexerLimits = {};
  for (const [rawId, rawLimit] of Object.entries(indexerLimits || {}).slice(0, 100)) {
    const id = String(rawId).toLowerCase();
    if (!SAFE_INDEXER_ID.test(id)) continue;
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) continue;
    safeIndexerLimits[id] = Math.min(20, Math.max(0, Math.trunc(limit)));
  }
  const qualityLimits = {
    '2160p': max2160p,
    '1080p': max1080p,
    '720p': max720p,
    '480p': max480p,
    SD: maxSd,
    // Balde separado do SD: as fontes BR não publicam resolução e zerar SD não
    // pode desligar a prioridade brasileira junto.
    [UNKNOWN_QUALITY]: maxUnknown,
  };
  let streams = sortAndLimit(raw.map(toStremioStream), {
    minSeeders,
    maxResults: maxResults * config.candidatePoolFactor,
    qualityFilter: qualities,
    season,
    episode,
    preferDubbed,
    excludeCam,
    maxSizeGb,
    qualityLimits,
    brReservedSlots,
    candidateFactor: config.candidatePoolFactor,
    brFirst,
    indexerPriority: safeIndexerPriority,
  });

  const beforeCut = await applyDebrid(streams, {
    season,
    episode,
    searchKey,
    deadlineAt,
    onCacheResult: onDebridResult,
  });
  streams = limitReservingBr(beforeCut, {
    brReservedSlots,
    maxResults,
    brOnly,
    qualityLimits,
    brFirst,
    maxPerIndexer,
    indexerLimits: safeIndexerLimits,
  });

  // "A dublada não ficou em cima" é a queixa mais comum e tem três causas
  // distintas (não veio da fonte / veio mas foi cortada / veio e ficou abaixo).
  // Sem este log as três são indistinguíveis a partir da lista final, porque o
  // corte apaga os campos internos que responderiam a pergunta.
  const brIn = beforeCut.filter((s) => s._br);
  const dubIn = brIn.filter((s) => s._dubbed);
  const head = streams.slice(0, 3).map((s) => (s.name || '').split('\n')[1] || '?').join(' / ');
  log.info(
    `[search] entrada do corte: ${beforeCut.length} stream(s), ${brIn.length} BR (${dubIn.length} dublada(s))` +
      ` | brFirst=${brFirst} preferDubbed=${preferDubbed} | topo: ${head}`,
  );

  return streams;
}

module.exports = { findStreams, applyDebrid, debridRefreshSatisfied };
