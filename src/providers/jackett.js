const config = require('../config');
const { matchesName } = require('../utils/format');

// Abaixo disso não vale abrir mais um salto de protetor de link: a requisição
// abortaria no meio e ainda gastaria o resto do orçamento.
const MIN_RESOLVE_BUDGET = 400;

// Prazo do teste manual de indexador. Nada a ver com o da busca: aqui vale
// esperar pra distinguir "indexer morto" de "indexer lento".
const DIAGNOSTIC_TIMEOUT = 30000;

function mapResults(data, { isBr = false } = {}) {
  const results = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  return results.map((r) => ({
    title: r.Title,
    magnet: r.MagnetUri || r.Guid,
    infoHash: r.InfoHash,
    seeders: r.Seeders,
    size: r.Size,
    tracker: r.Tracker || r.TrackerId,
    downloadUrl: r.Link,
    isBr,
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

async function resolveDownloadMagnet(url, budgetMs) {
  if (!url) return null;
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { Accept: 'text/plain,application/x-bittorrent' },
    signal: AbortSignal.timeout(Math.min(config.jackett.downloadTimeout, budgetMs)),
  });
  const location = response.headers.get('location');
  if (location && /^magnet:\?/i.test(location)) return location;
  if (!response.ok) return null;
  const body = await response.text();
  const match = body.match(/magnet:\?[^"'<>\s]+/i);
  return match ? match[0].replace(/&amp;/gi, '&') : null;
}

/** Milissegundos restantes do orçamento do indexer, ou 0 se já estourou. */
function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function resolveCardigannDownloads(indexer, items, query, deadline) {
  if (!config.jackett.resolveDownloadIndexers.includes(indexer)) return items;
  if (remaining(deadline) <= MIN_RESOLVE_BUDGET) {
    console.warn(`[jackett] ${indexer}: sem orçamento para resolver magnets`);
    return items;
  }
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
    // Cada salto cabe no que sobrou do orçamento: um protetor de link lento não
    // pode empurrar o indexer inteiro além do REPLY_DEADLINE.
    const budget = remaining(deadline);
    if (budget <= MIN_RESOLVE_BUDGET) return item;
    const magnet = await resolveDownloadMagnet(item.downloadUrl, budget);
    return magnet ? { ...item, magnet } : item;
  });
  const count = resolved.filter((item) => /^magnet:\?/i.test(item.magnet || '')).length;
  console.log(`[jackett] ${indexer}: ${count}/${candidates.length} magnet(s) resolvido(s)`);
  return resolved;
}

/** Orçamento que a busca AO VIVO daria a este indexer. */
function budgetFor(indexer) {
  const isSlow =
    config.jackett.ptBrIndexers.includes(indexer) || config.jackett.slowIndexers.includes(indexer);
  return isSlow ? config.jackett.brIndexerTimeout : config.jackett.indexerTimeout;
}

async function queryIndexer(indexer, query, type, timeoutOverride = null) {
  const { url, apiKey } = config.jackett;
  const endpoint = new URL(`${url}/api/v2.0/indexers/${indexer}/results`);
  endpoint.searchParams.set('apikey', apiKey);
  endpoint.searchParams.set('Query', query);
  // 2000 = Movies, 5000 = TV nos indexers Torznab
  if (type === 'movie') endpoint.searchParams.append('Category[]', '2000');
  if (type === 'series') endpoint.searchParams.append('Category[]', '5000');

  // Orçamento TOTAL do indexer (busca + resolução de magnets), não só do fetch:
  // o resolve roda fora do AbortSignal da busca e somava o próprio timeout por
  // cima, estourando o REPLY_DEADLINE e zerando o resultado. Indexers BR raspam
  // WordPress e ainda seguem protetor de link, então têm prazo maior.
  // O override existe só pro diagnóstico, que não responde a ninguém esperando.
  const timeout = timeoutOverride || budgetFor(indexer);

  const started = Date.now();
  const deadline = started + timeout;
  const res = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const isBr = config.jackett.ptBrIndexers.includes(indexer);
  const items = await resolveCardigannDownloads(
    indexer,
    mapResults(await res.json(), { isBr }),
    query,
    deadline,
  );
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

/**
 * Diagnóstico de UM indexer, pelo MESMO caminho da busca real — inclusive a
 * resolução de magnet, que é onde os indexers BR costumam falhar de verdade.
 * Devolve dado, não veredito: quem exibe decide como pintar.
 */
async function test(indexer, query, type = 'movie') {
  const started = Date.now();
  if (!config.jackett.apiKey) {
    return { indexer, ok: false, error: 'JACKETT_API_KEY não configurada', ms: 0 };
  }
  const br = config.jackett.ptBrIndexers.includes(indexer);
  const budget = budgetFor(indexer);
  // Sem query explícita, cada lado recebe o nome que ele realmente indexa: o YTS
  // não tem "Coringa" e o BLUDV não tem "Joker". Um só termo reprovaria metade
  // dos indexers saudáveis.
  //
  // E o filme não pode ser a única tentativa: indexer só de séries (eztv,
  // tokyotosho, nyaasi) devolve 0 pra qualquer filme e apareceria como quebrado.
  // Zero resultado no filme → tenta uma série antes de dar veredito.
  const attempts = query
    ? [[query, type]]
    : type === 'series'
      ? [[br ? 'A Casa do Dragão' : 'The Last of Us', 'series']]
      : [
          [br ? 'Coringa' : 'Joker', 'movie'],
          [br ? 'A Casa do Dragão' : 'The Last of Us', 'series'],
        ];
  try {
    let items = [];
    let ms = 0;
    let effective = attempts[0][0];
    let effectiveType = attempts[0][1];
    for (const [term, kind] of attempts) {
      // Prazo generoso: o diagnóstico é manual e ninguém está esperando o
      // stream. Com o orçamento da busca ao vivo, indexer vivo porém lento (eztv
      // em 4s, 1337x atrás de Cloudflare) aparecia como quebrado — o que
      // interessa é saber que ele responde E quanto tempo cobra.
      const attempt = await queryIndexer(indexer, term, kind, DIAGNOSTIC_TIMEOUT);
      ms += attempt.ms;
      effective = term;
      effectiveType = kind;
      items = attempt.items;
      if (items.length) break;
    }
    // Sem magnet o resultado é inútil pro addon: ele é descartado por falta de
    // infoHash. É a diferença entre "o site respondeu" e "dá pra assistir".
    const withMagnet = items.filter(
      (item) => item.infoHash || /^magnet:\?/i.test(String(item.magnet || '')),
    ).length;
    return {
      indexer,
      ok: withMagnet > 0,
      results: items.length,
      withMagnet,
      ms,
      sample: items[0]?.title ? String(items[0].title).slice(0, 120) : null,
      query: effective,
      type: effectiveType,
      br,
      // Quanto a busca ao vivo daria a ele, pra quem lê decidir: um indexer que
      // responde em 13s é saudável e ainda assim inútil num orçamento de 4s.
      budgetMs: budget,
      overBudget: ms > budget,
    };
  } catch (err) {
    return {
      indexer,
      ok: false,
      error: err.message || String(err),
      ms: Date.now() - started,
      budgetMs: budget,
    };
  }
}

module.exports = { search, test, name: 'jackett' };
