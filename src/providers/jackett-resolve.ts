import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { isSafeDownloadUrl } from '../utils/net-safety.js';
import {
  matchesBrTitle,
  matchesEpisode,
  filterRelevantRaw,
  parseTitleSeasonEpisode,
  audioFromTitle,
  qualityFromTitle,
  UNKNOWN_QUALITY,
} from '../utils/format.js';
import { mapLimit } from '../utils/concurrency.js';
import * as log from '../utils/logger.js';

// Abaixo disso não vale abrir mais um salto de protetor de link: a requisição
// abortaria no meio e ainda gastaria o resto do orçamento.
export const MIN_RESOLVE_BUDGET = 400;

// TTL do cache de magnet resolvido (7 dias em segundos). Protetor de link não
// altera o hash de uma release já publicada.
const RESOLVED_MAGNET_TTL = 7 * 24 * 3600;

/**
 * Exceção ao guard de download (criada no 0c22158 para desbloquear o magnet
 * BR): o `<link>` Torznab é input de TERCEIRO, e o Cardigann aponta o download
 * para o PRÓPRIO Jackett (`/dl/<indexer>/...`) — no container único ele mora
 * em loopback, e o guard genérico bloqueava todos os magnets BR.
 *
 * A exceção NÃO é por origem sozinha: "mesmo origin" deixaria um tracker
 * hostil apontar qualquer path do admin local (ex.: `/api/v2.0/server/config`,
 * que leria a apikey). Ela vale apenas para o shape de download do próprio
 * serviço: origem do Jackett + pathname `/dl/<indexer>/` RELATIVO à base (a
 * base pode ter prefixo de path no futuro — por isso startsWith em string,
 * sem escapar regex do prefixo). O teste do caminho feliz em
 * test/jackett-provider.test.ts impede a regressão do magnet BR.
 */
function isJackettDownloadLink(url: string): boolean {
  try {
    const target = new URL(url);
    const base = new URL(config.jackett.url);
    if (target.origin !== base.origin) return false;
    const basePrefix = base.pathname.replace(/\/+$/, '');
    if (!target.pathname.startsWith(basePrefix)) return false;
    return /^\/dl\/[A-Za-z0-9._-]+\//.test(target.pathname.slice(basePrefix.length));
  } catch {
    return false;
  }
}

async function resolveDownloadMagnet(url: string, budgetMs: number) {
  if (!url) return null;
  if (!isJackettDownloadLink(url) && !isSafeDownloadUrl(url, config.jackett.allowPrivateDownloadIps)) {
    log.warn(`[jackett] URL de download bloqueada por segurança: ${String(url).slice(0, 160)}`);
    return null;
  }
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
export function remaining(deadline: number | null | undefined): number {
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

export async function resolveCardigannDownloads(indexer: string, items: any[], query: string, deadline: number | null, matchContext: MatchContext | null = null) {
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
