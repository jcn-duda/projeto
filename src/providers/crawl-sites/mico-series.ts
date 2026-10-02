// Adaptador de SÉRIES do "Mico Leão Dublado" (Fase 2 do raspador). Extraído de
// `mico.ts` pela catraca de 400 linhas e pelo escopo próprio (como as séries do
// Vaca em `vaca-series.ts`). As primitivas compartilhadas (throttle, balde de
// releitura, parse de URL, página de catálogo) vêm de `mico-shared.ts` — este
// módulo NÃO importa `mico.ts` em runtime (sem ciclo).
//
// ## Como uma série do Mico é raspada
//
// - DESCOBERTA (`discoverSeries`): o catálogo `MicoSeries` tem o MESMO filtro de
//   gênero quebrado dos filmes (Fase 0), então pagina simples
//   (`/catalog/series/MicoSeries/skip=N.json`), `skip += metas.length`, dedupe
//   por IMDb, teto de segurança. A medição achou 1.773 séries em 45 páginas com
//   o teto de skip ATINGIDO (pode haver mais). URL sintética
//   `<host>/crawl/series/<tt>/`, `lastmod = bucketLastmod(tt, now, 30)` —
//   período MAIS LONGO que o de filmes (14), porque o acervo de série muda mais
//   devagar e cada obra custa várias chamadas de episódio.
// - LEITURA (`fetchSeriesWork`): stream de série é POR EPISÓDIO
//   (`/stream/series/<tt>:<S>:<E>.json`). A lista de episódios vem da Cinemeta
//   (`getMeta('series', tt)`): só as `MICO_CRAWL_SERIES_MAX_SEASONS` temporadas
//   mais recentes, da mais nova para trás, e só os episódios JÁ EXIBIDOS
//   (`episodeAired["S:E"]` presente e data ≤ agora). Sem data → não confirmado →
//   pula (segue o plano literalmente).
// - TETO POR PASSE: até `opts.series.maxButtons` episódios neste passe, com o
//   throttle PRÓPRIO (nunca o breaker ao vivo). O que sobra vira `partial` com
//   progresso retomável (`SeriesWorkProgress`, `doneCards = "S:E"` MONOTÔNICO) —
//   o motor re-enfileira e o passe seguinte retoma de onde parou.
// - LOCAÇÃO: cada episódio consultado vira um grupo `{season, episode, releases}`.
//   Um pack que o Mico serve para vários episódios cai em cada locação (o índice
//   faz merge por hash); o `releaseWorkTargets` do recorder resolve a cobertura.
import config from '../../config.js';
import * as log from '../../utils/logger.js';
import { getMeta } from '../../utils/cinemeta.js';
import { fetchMicoStreams, micoEpisodeStreamUrl } from '../mico.js';
import type { RawItem } from '../../../types/domain.js';
import type {
  CrawlPageOptions, CrawlReleaseGroup, CrawlWorkResult, SeriesWorkProgress,
} from '../crawl-types.js';
import { withRequestCost } from './shared.js';
import {
  SERIES_CATALOG_ID, SERIES_MAX_PAGES, NOMINAL_PAGE,
  bucketLastmod, fetchCatalogPage, honorRetryAfter, syntheticUrl, throttle,
} from './mico-shared.js';
import type { KindDiscovery } from './mico-shared.js';

/** Período do balde de releitura de SÉRIE (dias) — mais longo que o de filme. */
export const SERIES_REREAD_DAYS = 30;
/** Teto de episódios por passe quando a config viva não traz `maxButtons`. */
const DEFAULT_MAX_BUTTONS = 40;

/**
 * Descobre as URLs de SÉRIE (paginação simples do `MicoSeries`, dedupe por
 * IMDb, `lastmod` = balde de 30 dias). Best-effort por página (como a de
 * filme); `totalFailure` sobe para o `discover` decidir (série NÃO derruba a
 * descoberta de filme — ver `mico.ts`).
 */
export async function discoverSeries(now: number): Promise<KindDiscovery> {
  const urls: KindDiscovery['urls'] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  let skip = 0;
  let pages = 0;
  let firstPageFailed = false;
  let sawEmpty = false;

  for (let page = 0; page < SERIES_MAX_PAGES; page += 1) {
    pages += 1;
    let catalog;
    try {
      catalog = await fetchCatalogPage('series', SERIES_CATALOG_ID, skip);
    } catch (err) {
      failures.push(`series skip=${skip}: ${log.errorMessage(err)}`);
      if (page === 0) firstPageFailed = true;
      // 429 com Retry-After: adia a próxima página (o throttle a honra), em vez
      // de martelar a API só com o minGap.
      honorRetryAfter(err);
      skip += NOMINAL_PAGE;
      continue;
    }
    if (catalog.count === 0) { sawEmpty = true; break; }
    for (const tt of catalog.ids) {
      if (seen.has(tt)) continue;
      seen.add(tt);
      urls.push({
        url: syntheticUrl('series', tt),
        lastmod: bucketLastmod(tt, now, SERIES_REREAD_DAYS),
        kind: 'tv_show',
      });
    }
    skip += catalog.count;
  }

  // Saída pelo TETO sem página vazia = descoberta TRUNCADA (a Fase 0 achou 45
  // páginas com o teto de skip ATINGIDO — pode haver mais): NÃO é `complete`,
  // senão viraria cursor/cobertura de série indevida.
  const truncated = !sawEmpty;
  const totalFailure = firstPageFailed || urls.length === 0;
  const complete = failures.length === 0 && urls.length > 0 && !truncated;
  return { urls, failures, complete, requestCost: pages, totalFailure };
}

/** Meta de série da Cinemeta (o shape que `getMeta('series', tt)` devolve). */
interface SeriesMeta {
  episodes?: Record<string, number>;
  episodeAired?: Record<string, string>;
  name?: string;
  year?: string | number;
}

/** Chave de card de episódio (`doneCards` do progresso): `"S:E"`. */
function cardKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}

/**
 * Lista os episódios-ALVO da obra: só as `maxSeasons` temporadas mais recentes
 * (número de temporada MAIOR = mais recente), da mais nova para trás, e só os
 * episódios JÁ EXIBIDOS — `episodeAired["S:E"]` presente, legível e ≤ `now`.
 * Episódio SEM data (ou com data futura) NÃO é confirmado → fica de fora (o
 * plano é literal: sem `episodeAired`, pula). PURA (exportada para teste).
 */
export function listTargetEpisodes(
  meta: SeriesMeta | null | undefined,
  maxSeasons: number,
  now: number,
): Array<{ season: number; episode: number }> {
  const episodes = meta?.episodes && typeof meta.episodes === 'object' ? meta.episodes : {};
  const aired = meta?.episodeAired && typeof meta.episodeAired === 'object' ? meta.episodeAired : {};
  // Temporadas válidas (o Cinemeta já exclui especiais/S0), da mais recente para trás.
  const seasons = Object.keys(episodes)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a);
  const kept = seasons.slice(0, Math.max(1, Math.trunc(maxSeasons) || 1));
  const out: Array<{ season: number; episode: number }> = [];
  for (const season of kept) {
    const count = Number(episodes[String(season)]) || 0;
    for (let episode = 1; episode <= count; episode += 1) {
      const date = aired[cardKey(season, episode)];
      if (!date) continue; // sem data → não confirmado → pula
      const t = Date.parse(String(date));
      if (!Number.isFinite(t) || t > now) continue; // futura ou ilegível → pula
      out.push({ season, episode });
    }
  }
  return out;
}

/**
 * Processa UMA página de série (`/crawl/series/<tt>/`). Devolve `groups` por
 * locação (S/E) e progresso retomável (`doneCards = "S:E"` MONOTÔNICO). Um
 * passe consulta até `maxButtons` episódios; o que sobra vira `partial` (o
 * motor re-enfileira e o próximo passe retoma do `resume`). 429/5xx/rede num
 * episódio LANÇA com o custo medido (backoff do motor).
 */
export async function fetchSeriesWork(
  url: string,
  tt: string,
  opts?: CrawlPageOptions,
): Promise<CrawlWorkResult> {
  const now = Date.now();
  const maxSeasons = Math.max(1, config.mico.crawlSeriesMaxSeasons ?? 2);
  const maxButtons = Math.max(1, opts?.series?.maxButtons ?? DEFAULT_MAX_BUTTONS);

  // Lista de episódios pela Cinemeta (o IMDb já é conhecido — não há TMDB).
  const meta = (await getMeta('series', tt)) as SeriesMeta | null;
  if (!meta) {
    // Sem meta não dá para AFIRMAR que a série não tem episódios (pode ser
    // falha transitória da Cinemeta). Erro RETENTÁVEL (o motor faz backoff),
    // nunca `no-torrent` — que dormiria a obra por 30 dias (o balde de série).
    throw withRequestCost(new Error(`mico: série sem meta da Cinemeta (${tt})`), 0);
  }

  const targets = listTargetEpisodes(meta, maxSeasons, now);
  if (targets.length === 0) {
    // Série sem episódio-alvo (nenhum exibido OU nenhuma temporada dentro do
    // teto): sem torrent a colher. `requestCost: 0` — nenhuma chamada ao Mico.
    return { url, status: 'no-torrent', imdb: tt, type: 'series', requestCost: 0 };
  }

  // Progresso MONOTÔNICO: `doneCards` começa no resume e só cresce. Estagnar
  // (não crescer) viraria `series_stall` no `processPartialSlice`.
  const resumeDone = Array.isArray(opts?.resume?.doneCards) ? opts!.resume!.doneCards : [];
  const doneCards = new Set<string>(resumeDone);
  const remaining = targets.filter((ep) => !doneCards.has(cardKey(ep.season, ep.episode)));
  const totalCards = targets.length;

  const groups: CrawlReleaseGroup[] = [];
  let requestCost = 0;

  for (const ep of remaining) {
    if (requestCost >= maxButtons) break; // teto de episódios deste passe
    const streamUrl = micoEpisodeStreamUrl(tt, ep.season, ep.episode);
    if (!streamUrl) continue; // defesa: IMDb/temporada/episódio inválidos
    await throttle();
    let items: RawItem[];
    try {
      ({ items } = await fetchMicoStreams(streamUrl, config.mico.timeout));
    } catch (err) {
      // 429/5xx/rede num episódio: honra o Retry-After e sobe com o custo já
      // gasto (o motor faz o backoff). NUNCA exceção crua sem custo.
      honorRetryAfter(err);
      throw withRequestCost(err, Math.max(1, requestCost));
    }
    requestCost += 1;
    doneCards.add(cardKey(ep.season, ep.episode));
    // 4xx vem com `items: []` (não prova host caído) — episódio sem stream é
    // só isso: concluído, sem grupo. O próximo balde de 30 dias relê.
    if (items.length) {
      groups.push({ season: ep.season, episode: ep.episode, releases: items });
    }
  }

  const progress: SeriesWorkProgress = { v: 1, doneCards: [...doneCards], totalCards };
  const pending = targets.filter((ep) => !doneCards.has(cardKey(ep.season, ep.episode))).length;

  // Ainda faltam episódios além do teto deste passe → `partial` com progresso
  // (o motor re-enfileira; o próximo passe retoma dos `doneCards`).
  if (pending > 0) {
    return {
      url,
      status: 'partial',
      imdb: tt,
      type: 'series',
      error: `series_truncated: teto de episódios por passe (${doneCards.size}/${totalCards} feitos, ${pending} pendentes)`,
      ...(groups.length ? { groups } : {}),
      progress,
      requestCost,
    };
  }

  // Todos os episódios-alvo processados. Com releases → `done` + grupos.
  if (groups.length) {
    return { url, status: 'done', imdb: tt, type: 'series', groups, progress, requestCost };
  }
  // Sem release nesta passagem FINAL. Se houve progresso anterior, a série já
  // foi colhida nos passes passados → `done` sem grupos (o `crawl-page` faz a
  // "conclusão por retomada" e preserva a contagem). `no-torrent` aqui apagaria
  // o que já foi gravado. Sem resume (1º passe com tudo vazio) → `no-torrent`.
  if (resumeDone.length > 0) {
    return { url, status: 'done', imdb: tt, type: 'series', progress, requestCost };
  }
  return { url, status: 'no-torrent', imdb: tt, type: 'series', requestCost };
}
