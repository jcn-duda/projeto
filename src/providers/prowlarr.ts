import config from '../config.js';
import * as log from '../utils/logger.js';

async function search(query) {
  const { url, apiKey } = config.prowlarr;
  if (!apiKey) {
    log.warn('[prowlarr] PROWLARR_API_KEY não configurada');
    return [];
  }
  if (!query) return [];

  const endpoint = new URL(`${url}/api/v1/search`);
  endpoint.searchParams.set('apikey', apiKey);
  endpoint.searchParams.set('query', query);
  // type=search é o padrão; categorias de filme/TV ficam a cargo dos indexers no Prowlarr

  try {
    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0', 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(config.searchTimeout),
    });
    if (!res.ok) {
      log.warn('[prowlarr] HTTP', res.status, await res.text().catch(() => ''));
      return [];
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data : [];
    return results.map((r) => ({
      title: r.title,
      magnet: r.magnetUrl || r.guid || r.downloadUrl,
      infoHash: r.infoHash,
      seeders: r.seeders,
      size: r.size,
      tracker: r.indexer || r.indexerId,
    }));
  } catch (err) {
    log.warn('[prowlarr]', err.message);
    return [];
  }
}

export default { search, name: 'prowlarr' };
