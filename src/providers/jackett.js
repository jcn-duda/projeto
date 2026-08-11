const config = require('../config');

function mapResults(data) {
  const results = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  return results.map((r) => ({
    title: r.Title,
    magnet: r.MagnetUri || r.Guid,
    infoHash: r.InfoHash,
    seeders: r.Seeders,
    size: r.Size,
    tracker: r.Tracker || r.TrackerId,
  }));
}

async function queryIndexer(indexer, query, type) {
  const { url, apiKey } = config.jackett;
  const endpoint = new URL(`${url}/api/v2.0/indexers/${indexer}/results`);
  endpoint.searchParams.set('apikey', apiKey);
  endpoint.searchParams.set('Query', query);
  // 2000 = Movies, 5000 = TV nos indexers Torznab
  if (type === 'movie') endpoint.searchParams.append('Category[]', '2000');
  if (type === 'series') endpoint.searchParams.append('Category[]', '5000');

  const started = Date.now();
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
    signal: AbortSignal.timeout(config.jackett.indexerTimeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const items = mapResults(await res.json());
  return { indexer, items, ms: Date.now() - started };
}

/**
 * Consulta cada indexer em paralelo em vez do agregado /all do Jackett.
 * O /all só responde quando o indexer MAIS LENTO termina, então um indexer
 * ruim derruba a busca inteira; aqui cada um tem seu próprio timeout e o que
 * chegou a tempo é aproveitado.
 */
async function search(query, type) {
  const { url, apiKey, indexers } = config.jackett;
  if (!apiKey) {
    console.warn('[jackett] JACKETT_API_KEY não configurada');
    return [];
  }
  if (!query) return [];

  if (indexers.length === 0) {
    // Sem lista configurada, cai no agregado (sujeito ao indexer mais lento).
    try {
      const endpoint = new URL(`${url}/api/v2.0/indexers/all/results`);
      endpoint.searchParams.set('apikey', apiKey);
      endpoint.searchParams.set('Query', query);
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
        signal: AbortSignal.timeout(config.searchTimeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return mapResults(await res.json());
    } catch (err) {
      console.warn('[jackett]', err.message);
      return [];
    }
  }

  const settled = await Promise.allSettled(
    indexers.map((i) => queryIndexer(i, query, type)),
  );

  const out = [];
  const slow = [];
  for (let idx = 0; idx < settled.length; idx += 1) {
    const r = settled[idx];
    if (r.status === 'fulfilled') {
      out.push(...r.value.items);
      if (r.value.ms > 2000) slow.push(`${r.value.indexer} ${(r.value.ms / 1000).toFixed(1)}s`);
    } else {
      slow.push(`${indexers[idx]} ✗`);
    }
  }
  if (slow.length) console.warn('[jackett] lentos/falharam:', slow.join(', '));
  return out;
}

module.exports = { search, name: 'jackett' };
