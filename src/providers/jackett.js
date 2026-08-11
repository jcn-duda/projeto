const config = require('../config');
const { matchesName } = require('../utils/format');

function mapResults(data) {
  const results = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  return results.map((r) => ({
    title: r.Title,
    magnet: r.MagnetUri || r.Guid,
    infoHash: r.InfoHash,
    seeders: r.Seeders,
    size: r.Size,
    tracker: r.Tracker || r.TrackerId,
    downloadUrl: r.Link,
  }));
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        output[index] = await fn(items[index]);
      } catch (error) {
        output[index] = items[index];
      }
    }
  });
  await Promise.all(workers);
  return output;
}

async function resolveDownloadMagnet(url) {
  if (!url) return null;
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { Accept: 'text/plain,application/x-bittorrent' },
    signal: AbortSignal.timeout(config.jackett.downloadTimeout),
  });
  const location = response.headers.get('location');
  if (location && /^magnet:\?/i.test(location)) return location;
  if (!response.ok) return null;
  const body = await response.text();
  const match = body.match(/magnet:\?[^"'<>\s]+/i);
  return match ? match[0].replace(/&amp;/gi, '&') : null;
}

async function resolveCardigannDownloads(indexer, items, query) {
  if (!config.jackett.resolveDownloadIndexers.includes(indexer)) return items;
  // WordPress costuma devolver posts apenas relacionados. Antes de seguir
  // protetores caros, descarta o que claramente não casa com a busca.
  const wanted = String(query || '')
    .replace(/\bS\d{1,2}(?:E\d{1,2})?\b/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const requestedSeason = String(query || '').match(/\bS(\d{1,2})(?:E\d{1,2})?\b/i);
  const candidates = items
    .filter((item) => !wanted || matchesName(item.title || '', wanted))
    .filter((item) => {
      if (!requestedSeason) return true;
      const titleSeason = String(item.title || '').match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
      return !titleSeason || Number(titleSeason[1] || titleSeason[2]) === Number(requestedSeason[1]);
    })
    .slice(0, config.jackett.maxDownloadResolves);
  const resolved = await mapLimit(candidates, config.jackett.resolveConcurrency, async (item) => {
    if (item.infoHash || /^magnet:\?/i.test(item.magnet || '')) return item;
    const magnet = await resolveDownloadMagnet(item.downloadUrl);
    return magnet ? { ...item, magnet } : item;
  });
  const count = resolved.filter((item) => /^magnet:\?/i.test(item.magnet || '')).length;
  console.log(`[jackett] ${indexer}: ${count}/${candidates.length} magnet(s) resolvido(s)`);
  return resolved;
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

  const items = await resolveCardigannDownloads(indexer, mapResults(await res.json()), query);
  return { indexer, items, ms: Date.now() - started };
}

/**
 * Consulta cada indexer em paralelo em vez do agregado /all do Jackett.
 * O /all só responde quando o indexer MAIS LENTO termina, então um indexer
 * ruim derruba a busca inteira; aqui cada um tem seu próprio timeout e o que
 * chegou a tempo é aproveitado.
 */
async function search(query, type, indexersOverride = null) {
  const { url, apiKey } = config.jackett;
  const indexers = indexersOverride == null ? config.jackett.indexers : indexersOverride;
  if (!apiKey) {
    console.warn('[jackett] JACKETT_API_KEY não configurada');
    return [];
  }
  if (!query) return [];
  if (indexersOverride != null && indexers.length === 0) return [];

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
