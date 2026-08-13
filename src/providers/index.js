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
  matchesName,
  matchesBrTitle,
  matchesEpisode,
  limitReservingBr,
  UNKNOWN_QUALITY,
  pickBrDubbedCandidate,
  hasCachedBrDubbed,
  canAutoFetchBr,
  filterKnownCache,
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
const { opts, prefix } = require('../runtime');

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

function autoFetchBrDubbed(streams, selected, { cached, known, season, episode }) {
  if (!selected) return;
  const { stream: candidate, account } = selected;
  const adapter = debrid.current();

  // Sem resposta confiável de cache, ou já existe dublado tocável: não baixa
  // nada e devolve o hash à limpeza normal.
  if (!known || hasCachedBrDubbed(streams, cached)) {
    held.release(candidate.infoHash, account);
    return;
  }

  const key = `autofetch:${adapter.id}:${account}:${candidate.infoHash}`;
  if (cache.get(key)) return;
  cache.set(key, 1, config.debrid.autoFetchTtl);

  const label = String(candidate.name || '').split('\n')[0].slice(0, 70);
  debrid
    .enqueue(candidate.infoHash, { season, episode })
    .then((ok) => {
      if (ok) console.log(`[autofetch] ${adapter.label} baixando fonte BR dublada: ${label}`);
      else {
        cache.forget(key);
        held.release(candidate.infoHash, account);
        console.warn(`[autofetch] ${adapter.label} não aceitou ${candidate.infoHash}`);
      }
    })
    .catch((err) => {
      cache.forget(key);
      held.release(candidate.infoHash, account);
      console.warn('[autofetch] falhou:', err?.message || err);
    });
}

/**
 * Marca quais streams já estão cacheados no debrid e troca o infoHash por um
 * link de play que passa pela nossa rota /resolve.
 */
async function applyDebrid(streams, { season, episode }) {
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
  const { cached, known } = await debrid.checkCached(hashes);
  const checkMs = Date.now() - checkStarted;
  autoFetchBrDubbed(streams, candidate, { cached, known, season, episode });
  const ep = season != null && episode != null ? `?s=${season}&e=${episode}` : '';
  const viaDebrid = (s, instant) => {
    // Assinatura cobre hash + temporada/episódio: sem ela o /resolve rejeita,
    // então conhecer a PUBLIC_URL e um hash não basta pra gastar o debrid.
    const sig = signResolve(s.infoHash, ep);
    return {
      ...s,
      name: instant ? `${s.name} ⚡` : s.name,
      url: `${publicUrl}${prefix()}/resolve/${s.infoHash}${ep}${ep ? '&' : '?'}sig=${sig}`,
      infoHash: undefined,
      sources: undefined,
    };
  };

  // Serviço que não sabe informar cache (Real-Debrid, Debrid-Link) ou resposta
  // incompleta (lote perdido no timeout): filtrar por "somente em cache"
  // esconderia a lista inteira. Mandamos tudo pelo debrid — a resolução no play
  // dirá se toca ou não. O ⚡ vai só em quem foi confirmado: numa resposta
  // parcial os demais são "não perguntei", não "não tem".
  if (!known) {
    console.log(
      `[debrid] ${adapter.label} sem resposta completa de cache em ${checkMs}ms; ${streams.length} stream(s) via debrid` +
        (cached.size ? ` (${cached.size} confirmado(s) em cache)` : ''),
    );
    return streams.map((s) => viaDebrid(s, cached.has(s.infoHash)));
  }

  // O tempo entra no log porque ele é o que decide o teto: a checagem divide o
  // REPLY_DEADLINE com a coleta e disputa o event loop com os resolvedores BR,
  // que rodam neste mesmo processo.
  console.log(`[debrid] ${cached.size}/${streams.length} em cache no ${adapter.label} (${checkMs}ms)`);
  const filtered = filterKnownCache(streams, cached, {
    cachedOnly,
    showUncachedBr,
    brReservedSlots,
  });
  const { visibleBr } = filtered;
  if (visibleBr.size) {
    console.log(`[debrid] ${visibleBr.size} fonte(s) BR fora do cache mantida(s) como P2P`);
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

async function collectRaw(query, type, imdbId, ptQuery, onLate) {
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
        addTask(jackett.search(planned.query, type, planned.indexers), priority);
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
  // A graça sai da reserva, mas nunca deixa menos de 2s pro debrid. No caso
  // medido de Disclosure Day, a primeira fonte BR chegava pouco depois dos 5s;
  // sem esta janela a UI ficava para sempre com os 11 globais do passe parcial.
  // Em série, a busca por episódio pode cair no fallback de pack. Consumir a
  // graça na primeira fase roubaria o tempo do pack, que é justamente onde as
  // fontes BR costumam existir.
  const priorityGrace = type === 'movie'
    ? Math.min(config.brPartialGrace, Math.max(0, config.debridReserve - 2000))
    : 0;
  const collected = await collectWithinWindow(tasks, {
    budgetMs: budget,
    priorityGraceMs: priorityGrace,
    onError: (err) => console.warn('[search] provider falhou:', err?.message || err),
  });
  const bucket = collected.items;
  const done = collected.done;

  if (!done) {
    if (collected.prioritySeen && priorityGrace) {
      console.log(`[search] primeira fonte BR incluída na janela extra de até ${priorityGrace}ms`);
    }
    console.warn(`[search] orçamento de ${budget}ms esgotado; seguindo com ${bucket.length} resultado(s) parcial(is)`);
    // Os providers continuam trabalhando depois que a resposta sai. Quem paga
    // esse atraso são justamente as fontes BR (raspam WordPress e ainda seguem
    // protetor de link): descartar o que elas trouxeram atrasadas obrigava o
    // usuário a fechar e reabrir a lista pra vê-las. Aqui o resultado completo
    // reescreve o cache, então a próxima chamada do Stremio já vem cheia.
    const soFar = bucket.length;
    if (onLate) {
      collected.completion
        .then(() => {
          const grew = bucket.length > soFar;
          if (grew) {
            console.log(`[search] fontes lentas chegaram: ${soFar} → ${bucket.length} resultado(s); recacheando`);
          }
          // Mesmo sem nada novo o passe tardio precisa avisar: a lista servida
          // saiu marcada como parcial (cacheMaxAge 0) e, sem esta chamada, ela
          // ficava parcial até o TTL expirar — o cliente repergunta em loop e
          // nunca recebe uma resposta que possa guardar.
          return onLate(bucket, grew);
        })
        .catch((err) => console.warn('[search] passe tardio falhou:', err?.message || err));
    }
  }
  // `partial` acompanha o lote até a resposta HTTP: quem recebe uma lista
  // incompleta não pode cacheá-la por 15 minutos (ver o handler em addon.js).
  return { items: bucket, partial: !done };
}

async function findStreams({ type, id }) {
  if (!id || !String(id).startsWith('tt')) {
    return { streams: [], partial: false };
  }

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

  let task = inFlight.get(cacheKey);
  if (!task) {
    task = doSearch({ type, id, cacheKey }).finally(() => inFlight.delete(cacheKey));
    // Se ninguém estiver ouvindo quando ela terminar, o resultado ainda vai pro cache;
    // o catch evita unhandled rejection depois que o deadline devolveu [].
    task.catch((err) => console.warn('[search] falhou em background:', err.message));
    inFlight.set(cacheKey, task);
  }

  // O cliente Stremio aborta em 10s. Devolvemos vazio antes disso em vez de
  // estourar o timeout dele — a busca continua e popula o cache pra próxima.
  return Promise.race([
    task,
    new Promise((resolve) =>
      setTimeout(() => {
        console.warn(`[search] deadline de ${config.replyDeadline}ms atingido para ${id}; segue em background`);
        resolve({ streams: [], partial: true });
      }, config.replyDeadline).unref(),
    ),
  ]);
}

async function doSearch({ type, id, cacheKey }) {
  const isDemo = opts().providers.includes('demo');
  const { imdbId, season, episode } = parseStremioId(id);
  // Cinemeta e TMDB em paralelo: o título pt-BR não pode atrasar a busca.
  const [meta, titles] = await Promise.all([getMeta(type, imdbId), tmdb.getTitles(imdbId)]);
  const query = buildSearchQuery(meta || { name: imdbId }, { season, episode });

  // Só vale uma query separada quando o título PT difere do original.
  const ptQuery =
    titles?.pt && titles.pt !== titles.original
      ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season, episode })
      : null;

  console.log(
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${opts().providers.join('+')}`,
  );

  // Fecha o pipeline sobre um lote de resultados brutos. É chamado duas vezes na
  // busca fria: com o que chegou dentro do prazo e, depois, com o lote completo
  // quando as fontes lentas terminam (aí só pra reescrever o cache).
  const finish = createLatestWriter(
    async ({ items, partial }) => ({
      streams: await buildStreams(items, { meta, titles, season, episode, isDemo }),
      partial,
    }),
    ({ streams, partial }) => {
      // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco
      // tempo. Lote parcial idem: o passe tardio reescreve, mas se ele falhar o
      // TTL curto evita servir a lista sem as fontes BR por 15 minutos.
      const complete = streams.length && !partial;
      cache.set(cacheKey, { streams, partial }, complete ? config.cacheTtl : Math.min(config.cacheTtl, 60));
      console.log(`[search] ${streams.length} stream(s)${partial ? ' (parcial)' : ''} para ${id}`);
    },
    (value) => Array.isArray(value?.streams) && value.streams.length > 0,
  );

  /**
   * Fim da coleta. Se as fontes lentas trouxeram algo, reconstrói tudo; se não
   * trouxeram, só promove a entrada do cache a completa — sem refazer a
   * checagem no debrid, que é a parte cara e não mudaria de resposta.
   */
  const late = (items, grew, phase) => {
    if (grew) return finish({ items, partial: false }, phase);
    // Fase diferente = o fallback de pack assumiu; promover o lote antigo aqui
    // marcaria como pronta uma busca que ainda está em andamento.
    if (phase !== finish.phase()) return undefined;
    const hit = cache.get(cacheKey);
    if (!hit?.partial) return undefined;
    cache.set(cacheKey, { streams: hit.streams, partial: false }, config.cacheTtl);
    console.log(`[search] coleta encerrada sem novidade; ${hit.streams.length} stream(s) para ${id}`);
    return undefined;
  };

  const episodePhase = finish.phase();
  let raw = await collectRaw(query, type, imdbId, ptQuery, (items, grew) =>
    late(items, grew, episodePhase),
  );

  // Série sem resultado por episódio: tenta o pack da temporada (ex.: "Nome S01").
  if (raw.items.length === 0 && season != null && !isDemo) {
    // O passe tardio da busca por episódio não pode sobrescrever o pack que
    // estamos prestes a buscar. `advance` invalida qualquer escrita antiga,
    // inclusive uma build que já começou e ainda está no debrid.
    const packPhase = finish.advance();
    const s = String(season).padStart(2, '0');
    const packQuery = `${meta?.name || imdbId} S${s}`;
    // O fallback também precisa do título pt-BR: é justamente aqui, quando a
    // busca por episódio falhou, que as fontes BR (que só publicam pack de
    // temporada) teriam algo — e elas não indexam pelo nome em inglês.
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    console.log(
      `[search] sem resultados; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`,
    );
    raw = await collectRaw(packQuery, type, imdbId, ptPackQuery, (items, grew) =>
      late(items, grew, packPhase),
    );
  }

  return finish(raw, finish.phase());
}

/**
 * Bruto dos providers → streams do Stremio: corte por título, por episódio,
 * ordenação, debrid e limite final.
 */
async function buildStreams(rawInput, { meta, titles, season, episode, isDemo }) {
  let raw = rawInput;

  // No modo demo, se não for BBB, lista vazia (esperado)
  if (isDemo && raw.length === 0) {
    console.log('[search] modo demo: só tt1254207 (Big Buck Bunny) tem stream de teste');
  }

  if (meta?.name && !isDemo) {
    // Aceita qualquer um dos nomes: release BR vem como "Coringa", a do Jackett
    // como "Joker" — filtrar só pelo inglês jogaria fora a fonte dublada.
    // As releases BR passam pelo filtro mais estrito (`matchesBrTitle`): os
    // buscadores WordPress devolvem posts "parecidos" ("Missão: Impossível –
    // Efeito Fallout" numa busca por "Fallout") que disputavam as vagas
    // reservadas com a fonte real.
    const names = [meta.name, titles?.pt, titles?.original].filter(Boolean);
    const before = raw.length;
    raw = raw.filter((r) => {
      const t = r.title || r.Title || '';
      return names.some((n) =>
        r.isBr ? matchesBrTitle(t, n, meta?.year) : matchesName(t, n),
      );
    });
    if (before !== raw.length) console.log(`[search] ${before - raw.length} resultado(s) fora do título descartado(s)`);
  }

  // Série: o indexer responde a "Nome S01E01" com a temporada inteira, então
  // sem este corte a lista do E01 vinha cheia de E03/E04/E09. Packs (título com
  // a temporada e sem episódio) passam — o debrid escolhe o arquivo no play.
  if (season != null && episode != null && !isDemo) {
    const before = raw.length;
    raw = raw.filter((r) => matchesEpisode(r.title || r.Title || '', { season, episode }));
    if (before !== raw.length) {
      console.log(`[search] ${before - raw.length} resultado(s) de outro episódio descartado(s)`);
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
    brReservedSlots,
    brOnly,
    brFirst,
    indexerPriority,
  } = opts();
  const safeIndexerPriority = indexerPriority
    .filter((id) => SAFE_INDEXER_ID.test(String(id)))
    .slice(0, 100);
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

  streams = limitReservingBr(await applyDebrid(streams, { season, episode }), {
    brReservedSlots,
    maxResults,
    brOnly,
    qualityLimits,
    brFirst,
  });

  return streams;
}

module.exports = { findStreams };
