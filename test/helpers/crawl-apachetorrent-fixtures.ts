// Dublês de `fetch` e superfície do profile para o adaptador do ApacheTorrent.
//
// O teste usa o PROFILE REAL (`resolvers/profiles/apachetorrent.ts`) com o
// `fetch` substituído, como nos testes de crawl dos outros sites: assim o
// `parsePostMagnets` e o `releaseTitle` exercitados são os de produção, e uma
// mudança de layout do site quebra o teste aqui. A extração do CARD é a REGRA
// PURA de `apachetorrent-discovery.ts` (o profile não tem parser de listagem),
// e é ela que a fixture de listagem exercita.
//
// As fixtures são RECORTES reais (o aviso está no cabeçalho de cada arquivo):
// o card inteiro de cada card da listagem mais o `ItemList` do topo, e
// `<h1>` + `item-lead` + ficha + blocos de download no post.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/apachetorrent.js';
import type { ApacheResolverSurface } from '../../src/providers/crawl-sites/apachetorrent.js';
import type { CrawlSite } from '../../src/providers/crawl-types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'crawl', 'apachetorrent');

/** Base do site nos testes (a mesma que `APACHETORRENT_URL` aponta em prod). */
export const APACHE_BASE = 'https://apachetorrents.com';

/** HTML de uma fixture de listagem ou de post. */
export function apacheFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.html`), 'utf8');
}

/**
 * URLs das obras que a fixture de listagem publica, na ordem do site e já
 * deduplicadas — é a MESMA ordem que o adaptador tem de entregar, então a
 * comparação com `found.urls` é o teste de que o dedupe dos 2 links por card
 * aconteceu (sem ele viriam 2× cada).
 */
export function apacheListingUrls(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of apacheFixture(name).matchAll(/<a\b[^>]*?\bhref=["']([^"']+)["']/gi)) {
    const url = match[1];
    if (!/^https:\/\/apachetorrents\.com\/[^/]+-baixar-torrent\/$/.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * O que o PRÓPRIO site declara no `ItemList` de `application/ld+json`: o
 * `Movie`/`TVSeries` de cada item, na ordem. Serve de conferência independente
 * do tipo que o adaptador deduz do card+slug — é o site dizendo a mesma coisa
 * por outro caminho.
 */
export function apacheItemListKinds(name: string): Array<'movie' | 'tv_show'> {
  const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i
    .exec(apacheFixture(name))?.[1] ?? '';
  const out: Array<'movie' | 'tv_show'> = [];
  for (const match of json.matchAll(/"@type"\s*:\s*"(Movie|TVSeries)"/g)) {
    out.push(match[1] === 'Movie' ? 'movie' : 'tv_show');
  }
  return out;
}

/** Uma requisição a responder por URL (ou `null` para 404). */
export interface ApacheRoute {
  status?: number;
  body: string;
}

/**
 * Superfície do profile com o `fetch` substituído por um roteador de URL.
 *
 * A `needle` casa por INCLUSÃO de substring, para as URLs que são prefixo de
 * outras (o host inteiro). Quando ela é uma URL COMPLETA, o casamento é
 * EXATO: sem isso, uma rota da página 1 responderia também na página 2 e o
 * teste mediria inversão de página em vez de paginação.
 */
export function apacheSurface(routes: Array<[string, ApacheRoute]>): {
  surface: ApacheResolverSurface;
  urls: string[];
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const target = String(input);
    urls.push(target);
    const hit = routes.find(([needle]) => (
      /^https?:\/\//i.test(needle) ? target === needle : target.includes(needle)
    ));
    if (!hit) return { ok: false, status: 404, headers: new Headers(), text: async () => '' } as unknown as Response;
    return {
      ok: (hit[1].status ?? 200) < 400,
      status: hit[1].status ?? 200,
      headers: new Headers(),
      text: async () => hit[1].body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;

  const resolver = createResolver({
    port: 18798,
    selfUrl: 'http://127.0.0.1:18798',
    siteUrl: APACHE_BASE,
  });
  const surface = {
    siteSelector: resolver.siteSelector,
    assertAllowedUrl: resolver.assertAllowedUrl,
    isDetailHost: resolver.isDetailHost,
    isNetworkError: resolver.isNetworkError,
    fetchText: (url: string) => resolver.fetchText(url),
    parsePostMagnets: resolver.parsePostMagnets,
    releaseTitle: resolver.releaseTitle,
  } as unknown as ApacheResolverSurface;
  return { surface, urls, restore: () => { globalThis.fetch = originalFetch; } };
}

/**
 * Adaptador pronto para o teste, com o `crawl.db` aberto em memória. O motor
 * grava o cursor de listagem no `crawl_state`, e sem store aberto o
 * `setState` é um no-op silencioso — a retomada viraria não testada.
 */
export async function withSite<T>(
  routes: Array<[string, ApacheRoute]>,
  run: (input: { site: CrawlSite; urls: string[] }) => Promise<T>,
  options: { seriesProbe?: boolean } = {},
): Promise<T> {
  const { open, resetForTests } = await import('../../src/utils/crawl-store.js');
  // O cursor de LISTAGEM é durável e por site: sem o reset, o teste seguinte
  // herdaria a posição do anterior e "descobriria" a partir da página 21.
  // `open()` sozinho é no-op quando já existe engine — daí o `resetForTests`.
  resetForTests();
  open(undefined, { forceMemory: true });
  const { surface, urls, restore } = apacheSurface(routes);
  try {
    const { createApachetorrentCrawlSite } = await import('../../src/providers/crawl-sites/apachetorrent.js');
    const site = createApachetorrentCrawlSite(surface, { seriesProbe: options.seriesProbe === true });
    return await run({ site, urls });
  } finally {
    restore();
  }
}

/**
 * Rota da PRIMEIRA página da listagem. O site responde a página 1 na HOME (`/`,
 * medido: os mesmos 20 cards que `/pagina/1/`) e as seguintes em `/pagina/N/`.
 * O casamento é exato, então a página 2 cai em 404 e o teste mede paginação de
 * verdade.
 */
export function listingRoute(name: string): [string, ApacheRoute] {
  return [`${APACHE_BASE}/`, { body: apacheFixture(name) }];
}
