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
} = require('../utils/format');
const cache = require('../utils/cache');
const premiumize = require('../debrid/premiumize');
const tmdb = require('../utils/tmdb');

/**
 * Fontes BR não publicam seeders, então ficam no fim da ordenação e caem fora
 * do corte competindo com releases de centenas de seeders. Reserva algumas
 * vagas pra elas antes de aplicar MAX_RESULTS.
 */
function limitReservingBr(streams) {
  const isBr = (s) => /BLUDV|DUBLADO/i.test(s.title || '');
  const br = streams.filter(isBr).slice(0, config.brReservedSlots);
  if (br.length === 0) return streams.slice(0, config.maxResults);

  const rest = streams.filter((s) => !br.includes(s));
  return [...br, ...rest].slice(0, config.maxResults);
}

/**
 * Marca quais streams já estão cacheados no debrid e troca o infoHash por um
 * link de play que passa pela nossa rota /resolve.
 */
async function applyDebrid(streams, { season, episode }) {
  const { service, cachedOnly, publicUrl } = config.debrid;
  if (service !== 'premiumize' || streams.length === 0) return streams;

  const cached = await premiumize.checkCached(streams.map((s) => s.infoHash));
  console.log(`[debrid] ${cached.size}/${streams.length} em cache no premiumize`);

  const ep = season != null && episode != null ? `?s=${season}&e=${episode}` : '';
  const out = [];
  for (const s of streams) {
    const isCached = cached.has(s.infoHash);
    if (!isCached) {
      // Sem cache: mantém como torrent P2P, a não ser que o usuário só queira cacheado.
      if (!cachedOnly) out.push(s);
      continue;
    }
    out.push({
      ...s,
      name: s.name.replace('Adom', 'Adom ⚡'),
      url: `${publicUrl}/resolve/${s.infoHash}${ep}`,
      infoHash: undefined,
      sources: undefined,
    });
  }
  return out;
}

// Buscas idênticas simultâneas (Stremio pede stream de vários clientes) compartilham a mesma promise.
const inFlight = new Map();

async function collectRaw(query, type, imdbId, ptQuery) {
  const mode = config.provider;
  const tasks = [];

  if (mode === 'demo') {
    return demo.search({ type, imdbId });
  }

  // demo sempre disponível como fallback de teste se quiser both+demo — aqui só jackett/prowlarr
  if (mode === 'jackett' || mode === 'both') {
    tasks.push(jackett.search(query, type));
  }
  if (mode === 'prowlarr' || mode === 'both') {
    tasks.push(prowlarr.search(query));
  }

  // Se misconfigurou PROVIDER, tenta jackett
  if (tasks.length === 0) {
    tasks.push(jackett.search(query, type));
  }

  // Fonte BR dublada, independente do PROVIDER: entra no mesmo allSettled,
  // então se o site cair ou demorar, o resto da busca sai normalmente.
  if (config.bludv.enabled) {
    // Sites BR indexam por título pt-BR ("Coringa", não "Joker").
    tasks.push(bludv.search(ptQuery || query));
  }

  // allSettled: um indexer fora do ar não pode derrubar a busca inteira no modo "both".
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((r) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn('[search] provider falhou:', r.reason?.message || r.reason);
    return [];
  });
}

async function findStreams({ type, id }) {
  if (!id || !String(id).startsWith('tt')) {
    return [];
  }

  const cacheKey = `streams:${type}:${id}:${config.provider}`;
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
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${config.provider}`,
  );

  let raw = await collectRaw(query, type, imdbId, ptQuery);

  // Série sem resultado por episódio: tenta o pack da temporada (ex.: "Nome S01").
  if (raw.length === 0 && season != null && config.provider !== 'demo') {
    const packQuery = `${meta?.name || imdbId} S${String(season).padStart(2, '0')}`;
    console.log(`[search] sem resultados; tentando pack "${packQuery}"`);
    raw = await collectRaw(packQuery, type, imdbId);
  }

  // No modo demo, se não for BBB, lista vazia (esperado)
  if (config.provider === 'demo' && raw.length === 0) {
    console.log('[search] modo demo: só tt1254207 (Big Buck Bunny) tem stream de teste');
  }

  if (meta?.name && config.provider !== 'demo') {
    // Aceita qualquer um dos nomes: release BR vem como "Coringa", a do Jackett
    // como "Joker" — filtrar só pelo inglês jogaria fora a fonte dublada.
    const names = [meta.name, titles?.pt, titles?.original].filter(Boolean);
    const before = raw.length;
    raw = raw.filter((r) => names.some((n) => matchesName(r.title || r.Title || '', n)));
    if (before !== raw.length) console.log(`[search] ${before - raw.length} resultado(s) fora do título descartado(s)`);
  }

  // Pool maior que MAX_RESULTS: o corte final é DEPOIS do debrid, senão fontes
  // sem seeders publicados (BLUDV) e não-cacheados ocupariam as vagas e sumiriam.
  let streams = sortAndLimit(raw.map(toStremioStream), {
    minSeeders: config.minSeeders,
    maxResults: config.maxResults * config.candidatePoolFactor,
    qualityFilter: config.qualityFilter,
  });

  streams = limitReservingBr(await applyDebrid(streams, { season, episode }));

  // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco tempo.
  cache.set(cacheKey, streams, streams.length ? config.cacheTtl : Math.min(config.cacheTtl, 60));
  console.log(`[search] ${streams.length} stream(s) para ${id}`);
  return streams;
}

module.exports = { findStreams };
