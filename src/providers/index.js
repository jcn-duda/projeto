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
  matchesEpisode,
  limitReservingBr,
} = require('../utils/format');
const cache = require('../utils/cache');
const debrid = require('../debrid');
const tmdb = require('../utils/tmdb');
const { signResolve } = require('../utils/sign');
const { opts, prefix } = require('../runtime');

const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Marca quais streams já estão cacheados no debrid e troca o infoHash por um
 * link de play que passa pela nossa rota /resolve.
 */
async function applyDebrid(streams, { season, episode }) {
  const adapter = debrid.current();
  if (!adapter || streams.length === 0) return streams;

  const { debridCachedOnly: cachedOnly } = opts();
  const { publicUrl } = config.debrid;

  // Só quem ainda é torrent tem hash pra consultar; stream já resolvido não entra no lote.
  const hashes = streams.map((s) => s.infoHash).filter(Boolean);
  if (hashes.length === 0) return streams;

  const { cached, known } = await debrid.checkCached(hashes);
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

  // Serviço que não sabe informar cache (Real-Debrid, AllDebrid, Debrid-Link):
  // filtrar por "somente em cache" esconderia a lista inteira. Mandamos tudo
  // pelo debrid, sem o ⚡ — a resolução no play dirá se toca ou não.
  if (!known) {
    console.log(`[debrid] ${adapter.label} não informa cache; ${streams.length} stream(s) via debrid`);
    return streams.map((s) => viaDebrid(s, false));
  }

  console.log(`[debrid] ${cached.size}/${streams.length} em cache no ${adapter.label}`);
  const out = [];
  for (const s of streams) {
    if (cached.has(s.infoHash)) {
      out.push(viaDebrid(s, true));
      continue;
    }
    // Sem cache: mantém como torrent P2P, a não ser que o usuário só queira cacheado.
    if (!cachedOnly) out.push(s);
  }
  return out;
}

// Buscas idênticas simultâneas (Stremio pede stream de vários clientes) compartilham a mesma promise.
const inFlight = new Map();

async function collectRaw(query, type, imdbId, ptQuery, onLate) {
  const { providers } = opts();
  const mode = providers.includes('both') ? 'both' : providers[0] || config.provider;
  const tasks = [];

  if (mode === 'demo') {
    return demo.search({ type, imdbId });
  }

  const wants = (name) => mode === 'both' || providers.includes(name);
  const selectedIndexers = [...new Set((opts().jackettIndexers || []).filter((id) =>
    SAFE_INDEXER_ID.test(String(id)),
  ))];

  // demo sempre disponível como fallback de teste se quiser both+demo — aqui só jackett/prowlarr
  if (wants('jackett')) {
    if (selectedIndexers.length === 0) {
      tasks.push(jackett.search(query, type));
    } else {
      const brIndexers = selectedIndexers.filter((indexer) =>
        config.jackett.ptBrIndexers.includes(indexer),
      );
      const globalIndexers = selectedIndexers.filter(
        (indexer) => !brIndexers.includes(indexer),
      );
      tasks.push(jackett.search(query, type, globalIndexers));
      if (brIndexers.length) tasks.push(jackett.search(ptQuery || query, type, brIndexers));
    }
  }
  if (wants('prowlarr')) {
    tasks.push(prowlarr.search(query));
  }

  // Se misconfigurou PROVIDER, tenta jackett
  const validProvider = providers.some((name) => ['jackett', 'prowlarr', 'demo', 'both'].includes(name));
  if (tasks.length === 0 && providers.length > 0 && !validProvider) {
    tasks.push(jackett.search(query, type));
  }

  // Fonte BR dublada, independente do PROVIDER: entra no mesmo allSettled,
  // então se o site cair ou demorar, o resto da busca sai normalmente.
  if (config.bludv.enabled) {
    // Sites BR indexam por título pt-BR ("Coringa", não "Joker").
    tasks.push(bludv.search(ptQuery || query));
  }

  // Cada provider despeja no balde assim que termina, em vez de todo mundo
  // esperar o último: quando o orçamento acaba, o que já chegou vale.
  const bucket = [];
  const collecting = tasks.map((task) =>
    task
      .then((items) => bucket.push(...items))
      .catch((err) => console.warn('[search] provider falhou:', err?.message || err)),
  );

  // Orçamento menor que o deadline da resposta: o resto do tempo é da checagem
  // no debrid, que ainda precisa rodar em cima do que foi coletado.
  const budget = Math.max(1000, config.replyDeadline - config.debridReserve);
  let done = false;
  await Promise.race([
    Promise.all(collecting).then(() => {
      done = true;
    }),
    new Promise((resolve) => setTimeout(resolve, budget).unref()),
  ]);

  if (!done) {
    console.warn(`[search] orçamento de ${budget}ms esgotado; seguindo com ${bucket.length} resultado(s) parcial(is)`);
    // Os providers continuam trabalhando depois que a resposta sai. Quem paga
    // esse atraso são justamente as fontes BR (raspam WordPress e ainda seguem
    // protetor de link): descartar o que elas trouxeram atrasadas obrigava o
    // usuário a fechar e reabrir a lista pra vê-las. Aqui o resultado completo
    // reescreve o cache, então a próxima chamada do Stremio já vem cheia.
    const partial = bucket.length;
    if (onLate) {
      Promise.all(collecting)
        .then(() => {
          if (bucket.length <= partial) return;
          console.log(`[search] fontes lentas chegaram: ${partial} → ${bucket.length} resultado(s); recacheando`);
          return onLate(bucket);
        })
        .catch((err) => console.warn('[search] passe tardio falhou:', err?.message || err));
    }
  }
  return bucket;
}

async function findStreams({ type, id }) {
  if (!id || !String(id).startsWith('tt')) {
    return [];
  }

  // A config do usuário entra na chave: dois install URLs com qualidades ou
  // debrid diferentes não podem compartilhar o mesmo resultado cacheado.
  const { debridApiKey, ...shape } = opts();
  const cacheKey = `streams:${type}:${id}:${JSON.stringify(shape)}:${debridApiKey ? 'dk' : ''}`;
  const cached = cache.get(cacheKey);
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
        resolve([]);
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
  const finish = async (rawItems) => {
    const streams = await buildStreams(rawItems, { meta, titles, season, episode, isDemo });
    // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco tempo.
    cache.set(cacheKey, streams, streams.length ? config.cacheTtl : Math.min(config.cacheTtl, 60));
    console.log(`[search] ${streams.length} stream(s) para ${id}`);
    return streams;
  };

  let raw = await collectRaw(query, type, imdbId, ptQuery, finish);

  // Série sem resultado por episódio: tenta o pack da temporada (ex.: "Nome S01").
  if (raw.length === 0 && season != null && !isDemo) {
    const s = String(season).padStart(2, '0');
    const packQuery = `${meta?.name || imdbId} S${s}`;
    // O fallback também precisa do título pt-BR: é justamente aqui, quando a
    // busca por episódio falhou, que as fontes BR (que só publicam pack de
    // temporada) teriam algo — e elas não indexam pelo nome em inglês.
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    console.log(
      `[search] sem resultados; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`,
    );
    raw = await collectRaw(packQuery, type, imdbId, ptPackQuery, finish);
  }

  return finish(raw);
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
    const names = [meta.name, titles?.pt, titles?.original].filter(Boolean);
    const before = raw.length;
    raw = raw.filter((r) => names.some((n) => matchesName(r.title || r.Title || '', n)));
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
    brReservedSlots,
    brOnly,
    brFirst,
  } = opts();
  const qualityLimits = {
    '2160p': max2160p,
    '1080p': max1080p,
    '720p': max720p,
    '480p': max480p,
    SD: maxSd,
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
