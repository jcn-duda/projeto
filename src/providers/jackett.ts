import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import {
  matchesBrTitle,
  matchesEpisode,
  filterRelevantRaw,
  parseTitleSeasonEpisode,
  audioFromTitle,
  qualityFromTitle,
  looksPtBr,
  UNKNOWN_QUALITY,
} from '../utils/format.js';
import * as indexerStatus from './indexer-status.js';
import { mapLimit } from '../utils/concurrency.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { prefix } from '../utils/cache-keys.js';

// Abaixo disso não vale abrir mais um salto de protetor de link: a requisição
// abortaria no meio e ainda gastaria o resto do orçamento.
const MIN_RESOLVE_BUDGET = 400;

interface JackettSearchOptions {
  /** Diagnóstico: mede a consulta de verdade, sem ler/gravar o cache bruto. */
  noRawCache?: boolean;
  /** Grafia arábica do numeral (plano BR: II -> 2). */
  variantQuery?: string;
  /** Título original como fallback (plano BR+ptQuery). */
  fallbackQuery?: string;
  matchContext?: MatchContext | null;
  /** Varredura tardia: falha não conta no circuito nem pinta o card. */
  recordStatus?: boolean;
  /** Varredura tardia: consulta mesmo indexer com circuito aberto. */
  ignoreBreaker?: boolean;
  /** Warmup popula raw sem pagar resolução de protetor de link. */
  skipResolve?: boolean;
}

// TTL do cache de magnet resolvido (7 dias em segundos). Protetor de link não
// altera o hash de uma release já publicada.
const RESOLVED_MAGNET_TTL = 7 * 24 * 3600;

// Prazo do teste manual de indexador. Nada a ver com o da busca: aqui vale
// esperar pra distinguir "indexer morto" de "indexer lento".
const DIAGNOSTIC_TIMEOUT = 30000;

/**
 * Indexers que devolvem ZERO quando a consulta leva `Category[]`.
 *
 * O TPB some com query de mais de uma palavra sem ano assim que a categoria
 * entra na URL — "Star Trek Beyond" com `Category[]=2000` dá 0, sem categoria
 * dá 100, e a mesma query com o ano ("Beyond Re-Animator 2003") dá 19 dos dois
 * jeitos. Quem paga é a varredura pt-BR e o bare title, que saem sem ano de
 * propósito: o maior tracker global voltava vazio em silêncio. Aqui a consulta
 * sai sem categoria e o filtro roda no `mapResults`, sobre o campo `Category`
 * que o Jackett já devolve. Nenhum outro indexer da lista tem esse
 * comportamento (therarbg, yts, kickass e torrentgalaxyclone respondem igual
 * com e sem categoria) — a isenção é nominal de propósito.
 */
const CATEGORY_UNFILTERED_INDEXERS = new Set(['thepiratebay']);

/**
 * Balde Torznab do tipo: 2000–2999 = filme, 5000–5999 = TV. O `Category` do
 * Jackett traz o id fino (2040 = Movies/HD) junto de ids de tracker fora da
 * faixa Torznab (100207), então o teste é por faixa. Resultado sem categoria
 * nenhuma passa: perder release por metadado ausente é pior que deixar entrar
 * um fora de tipo, que o matchContext ainda descarta depois.
 */
function inCategoryBucket(categories: any, bucket: number) {
  if (!Array.isArray(categories) || categories.length === 0) return true;
  return categories.some((id: any) => Number(id) >= bucket && Number(id) < bucket + 1000);
}

function mapResults(
  data: any,
  { isBr = false, indexer = '', categoryBucket = 0 }:
    { isBr?: boolean; indexer?: string; categoryBucket?: number } = {},
) {
  const all = Array.isArray(data?.Results) ? data.Results : Array.isArray(data) ? data : [];
  const results = categoryBucket
    ? all.filter((r: any) => inCategoryBucket(r?.Category, categoryBucket))
    : all;
  return results.map((r: any) => ({
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

async function resolveDownloadMagnet(url: string, budgetMs: number) {
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
function remaining(deadline: number | null | undefined): number {
  if (deadline == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, deadline - Date.now());
}

function dedupeResolveCandidates(items: any[]) {
  const seen = new Set();
  return items.filter((item: any) => {
    const identity = item.infoHash || item.magnet || item.downloadUrl;
    if (!identity) return true;
    const key = String(identity).trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {{ title?: string }} item
 * @param {{ season?: (number|null), episode?: (number|null) }} [options]
 */
function resolveCandidateScore(item: { title?: string }, { season = null, episode = null }: { season?: number | null; episode?: number | null } = {}) {
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

async function resolveCardigannDownloads(indexer: string, items: any[], query: string, deadline: number | null, matchContext: MatchContext | null = null) {
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
    .filter((item: any) => {
      if (matchContext?.names?.length) {
        return filterRelevantRaw([item], matchContext).length > 0;
      }
      return !wanted || matchesBrTitle(item.title || '', wanted, queryYear || null, { isSeries: Boolean(requestedSeason) });
    })
    .filter((item: any) => {
      if (!requestedSeason) return true;
      const titleSeason = String(item.title || '').match(/(?:\bS(\d{1,2})\b|(\d{1,2})\s*[ªº]\s*Temporada)/i);
      return !titleSeason || Number(titleSeason[1] || titleSeason[2]) === Number(requestedSeason[1]);
    })
    // Release de outro episódio morre em buildStreams de qualquer jeito —
    // resolvê-la gastava os slots (maxDownloadResolves) e 2-4s de protetor com
    // E02..E10 enquanto o E01 pedido ficava de fora. Pack continua passando.
    .filter((item: any) => matchContext?.season != null || !requestedEp || matchesEpisode(item.title || '', {
      season: Number(requestedEp[1]),
      episode: Number(requestedEp[2]),
    }));
  candidates = dedupeResolveCandidates(candidates)
    .map((item: any, order: number) => ({ item, order, score: resolveCandidateScore(item, matchContext || {}) }))
    .sort((a: any, b: any) => b.score - a.score || a.order - b.order)
    .slice(0, config.jackett.maxDownloadResolves)
    .map(({ item }: any) => item);
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
function shapeSearchQuery(indexer: string, query: string, isBr?: boolean) {
  let shaped = String(query || '');
  if (isBr) shaped = shaped.replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, ' ');
  if (config.jackett.bareTitleIndexers.includes(indexer)) {
    shaped = shaped.replace(/\s+(?:19|20)\d{2}\s*$/, ' ');
  }
  shaped = shaped.replace(/\s+/g, ' ').trim();
  return shaped || query;
}

/** Orçamento que a busca AO VIVO daria a este indexer. */
function budgetFor(indexer: string) {
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
function breakerTripped(indexer: string, now = Date.now()) {
  if (!config.jackett.breakerEnabled) return false;
  const status = indexerStatus.get(indexer, now);
  if (!status || (status.failStreak || 0) < config.jackett.breakerFailures) return false;
  const failedAt = Date.parse(status.checkedAt);
  return Number.isFinite(failedAt) && now - failedAt < config.jackett.breakerCooldown;
}

/** Estado serializável do breaker para o painel, sem disparar nova medição. */
function breakerSnapshot(indexer: string, now = Date.now()) {
  const status = indexerStatus.get(indexer, now);
  const failedAt = Date.parse(String(status?.checkedAt || ''));
  const eligible = Boolean(
    config.jackett.breakerEnabled &&
      status &&
      (status.failStreak || 0) >= config.jackett.breakerFailures &&
      Number.isFinite(failedAt),
  );
  const cooldownRemainingMs = eligible
    ? Math.max(0, config.jackett.breakerCooldown - (now - failedAt))
    : 0;
  return {
    enabled: config.jackett.breakerEnabled,
    tripped: breakerTripped(indexer, now),
    failStreak: status?.failStreak || 0,
    failuresRequired: config.jackett.breakerFailures,
    cooldownMs: config.jackett.breakerCooldown,
    cooldownRemainingMs,
  };
}

// Quem já teve a abertura anunciada neste episódio — o aviso é UM por
// abertura, não por busca; sai do set quando o indexer volta a ser consultado.
const breakerAnnounced = new Set();

async function queryIndexer(indexer: string, query: string, type: string, timeoutOverride: number | null = null, options: JackettSearchOptions = {}) {
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
  const fetchQuery = async (candidateQuery: string) => {
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
    const categoryBucket = type === 'movie' ? 2000 : type === 'series' ? 5000 : 0;
    // Quem não aguenta categoria na URL filtra depois, sobre a resposta.
    const filterLocally = CATEGORY_UNFILTERED_INDEXERS.has(indexer);
    if (categoryBucket && !filterLocally) {
      endpoint.searchParams.append('Category[]', String(categoryBucket));
    }
    const budget = remaining(deadline);
    if (budget <= 0) throw new Error('timeout');
    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
      signal: AbortSignal.timeout(Math.max(1, budget)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = mapResults(await res.json(), {
      isBr,
      indexer,
      categoryBucket: filterLocally ? categoryBucket : 0,
    });
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
  const cascade: { q: string; label: string }[] = [];
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

  const items = options.skipResolve
    ? found.items
    : await resolveCardigannDownloads(indexer, found.items, query, deadline, options.matchContext);
  // fromCache diz se NENHUMA consulta Torznab saiu desta chamada: quem veio
  // do cache não mediu nada, e o status do indexer não pode ser inventado.
  return { indexer, items, ms: Date.now() - started, fromCache: liveFetches === 0 };
}

/**
 * Consulta cada indexer em paralelo em vez do agregado /all do Jackett.
 * O /all só responde quando o indexer MAIS LENTO termina, então um indexer
 * ruim derruba a busca inteira; aqui cada um tem seu próprio timeout e o que
 * chegou a tempo é aproveitado.
 *
 * @param {string} query
 * @param {string} type
 * @param {?string[]} [indexersOverride]
 * @param {object} [options]
 */
async function search(query: string, type: string, indexersOverride: string[] | null = null, options: JackettSearchOptions = {}) {
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

  const out: any[] = [];
  const slow: string[] = [];
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
      // Fase 0 do índice: tempo gasto em indexer que não contribuiu com NENHUM
      // item que sobreviveu ao filtro. Só medição real entra (fromCache é
      // ~0ms e não mediu nada; rejeição não carrega ms confiável).
      // Semântica: nos indexers de resolução Cardigann o pré-filtro interno já
      // cortou o que não casa, então a régua aqui é mais branda para eles — a
      // métrica é diagnóstico de autorização de fase, não comparação exata
      // entre indexers.
      if (options.matchContext?.names?.length && !r.value.fromCache && r.value.ms > 0) {
        const survived = filterRelevantRaw(r.value.items, options.matchContext);
        if (survived.length === 0) {
          metrics.count('search.jackett.wastedQueries');
          metrics.count('search.jackett.wastedMs', r.value.ms);
        }
      }
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
async function test(indexer: string, query: string, type = 'movie') {
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
    let items: any[] = [];
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

/**
 * Chaves do cache bruto que uma busca por estes indexers consultaria — a
 * simulação da Fase 0 do índice usa isto para medir, ANTES de qualquer rede,
 * se a matéria-prima da obra já está quente. Reproduz a construção de chave do
 * queryIndexer (mesma moldagem de query); divergir daqui é medir outra coisa.
 */
function rawKeysFor(indexers: string[], query: string, type: string) {
  return (indexers || []).map((indexer) => {
    const isBr = config.jackett.ptBrIndexers.includes(indexer);
    const searchQuery = shapeSearchQuery(indexer, query, isBr);
    return `${prefix('raw')}jackett:${indexer}:${type}:${searchQuery}`;
  });
}

export default { search, test, shapeSearchQuery, breakerTripped, breakerSnapshot, rawKeysFor, name: 'jackett' };
