// HDR Torrents (hdrtorrents.net) — perfil do resolver local. Oitavo BR.
//
// O site tem a busca quebrada: qualquer endpoint (?s=, /pesquisa/, /index.php?busca=)
// devolve a homepage sem filtrar. Os magnets são DIRETOS no HTML do post
// (sem protetor de link), então NÃO há rota /resolve: o magnet é o próprio
// href da linha sintética, como no apachetorrent/redetorrent.
//
// Fluxo da busca: o resolver raspa as páginas de listagem (homepage +
// paginação /pagina/N/) para montar um catálogo em cache, casa a query contra
// esse catálogo, busca as páginas de conteúdo dos itens que casaram e extrai
// os magnets diretos. A listagem fica em cache por 30 min; a primeira busca
// fria custa o scraping (~5-15s), as seguintes são instantes.

import { USER_AGENT } from '../runtime.js';
import { createCache } from '../cache.js';
import { createServer as createHttpServer, reply } from '../http-server.js';
import {
  createResolverRouter, createHealthRoute, createSearchRoute, createApiRoute,
} from '../resolver-http.js';
import { matchesResolverQuery, matchesSeasonSeason } from '../matching.js';
import { createProfile } from '../site-profile.js';
import { buildProfileConfig } from '../env-config.js';
import type { ProfileOverrides } from '../env-config.js';
import {
  FALLBACK_SITE_SUFFIXES, normalizeQuery, requestedSeasonFromQuery,
  classifyAudio, parseListingHtml, parseContentMagnets,
  createHDRSearchPageHtml, hdrRssXml,
  stripTags, decodeEntities, escapeXml,
} from './hdrtorrents-parsers.js';
import type { HDRWork, HDRLink, HDRPageItem } from './hdrtorrents-parsers.js';

const DEFAULTS = {
  port: 8707,
  selfUrl: 'http://hdrtorrents-resolver:8707',
  siteUrl: 'https://hdrtorrents.net',
  timeoutMs: 15_000,
  // Teto de posts com match por busca: cada post vira um fetch de conteúdo
  // (mapLimit 3), e a fonte é index-only — o custo fica no colhedor, fora do
  // prazo da resposta.
  maxPosts: 5,
  // Teto de páginas de listagem raspadas por ciclo de cache. 20 páginas × 20
  // cards = 400 itens, suficiente para cobrir o catálogo corrente.
  maxListingPages: 20,
  // Orçamento de tempo para raspagem da listagem. A busca BR tem 20s de teto;
  // 10s deixa folga para os saltos seguintes (conteúdo dos posts). Quando
  // estoura, devolve o que já coletou (parcial) e cacheia por menos tempo.
  listingBudgetMs: 10_000,
  // Orçamento do aquecimento e do refresh de FUNDO, onde ninguém espera a
  // resposta. Medido em produção: com 10s o catálogo saía SEMPRE parcial e
  // variava a cada raspagem (190, 285, 304 itens) — a mesma busca achava
  // "Superman" numa rodada e nada na seguinte, porque o recorte mudava. O
  // teto continua sendo `maxListingPages`; este prazo só deixa chegar lá.
  listingWarmBudgetMs: 120_000,
  // TTL curto quando a listagem é parcial (incompleta): 2 min em vez de 30.
  // Assim a próxima busca tenta completar logo, sem ficar 30 min com catálogo
  // velho quando a fonte respondeu só a primeira página.
  listingPartialCacheMs: 2 * 60_000,
  postCacheMs: 10 * 60_000,
  searchCacheMs: 5 * 60_000,
  listingCacheMs: 30 * 60_000,
};
const META = {
  name: 'hdrtorrents', siteEnv: 'HDRTORRENTS_URL', defaults: DEFAULTS,
};

type HDRItem = { post: HDRWork; link: HDRLink; index: number; count: number };

/** Instância completa do perfil HDR Torrents; `overrides` vêm do ponto de entrada. */
function createResolver(overrides: ProfileOverrides = {}) {
  const config = buildProfileConfig(META, overrides);
  const {
    port: PORT = DEFAULTS.port, selfUrl: SELF_URL = DEFAULTS.selfUrl,
    siteUrl: SITE_URL = DEFAULTS.siteUrl,
    timeoutMs: TIMEOUT_MS = DEFAULTS.timeoutMs,
    maxPosts: MAX_POSTS = DEFAULTS.maxPosts,
    postCacheMs: POST_CACHE_MS = DEFAULTS.postCacheMs,
    searchCacheMs: SEARCH_CACHE_MS = DEFAULTS.searchCacheMs,
    extraProtectors: EXTRA_PROTECTORS = [],
  } = config;
  // Knobs próprios do perfil (não fazem parte do ResolverConfig padrão):
  // usam o default estático, sem env override. Os dois prazos de raspagem
  // aceitam `overrides` porque é o que o teste injeta para medir os regimes
  // sem esperar 120s de relógio real.
  const MAX_LISTING_PAGES = DEFAULTS.maxListingPages;
  const LISTING_CACHE_MS = DEFAULTS.listingCacheMs;
  const knob = (nome: 'listingBudgetMs' | 'listingWarmBudgetMs') => {
    const valor = Number((overrides as Record<string, unknown>)[nome]);
    return Number.isFinite(valor) && valor > 0 ? valor : DEFAULTS[nome];
  };

  const bootstrap = createProfile({
    name: 'hdrtorrents',
    port: PORT,
    selfUrl: SELF_URL,
    siteUrl: SITE_URL,
    fallbackSuffixes: FALLBACK_SITE_SUFFIXES,
    extraProtectorSuffixes: [...EXTRA_PROTECTORS],
    concurrency: 3,
    decodeEntities,
  });

  const { siteSelector, mapLimit, assertAllowedUrl, isDetailHost, isNetworkError } = bootstrap;
  const SELF_URL_RESOLVED = bootstrap.selfUrl;

  // Cache (núcleo resolvers/cache.js): listagem, busca e post.
  const inFlight = new Map<string, Promise<unknown>>();
  const { values: listingCache } = createCache(10, { inFlight });
  const { values: postCache, cached: cachedPost } = createCache(200, { inFlight });
  const { values: searchCache } = createCache(100, { inFlight });

  siteSelector.onDomainChange(() => {
    listingCache.clear();
    postCache.clear();
    searchCache.clear();
  });

  // ---------------------------------------------------------------------------
  // Listagem: raspa homepage + paginação, cache por 30 min.
  // Orçamento de tempo (listingBudgetMs): ao estourar, devolve o que coletou
  // e marca como parcial (TTL curto). SWR: quando o TTL vence, serve o último
  // catálogo bom na hora e atualiza em segundo plano — nunca expira "duro".
  // ---------------------------------------------------------------------------
  let lastGoodListings: HDRWork[] | null = null;
  let lastGoodIsPartial = false;

  async function fetchText(url: string): Promise<string> {
    const res = await fetch(assertAllowedUrl(url), {
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return res.text();
  }

  async function fetchListingPage(pageNum: number): Promise<HDRWork[]> {
    const url = pageNum <= 1
      ? `${siteSelector.url()}/`
      : `${siteSelector.url()}/pagina/${pageNum}/`;
    const html = await fetchText(url);
    return parseListingHtml(html, siteSelector.url());
  }

  const LISTING_BUDGET_MS = knob('listingBudgetMs');
  const LISTING_WARM_BUDGET_MS = knob('listingWarmBudgetMs');
  const LISTING_PARTIAL_CACHE_MS = DEFAULTS.listingPartialCacheMs;

  /**
   * Raspa a listagem com teto de tempo; devolve { items, partial }.
   * `budgetMs` separa os dois regimes: a raspagem que uma BUSCA espera usa o
   * prazo curto; aquecimento e refresh de fundo usam o longo, porque ninguém
   * está esperando e catálogo pela metade é pior que demora invisível.
   */
  async function scrapeListings(budgetMs: number = LISTING_BUDGET_MS): Promise<{ items: HDRWork[]; partial: boolean }> {
    const deadline = Date.now() + budgetMs;
    const all: HDRWork[] = [];
    const seen = new Set<string>();
    let partial = false;
    for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      const items = await fetchListingPage(page);
      for (const item of items) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          all.push(item);
        }
      }
      // Página com menos de 10 cards (metade do normal) é fim do catálogo.
      if (items.length < 10) break;
    }
    return { items: all, partial };
  }

  async function fetchAllListings(): Promise<HDRWork[]> {
    const result = await fetchAllListingsDetailed();
    return result.items;
  }

  /**
   * Listagem com metadado de parcialidade. SWR + inFlight: quando o TTL
   * venceu, devolve o último catálogo bom na hora e dispara refresh em
   * background; requisições concorrentes reaproveitam a MESMA promessa
   * (inFlight['all']), evitando N raspagens simultâneas do site.
   */
  async function fetchAllListingsDetailed(
    { background = false }: { background?: boolean } = {},
  ): Promise<{ items: HDRWork[]; partial: boolean }> {
    const cached = listingCache.get('all');
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as { items: HDRWork[]; partial: boolean };
    }
    type ListingResult = { items: HDRWork[]; partial: boolean };
    const pending = inFlight.get('all') as Promise<ListingResult> | undefined;
    if (pending) {
      // Refresh já rodando (background SWR ou cold start concorrente).
      if (lastGoodListings !== null) {
        // SWR: não bloqueia a resposta, devolve o lastGood e deixa o
        // refresh em andamento atualizar o cache quando terminar.
        return { items: lastGoodListings, partial: lastGoodIsPartial };
      }
      // Cold start sem lastGood: tem que esperar a primeira raspagem.
      return pending;
    }
    // Monta a tarefa de scrape uma vez para todos os concorrentes. O prazo é
    // o longo quando NINGUÉM espera: aquecimento (`background`) ou refresh de
    // SWR (já existe `lastGood` para responder na hora). Só o cold start com
    // busca pendurada paga o prazo curto.
    const semEspera = background || lastGoodListings !== null;
    const task = scrapeListings(semEspera ? LISTING_WARM_BUDGET_MS : LISTING_BUDGET_MS).then((result) => {
      const ttl = result.partial ? LISTING_PARTIAL_CACHE_MS : LISTING_CACHE_MS;
      listingCache.set('all', { value: result, expiresAt: Date.now() + ttl });
      lastGoodListings = result.items;
      lastGoodIsPartial = result.partial;
      return result;
    }).finally(() => inFlight.delete('all'));
    inFlight.set('all', task);
    // SWR: com lastGood disponível, devolve na hora e refresca em background.
    if (lastGoodListings !== null) {
      task.catch((err) => {
        console.warn(`[br] hdrtorrents: refresh em background falhou (${err.message})`);
      });
      return { items: lastGoodListings, partial: lastGoodIsPartial };
    }
    // Cold start (sem lastGood): bloqueia até a raspagem terminar.
    return task;
  }

  /**
   * Aquece o catálogo em background. Disparado no boot do addon para a
   * primeira busca real já encontrar listagem pronta. Sem await, erro
   * engolido — se falhar, a primeira busca paga o custo normal.
   * Se uma busca chegar junto, o inFlight do fetchAllListingsDetailed
   * compartilha a raspagem; warm() não duplica.
   */
  async function warm(): Promise<void> {
    try {
      // Passa pelo MESMO caminho da busca (não por `scrapeListings` direto):
      // é ele que registra o `inFlight['all']`. Chamar o scrape à mão deixava
      // o boot com duas raspagens paralelas — medido: warm + uma busca
      // chegando junto = 2 varreduras do site (até 40 páginas), exatamente o
      // desperdício que o aquecimento existe para evitar. Cache, TTL e
      // lastGood também são dele; aqui sobra só o log.
      const result = await fetchAllListingsDetailed({ background: true });
      console.log(`[br] hdrtorrents: warm → ${result.items.length} item(s)${result.partial ? ' (parcial)' : ''}`);
    } catch (err: any) {
      console.warn(`[br] hdrtorrents: warm falhou (${err.message})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Busca: catálogo → match → conteúdo → magnets.
  // ---------------------------------------------------------------------------
  async function getContentMagnets(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    if (!isDetailHost(post.hostname)) throw new Error('not_detail_page');
    return cachedPost(post.href, POST_CACHE_MS, async () => {
      const html = await fetchText(post.href);
      return parseContentMagnets(html, post.href);
    });
  }

  async function postToItems(post: HDRWork): Promise<HDRItem[]> {
    const links = await getContentMagnets(post.url);
    return links.map((link, index) => ({ post, link, index, count: links.length }));
  }

  async function searchPosts(query: string): Promise<HDRItem[]> {
    const requestedSeason = requestedSeasonFromQuery(query);
    const normalized = normalizeQuery(query);
    const cacheKey = `search:${String(query || '')}`;
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as HDRItem[];

    // inFlight por query: requisições concorrentes para a MESMA query
    // reaproveitam o mesmo trabalho (listagem + match + conteúdo).
    const pending = inFlight.get(cacheKey) as Promise<HDRItem[]> | undefined;
    if (pending) return pending;

    const task = (async () => {
      try {
        const listingResult = await fetchAllListingsDetailed();
        const allItems = listingResult.items;
        // TTL da busca acompanha o da listagem: se o catálogo está parcial,
        // a busca também expira rápido para tentar completar logo.
        const searchTtl = listingResult.partial ? SEARCH_CACHE_MS / 3 : SEARCH_CACHE_MS;
        siteSelector.noteSuccess();
        // Match contra o catálogo: tokens da query presentes no título (60%
        // de cobertura, mesmo threshold dos outros BR).
        let posts = allItems.filter((item) => matchesResolverQuery(item, normalized));
        if (requestedSeason) {
          posts = posts.filter((post) => matchesSeasonSeason(post, requestedSeason));
        }
        posts = posts.slice(0, MAX_POSTS);
        const chunks = await mapLimit(posts, async (post) => {
          try {
            return await postToItems(post);
          } catch (err) {
            console.warn(`[br] hdrtorrents: post sem magnets (${err.message})`);
            return [];
          }
        });
        const items = chunks.flat();
        console.log(`[br] hdrtorrents: "${normalized}" → ${posts.length} post(s), ${items.length} release(s)${listingResult.partial ? ' (catálogo parcial)' : ''}`);
        searchCache.set(cacheKey, { value: items, expiresAt: Date.now() + searchTtl });
        return items;
      } catch (err) {
        if (isNetworkError(err)) await siteSelector.noteFailure();
        throw err;
      } finally {
        inFlight.delete(cacheKey);
      }
    })();
    inFlight.set(cacheKey, task);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Resolve: magnet direto, sem protetor. O /resolve existe para o painel e
  // para compatibilidade, mas o Cardigann lê o magnet direto da página
  // sintética (sem download.before).
  // ---------------------------------------------------------------------------
  async function resolveBest(postUrl: string) {
    const post = assertAllowedUrl(postUrl);
    const links = await getContentMagnets(post.href);
    if (!links.length) throw new Error('no_magnets');
    return links[0].url;
  }

  async function resolveButton(postUrl: string, index: number) {
    const post = assertAllowedUrl(postUrl);
    const links = await getContentMagnets(post.href);
    if (index >= links.length) throw new Error('no_such_button');
    return links[index].url;
  }

  // ---------------------------------------------------------------------------
  // HTTP.
  // ---------------------------------------------------------------------------
  const searchPageHtml = createHDRSearchPageHtml();
  const renderHtml = (items: HDRItem[]) => searchPageHtml(items as HDRPageItem[]);

  const handleRequest = createResolverRouter({
    reply,
    routes: {
      '/health': createHealthRoute({ reply }),
      '/api': createApiRoute({
        reply,
        capsXml: () => `<?xml version="1.0" encoding="UTF-8"?><caps><server version="1.0"/><searching><search available="yes"/><tv-search available="yes" supportedParams="q,season,ep"/><movie-search available="yes" supportedParams="q"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>`,
        search: searchPosts,
        renderXml: (items, category) => hdrRssXml(items as HDRPageItem[], category),
        emptyXml: (category) => hdrRssXml([], category),
      }),
      '/search': createSearchRoute({ reply, search: searchPosts, renderHtml }),
    },
  });

  function createServer() {
    return createHttpServer(handleRequest);
  }

  return {
    createServer, siteSelector, SELF_URL: SELF_URL_RESOLVED,
    createSiteSelector: bootstrap.createSiteSelector,
    parseListingHtml, parseContentMagnets,
    matchesResolverQuery, matchesSeasonSeason, normalizeQuery,
    requestedSeasonFromQuery, classifyAudio,
    stripTags, decodeEntities, escapeXml,
    assertAllowedUrl, isDetailHost, isNetworkError,
    searchPosts, fetchText, fetchAllListings, fetchAllListingsDetailed, getContentMagnets,
    warm,
    postCache, searchCache, listingCache, inFlight,
    serveMain: bootstrap.serveMain,
  };
}

export { createResolver, DEFAULTS, META };
