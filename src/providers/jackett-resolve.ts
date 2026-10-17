import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { isSafeDownloadUrl } from '../utils/net-safety.js';
import { requireCore } from '../utils/rust-core.js';
import { mapLimit } from '../utils/concurrency.js';
import * as log from '../utils/logger.js';

// Abaixo disso não vale abrir mais um salto de protetor de link: a requisição
// abortaria no meio e ainda gastaria o resto do orçamento.
export const MIN_RESOLVE_BUDGET = 400;

// TTL do cache de magnet resolvido (7 dias em segundos). Protetor de link não
// altera o hash de uma release já publicada.
const RESOLVED_MAGNET_TTL = 7 * 24 * 3600;

/**
 * Lote do pré-resolve no núcleo (`rust/crates/adom-napi/src/pre_resolve.rs`):
 * relevância, temporada/episódio, dedupe, score de escolha, corte pelo teto e
 * guarda de URL do link decidem INTEIROS numa chamada — saem só os índices
 * aprovados (na ordem final) e o motivo de cada rejeição. O motivo fica
 * numérico na fronteira; o rótulo fica aqui.
 */
const PRE_RESOLVE_REJECT_LABELS = [
  'title',
  'season',
  'episode',
  'duplicate',
  'unsafe-url',
] as const;

type PreResolvePostNapi = {
  title?: string;
  titlePascal?: string;
  magnet?: string;
  magnetUri?: string;
  guid?: string;
  isBr: boolean;
  infoHash?: string;
  downloadUrl?: string;
  linkTrusted: boolean;
};

type PreResolveOutcomeNapi = {
  approved: number[];
  rejected: Array<{ index: number; reason: number }>;
};

type PreResolveCore = {
  preResolveBrNapi(
    posts: PreResolvePostNapi[],
    query: Record<string, unknown>,
    settings: Record<string, unknown>,
  ): PreResolveOutcomeNapi;
  resolveCandidateScoreNapi(title: string, season?: number, episode?: number): number;
};

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

/**
 * Pontuação de candidatos a download antes de despachar a resolução no `/dl`.
 *
 * Na cena BR, posts de WordPress frequentemente agregam 4 a 6 botões de download
 * por post (ex: Opção 1 [720p Dublado], Opção 2 [1080p Dual Áudio], 4K UHD Bluray,
 * Versão CAM/TS etc.) — dublado e qualidades superiores não podem ficar de fora
 * da cota de resoluções. A regra INTEIRA decide no núcleo
 * (`adom-napi::pre_resolve::resolve_candidate_score`); aqui é só a ponte.
 *
 * @param {{ title?: string }} item
 * @param {{ season?: (number|null), episode?: (number|null) }} [options]
 */
export function resolveCandidateScore(item: { title?: string }, { season = null, episode = null }: { season?: number | null; episode?: number | null } = {}) {
  const core = requireCore() as unknown as PreResolveCore;
  return core.resolveCandidateScoreNapi(
    String(item.title || ''),
    season == null ? undefined : Number(season),
    episode == null ? undefined : Number(episode),
  );
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
  // Filtro BR estrito antes de pagar o protetor de link: post "parecido"
  // ("Missão: Impossível – Efeito Fallout" numa busca por "Fallout") não
  // merece orçamento de resolução de magnet. Toda a decisão por post —
  // relevância, temporada/episódio, dedupe, score, teto e guarda de URL —
  // acontece no núcleo, em UM lote; o fetch do protetor segue aqui.
  const core = requireCore() as unknown as PreResolveCore;
  const outcome = core.preResolveBrNapi(
    items.map((item: any): PreResolvePostNapi => ({
      // Forma fixa com `undefined` = ausente (o `||` do JS): sem spreads
      // condicionais, a montagem do lote é O(1) por campo e não vira o gargalo.
      title: item.title ? String(item.title) : undefined,
      titlePascal: item.Title ? String(item.Title) : undefined,
      magnet: item.magnet ? String(item.magnet) : undefined,
      magnetUri: item.MagnetUri ? String(item.MagnetUri) : undefined,
      guid: item.Guid ? String(item.Guid) : undefined,
      isBr: Boolean(item.isBr),
      infoHash: item.infoHash ? String(item.infoHash) : undefined,
      downloadUrl: item.downloadUrl ? String(item.downloadUrl) : undefined,
      // A exceção do download do próprio Jackett depende de config.jackett.url
      // (I/O de config, não de texto do post) — decidida aqui, entra no lote.
      linkTrusted: Boolean(item.downloadUrl && isJackettDownloadLink(String(item.downloadUrl))),
    })),
    {
      names: matchContext?.names?.length ? matchContext.names.map(String) : [],
      ...(wanted ? { wanted } : {}),
      // O ano da relevância é o de catálogo (sujo, como veio do metadata);
      // o da query ("Coringa 2019") só alimenta o caminho `matchesBrTitle`.
      ...(matchContext?.year != null && matchContext.year !== '' ? { year: String(matchContext.year) } : {}),
      ...(matchContext?.altYear != null ? { altYear: String(matchContext.altYear) } : {}),
      isSeries: Boolean(matchContext?.isSeries),
      ...(matchContext?.season != null ? { season: Number(matchContext.season) } : {}),
      ...(matchContext?.episode != null ? { episode: Number(matchContext.episode) } : {}),
      ...(matchContext?.multiWork?.root ? { multiWorkRoot: String(matchContext.multiWork.root) } : {}),
      ...(matchContext?.homeReleaseAt != null ? { homeReleaseAt: Number(matchContext.homeReleaseAt) } : {}),
      brIsSeries: Boolean(requestedSeason),
      ...(queryYear ? { queryYear: String(queryYear) } : {}),
      ...(requestedSeason ? { requestedSeason: Number(requestedSeason[1]) } : {}),
      ...(requestedEp
        ? { requestedEpSeason: Number(requestedEp[1]), requestedEp: Number(requestedEp[2]) }
        : {}),
      maxResolves: config.jackett.maxDownloadResolves,
      allowPrivateUrls: config.jackett.allowPrivateDownloadIps === true,
    },
    {
      nowMs: Date.now(),
      preHomeReleaseCut: config.search.preHomeReleaseCut,
      preHomeReleaseMarginMs: config.search.preHomeReleaseMarginMs,
      titlePrecisionTailCut: config.search.titlePrecisionTailCut,
    },
  );
  // Links bloqueados pelo lote: o item FICA na lista (sem magnet, exatamente
  // como no `resolveDownloadMagnet` antigo), só não abre o fetch — e o aviso é
  // o mesmo de antes, agora decidido antes da fila de resolução.
  const bloqueados = new Set(
    outcome.rejected
      .filter(({ reason }) => PRE_RESOLVE_REJECT_LABELS[reason] === 'unsafe-url')
      .map(({ index }) => index),
  );
  const candidates = outcome.approved.map((i) => ({ item: items[i], bloqueado: bloqueados.has(i) }));
  const resolved = await mapLimit(candidates, config.jackett.resolveConcurrency, async ({ item, bloqueado }) => {
    // Índice grava mediaSource (CAM do dn/bank); protetor em hash pronto não vale.
    if (item.infoHash || /^magnet:\?/i.test(item.magnet || '')) return item;
    // Cada salto cabe no que sobrou do orçamento: um protetor de link lento não
    // pode empurrar o indexer inteiro além do REPLY_DEADLINE.
    const budget = remaining(deadline);
    if (budget <= MIN_RESOLVE_BUDGET) return item;
    if (bloqueado) {
      log.warn(`[jackett] URL de download bloqueada por segurança: ${String(item.downloadUrl).slice(0, 160)}`);
      return item;
    }
    const magnet = await resolveDownloadMagnet(item.downloadUrl, budget);
    return magnet ? { ...item, magnet } : item;
  });
  const count = resolved.filter((r) => /^magnet:\?/i.test(r.magnet || '')).length;
  log.info(`[jackett] ${indexer}: ${count}/${candidates.length} magnet(s) resolvido(s)`);
  return resolved;
}
