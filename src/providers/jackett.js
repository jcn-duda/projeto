const config = require('../config');
const cache = require('../utils/cache');
const {
  matchesBrTitle,
  matchesEpisode,
  filterRelevantRaw,
  parseTitleSeasonEpisode,
  audioFromTitle,
  qualityFromTitle,
  looksPtBr,
  UNKNOWN_QUALITY,
} = require('../utils/format');
const indexerStatus = require('./indexer-status');
const { mapLimit } = require('../utils/concurrency');
const log = require('../utils/logger');
const { prefix } = require('../utils/cache-keys');

// Abaixo disso não vale abrir mais um salto de protetor de link: a requisição
// abortaria no meio e ainda gastaria o resto do orçamento.
const MIN_RESOLVE_BUDGET = 400;

// TTL do cache de magnet resolvido (7 dias em segundos). Protetor de link não
// altera o hash de uma release já publicada.
const RESOLVED_MAGNET_TTL = 7 * 24 * 3600;

// Prazo do teste manual de indexador. Nada a ver com o da busca: aqui vale
// esperar pra distinguir "indexer morto" de "indexer lento".
const DIAGNOSTIC_TIMEOUT = 30000;

function mapResults(data, { isBr = false, indexer = '' } = {}) {
  const results = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  return results.map((r) => ({
    title: r.Title,
    magnet: r.MagnetUri || r.Guid,
    infoHash: r.InfoHash,
    seeders: r.Seeders,
    size: r.Size,
    tracker: r.Tracker || r.TrackerId,
    // O ID estável vem do plano da consulta. Labels do Jackett variam e não
    // podem ser usados para casar a prioridade salva na URL.
    indexer: indexer || r.TrackerId || r.Tracker || '',
    downloadUrl: r.Link,
    // Flag do indexer OU do título: tracker global também hospeda dublado
    // titulado em português, e é o título que denuncia. Decidir só pelo
    // indexer fazia esse resultado ser julgado contra o nome em inglês e
    // morrer no filtro, além de não contar nas vagas BR.
    isBr: isBr || looksPtBr(String(r.Title || '')),
  }));
}

async function resolveDownloadMagnet(url, budgetMs) {
  if (!url) return null;
  const cacheKey = `dlmag:${url}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const response = await fetch(url, {
    redirect: 'manual',
    headers: { Accept: 'text/plain,application/x-bittorrent' },
    signal: AbortSignal.timeout(Math.min(config.jackett.downloadTimeout, budgetMs)),
  });
  const location = response.headers.get('location');
  if (location && /^magnet:\?/i.test(location)) {
    cache.set(cacheKey, location, RESOLVED_MAGNET_TTL);
    return location;
  }
  if (!response.ok) return null;
  const body = await response.text();
  const match = body.match(/magnet:\?[^"'<>\s]+/i);
  if (match) {
    const magnet = match[0].replace(/&amp;/gi, '&');
    cache.set(cacheKey, magnet, RESOLVED_MAGNET_TTL);
    return magnet;
  }
  return null;
}

/** Milissegundos restantes do orçamento do indexer, ou 0 se já estourou. */
function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

function dedupeResolveCandidates(items) {
  const seen = new Set();
  return items.filter((item) => {
    const identity = item.infoHash || item.magnet || item.downloadUrl;
    if (!identity) return true;
    const key = String(identity).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveCandidateScore(item, { season = null, episode = null } = {}) {
  const title = item.title || '';
  const parsed = parseTitleSeasonEpisode(title);
  let score = 0;
  if (season != null && episode != null) {
    if (parsed.seasons.includes(season) && parsed.episodes.includes(episode)) score += 100;
    else if (!parsed.episodes.length && parsed.seasons.length === 1 && parsed.seasons[0] === season) score += 70;
    else if (!parsed.episodes.length && parsed.seasons.includes(season)) score += 50;
    else if (!parsed.episodes.length && (parsed.complete || (parsed.seasonPack && !parsed.seasons.length))) score += 30;
  }
  const audio = audioFromTitle(title);
  if (audio === 'Dublado' || audio === 'Dual' || audio === 'Nacional') score += 20;
  const quality = qualityFromTitle(title);
  score += { '2160p': 6, '1080p': 5, '720p': 4, '480p': 3, SD: 1, [UNKNOWN_QUALITY]: 2 }[quality] || 0;
  return score;
}

async function resolveCardigannDownloads(indexer, items, query, deadline, matchContext = null) {
  if (!config.jackett.resolveDownloadIndexers.includes(indexer)) return items;
  if (remaining(deadline) <= MIN_RESOLVE_BUDGET) {
    log.warn(`[jackett] ${indexer}: sem orçamento para resolver magnets`);
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
  const requestedEp = String(query || '').match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i);
  // A query de filme carrega o ano ("Coringa 2019") — ele denuncia post de
  // outro filme antes mesmo de pagar o protetor: "Coringa: Delírio a Dois
  // (2024)" resolve magnet sem nunca entrar na lista.
  const queryYear = Number(String(query || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || 0);
  let candidates = items
    // Filtro BR estrito antes de pagar o protetor de link: post "parecido"
    // ("Missão: Impossível – Efeito Fallout" numa busca por "Fallout") não
    // merece orçamento de resolução de magnet.
    .filter((item) => {
      if (matchContext?.names?.length) {
        return filterRelevantRaw([item], matchContext).length > 0;
      }
      return !wanted || matchesBrTitle(item.title || '', wanted, queryYear || null, { isSeries: Boolean(requestedSeason) });
    })
    .filter((item) => {
      if (!requestedSeason) return true;
      const titleSeason = String(item.title || '').match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
      return !titleSeason || Number(titleSeason[1] || titleSeason[2]) === Number(requestedSeason[1]);
    })
    // Release de outro episódio morre em buildStreams de qualquer jeito —
    // resolvê-la gastava os slots (maxDownloadResolves) e 2-4s de protetor com
    // E02..E10 enquanto o E01 pedido ficava de fora. Pack continua passando.
    .filter((item) => matchContext?.season != null || !requestedEp || matchesEpisode(item.title || '', {
      season: Number(requestedEp[1]),
      episode: Number(requestedEp[2]),
    }));
  candidates = dedupeResolveCandidates(candidates)
    .map((item, order) => ({ item, order, score: resolveCandidateScore(item, matchContext || {}) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, config.jackett.maxDownloadResolves)
    .map(({ item }) => item);
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
  log.info(`[jackett] ${indexer}: ${count}/${candidates.length} magnet(s) resolvido(s)`);
  return resolved;
}

/**
 * O que o Jackett recebe como Query. Buscador WordPress engasga com "SxxEyy":
 * os resolvers locais já removem no servidor, mas indexer BR com definição
 * stock (redetorrent) recebe a query crua e devolve 0. Remover aqui também faz
 * episódios da mesma temporada compartilharem o cache do Jackett. Nos
 * `bareTitleIndexers` o ANO no fim também sai ("Coringa 2019" → 0 lá) — só o
 * do fim, senão o filme "1917" perderia o próprio título. A query original
 * segue intacta para os pré-filtros de temporada/episódio da resolução.
 */
function shapeSearchQuery(indexer, query, isBr) {
  let shaped = String(query || '');
  if (isBr) shaped = shaped.replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, ' ');
  if (config.jackett.bareTitleIndexers.includes(indexer)) {
    shaped = shaped.replace(/\s+(?:19|20)\d{2}\s*$/, ' ');
  }
  shaped = shaped.replace(/\s+/g, ' ').trim();
  return shaped || query;
}

/** Orçamento que a busca AO VIVO daria a este indexer. */
function budgetFor(indexer) {
  const isSlow =
    config.jackett.ptBrIndexers.includes(indexer) || config.jackett.slowIndexers.includes(indexer);
  return isSlow ? config.jackett.brIndexerTimeout : config.jackett.indexerTimeout;
}

// Circuit breaker: indexer offline em N amostras seguidas seguia recebendo o
// orçamento integral de busca (20s nos BR) para falhar de novo, a cada
// consulta. Com o circuito aberto — streak no limiar e última falha dentro do
// cooldown — a busca pula o indexer e devolve o prazo aos que entregam. O
// diagnóstico (test()) NÃO passa por aqui: é o caminho que conserta a fonte,
// e a meia-abertura pós-cooldown já deixa a busca reavaliar sozinha.
function breakerTripped(indexer, now = Date.now()) {
  if (!config.jackett.breakerEnabled) return false;
  const status = indexerStatus.get(indexer, now);
  if (!status || (status.failStreak || 0) < config.jackett.breakerFailures) return false;
  const failedAt = Date.parse(status.checkedAt);
  return Number.isFinite(failedAt) && now - failedAt < config.jackett.breakerCooldown;
}

// Quem já teve a abertura anunciada neste episódio — o aviso é UM por
// abertura, não por busca; sai do set quando o indexer volta a ser consultado.
const breakerAnnounced = new Set();

async function queryIndexer(indexer, query, type, timeoutOverride = null, options = {}) {
  const { url, apiKey } = config.jackett;
  const isBr = config.jackett.ptBrIndexers.includes(indexer);

  // Orçamento TOTAL do indexer (busca + resolução de magnets), não só do fetch:
  // o resolve roda fora do AbortSignal da busca e somava o próprio timeout por
  // cima, estourando o REPLY_DEADLINE e zerando o resultado. Indexers BR raspam
  // WordPress e ainda seguem protetor de link, então têm prazo maior.
  // O override existe só pro diagnóstico, que não responde a ninguém esperando.
  const timeout = timeoutOverride || budgetFor(indexer);

  const started = Date.now();
  const deadline = started + timeout;
  // O cache bruto memoiza SÓ a camada de rede: a cascata de fallback (decide
  // por relevância) e a resolução de magnets (filtra pelo episódio da query
  // original) continuam rodando por busca; num hit, cada salto de protetor
  // vira hit no cache `dlmag:` existente. Falha nunca é cacheada — o breaker
  // e o indexer-status seguem sendo a resposta para indexer fora do ar.
  // `noRawCache` é o diagnóstico: ele precisa medir a consulta de verdade.
  const rawTtl = options.noRawCache || config.rawCache.maxItems <= 0
    ? 0
    : isBr ? config.rawCache.ttlBr : config.rawCache.ttl;
  let liveFetches = 0;
  const fetchQuery = async (candidateQuery) => {
    const searchQuery = shapeSearchQuery(indexer, candidateQuery, isBr);
    // A shaped query já remove SxxEyy nos indexers BR, então episódios da
    // mesma temporada compartilham a entrada por construção — é o que faz a
    // busca tardia de pack ("Nome S03") custar uma varredura por temporada.
    const rawKey = `${prefix('raw')}jackett:${indexer}:${type}:${searchQuery}`;
    if (rawTtl > 0) {
      const hit = cache.get(rawKey);
      if (hit && Array.isArray(hit.items)) return { searchQuery, items: hit.items };
    }
    const endpoint = new URL(`${url}/api/v2.0/indexers/${indexer}/results`);
    endpoint.searchParams.set('apikey', apiKey);
    endpoint.searchParams.set('Query', searchQuery);
    // 2000 = Movies, 5000 = TV nos indexers Torznab
    if (type === 'movie') endpoint.searchParams.append('Category[]', '2000');
    if (type === 'series') endpoint.searchParams.append('Category[]', '5000');
    const budget = remaining(deadline);
    if (budget <= 0) throw new Error('timeout');
    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
      signal: AbortSignal.timeout(Math.max(1, budget)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = mapResults(await res.json(), { isBr, indexer });
    liveFetches += 1;
    if (rawTtl > 0 && items.length <= config.rawCache.maxItems) {
      // 200 com zero itens usa o TTL curto: pode ser rate-limit disfarçado.
      cache.set(rawKey, { items }, items.length === 0 ? config.rawCache.emptyTtl : rawTtl);
    }
    return { searchQuery, items };
  };

  let found = await fetchQuery(query);
  // Cadeia sequencial: primary (pt-BR) -> variante numérica -> original. Cada
  // passo abre só quando o anterior não trouxe candidato útil, e compartilham o
  // MESMO deadline absoluto — nada de duas tentativas no ar dentro do orçamento.
  // `variantQuery` vem do plano BR (II -> 2) e `fallbackQuery` é o título original.
  const shapedSeen = [found.searchQuery];
  const cascade = [];
  if (isBr && options.variantQuery) cascade.push({ q: options.variantQuery, label: 'variante numérica' });
  if (isBr && options.fallbackQuery) cascade.push({ q: options.fallbackQuery, label: 'título original' });
  for (const step of cascade) {
    const shaped = shapeSearchQuery(indexer, step.q, isBr);
    // Depois da moldagem duas grafias podem virar a mesma query (ex.: variante
    // que o bare-title reduz ao título); não vale abrir chamada duplicada.
    if (!shaped || shapedSeen.includes(shaped)) continue;
    const relevant = options.matchContext?.names?.length
      ? filterRelevantRaw(found.items, options.matchContext)
      : found.items;
    if (relevant.length === 0 && remaining(deadline) > MIN_RESOLVE_BUDGET) {
      log.info(`[jackett] ${indexer}: nenhum resultado relevante em PT; tentando ${step.label}`);
      shapedSeen.push(shaped);
      try {
        found = await fetchQuery(step.q);
      } catch (err) {
        // A primária já respondeu HTTP válido. Uma variante opcional instável
        // não pode reclassificar o indexer inteiro como offline nem apagar a
        // chance do próximo fallback dentro do orçamento restante.
        log.warn(`[jackett] ${indexer}: falha ao tentar ${step.label}:`, err?.message || err);
      }
    }
  }

  const items = await resolveCardigannDownloads(
    indexer,
    found.items,
    query,
    deadline,
    options.matchContext,
  );
  // fromCache diz se NENHUMA consulta Torznab saiu desta chamada: quem veio
  // do cache não mediu nada, e o status do indexer não pode ser inventado.
  return { indexer, items, ms: Date.now() - started, fromCache: liveFetches === 0 };
}

/**
 * Consulta cada indexer em paralelo em vez do agregado /all do Jackett.
 * O /all só responde quando o indexer MAIS LENTO termina, então um indexer
 * ruim derruba a busca inteira; aqui cada um tem seu próprio timeout e o que
 * chegou a tempo é aproveitado.
 */
async function search(query, type, indexersOverride = null, options = {}) {
  // `recordStatus: false` é a varredura tardia pt-BR: uma SEGUNDA consulta
  // aos mesmos indexers. A falha dela não pode contar falha do indexer no
  // circuito (o caminho principal respondeu bem), nem a lentidão dela pintar
  // o card de vermelho — o status continua sendo o da busca ao vivo.
  //
  // `ignoreBreaker: true` é a mesma varredura: como ela não disputa o
  // orçamento da resposta, vale consultar o indexer recém-derrubado — o
  // dublado raro mora justamente ali. O breaker é um atalho de busca AO VIVO.
  const { url, apiKey } = config.jackett;
  const { recordStatus = true, ignoreBreaker = false } = options;
  const indexers = indexersOverride == null ? config.jackett.indexers : indexersOverride;
  if (!apiKey) {
    log.warn('[jackett] JACKETT_API_KEY não configurada');
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
      log.warn('[jackett]', err.message);
      return [];
    }
  }

  // Indexers com circuito aberto nem abrem consulta: a falha é conhecida e o
  // orçamento deles volta para quem ainda entrega. A varredura pt-BR ignora
  // o atalho: roda fora do prazo da resposta, então um timeout extra não
  // custa nada ao usuário, e o indexer recém-derrubado é justamente onde o
  // dublado raro se esconde.
  const activeIndexers = ignoreBreaker
    ? indexers
    : indexers.filter((indexer) => {
      if (!breakerTripped(indexer)) {
        breakerAnnounced.delete(indexer);
        return true;
      }
      if (!breakerAnnounced.has(indexer)) {
        breakerAnnounced.add(indexer);
        const status = indexerStatus.get(indexer);
        log.warn(
          `[jackett] ${indexer}: circuit breaker aberto após ${status?.failStreak || config.jackett.breakerFailures} falha(s) seguidas; buscas pulam este indexer até ${Math.round(config.jackett.breakerCooldown / 60_000)}min após a última falha`,
        );
      }
      return false;
    });
  if (activeIndexers.length === 0) return [];

  const settled = await Promise.allSettled(
    activeIndexers.map((i) => queryIndexer(i, query, type, null, options)),
  );

  const out = [];
  const slow = [];
  for (let idx = 0; idx < settled.length; idx += 1) {
    const r = settled[idx];
    if (r.status === 'fulfilled') {
      out.push(...r.value.items);
      if (recordStatus && !r.value.fromCache) {
        indexerStatus.record(r.value.indexer, {
          // HTTP válido significa online. Zero resultado para um título não é
          // falha do servidor e não deve pintar o card de vermelho.
          ok: true,
          results: r.value.items.length,
          ms: r.value.ms,
          budgetMs: budgetFor(r.value.indexer),
        });
      }
      // Hit do cache bruto não registrou status nem entra na lista de lentos:
      // gravar ok:true com ms~0 deixaria um indexer caído verde no card pelo
      // TTL inteiro, e é justamente o card usado para diagnosticar os ✗.
      if (!r.value.fromCache && r.value.ms > 2000) slow.push(`${r.value.indexer} ${(r.value.ms / 1000).toFixed(1)}s`);
    } else {
      if (recordStatus) {
        indexerStatus.record(activeIndexers[idx], {
          ok: false,
          // A rejeição não carrega duração real; inventar o orçamento fazia o
          // card dizer "offline · 20s" como se fosse uma medição.
          ms: null,
          budgetMs: budgetFor(activeIndexers[idx]),
        });
      }
      slow.push(`${activeIndexers[idx]} ✗`);
    }
  }
  if (slow.length) log.warn('[jackett] lentos/falharam:', slow.join(', '));
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
      const attempt = await queryIndexer(indexer, term, kind, DIAGNOSTIC_TIMEOUT, { noRawCache: true });
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
    const result = {
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
    indexerStatus.record(indexer, result);
    return result;
  } catch (err) {
    const result = {
      indexer,
      ok: false,
      error: err.message || String(err),
      ms: Date.now() - started,
      budgetMs: budget,
    };
    indexerStatus.record(indexer, result);
    return result;
  }
}

module.exports = { search, test, shapeSearchQuery, breakerTripped, name: 'jackett' };
