// Dublês de `fetch` e superfície do profile para o adaptador do HDRTorrent.
//
// O teste usa o PROFILE REAL (`resolvers/profiles/hdrtorrents.ts`) com o
// `fetch` substituído, como os testes de crawl dos outros sites: assim o
// `parseListingHtml`, o `parseContentMagnets` e o `releaseTitle` exercitados
// são os de produção, e uma mudança de layout do site quebra o teste aqui.
//
// As fixtures são RECORTES reais (o aviso está no cabeçalho de cada arquivo):
// o bloco do card inteiro na listagem, e `<h1>` + ficha + `download-row` no
// post.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/hdrtorrents.js';
import type { HdrtorrentsResolverSurface } from '../../src/providers/crawl-sites/hdrtorrents.js';
import type { CrawlSite } from '../../src/providers/crawl-types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'crawl', 'hdrtorrents');

/** HTML de uma fixture de listagem ou de post. */
export function hdrFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.html`), 'utf8');
}

/** URLs das obras que a fixture de listagem publica, na ordem do site. */
export function hdrListingUrls(name: string): string[] {
  return [...hdrFixture(name).matchAll(/<a\b[^>]*?\bhref=["']([^"']+)["']/gi)].map((m) => m[1]);
}

/** Uma requisição a responder por URL (ou `null` para 404). */
export interface HdrRoute {
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
export function hdrSurface(routes: Array<[string, HdrRoute]>): {
  surface: HdrtorrentsResolverSurface;
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
    port: 18799,
    selfUrl: 'http://127.0.0.1:18799',
    siteUrl: 'https://hdrtorrents.net',
  });
  const surface = {
    siteSelector: resolver.siteSelector,
    assertAllowedUrl: resolver.assertAllowedUrl,
    isDetailHost: resolver.isDetailHost,
    isNetworkError: resolver.isNetworkError,
    fetchText: (url: string) => resolver.fetchText(url),
    parseListingHtml: resolver.parseListingHtml,
    parseContentMagnets: resolver.parseContentMagnets,
    releaseTitle: resolver.releaseTitle,
  } as unknown as HdrtorrentsResolverSurface;
  return { surface, urls, restore: () => { globalThis.fetch = originalFetch; } };
}

/**
 * Adaptador pronto para o teste, com o `crawl.db` aberto em memória. O motor
 * grava o cursor de listagem no `crawl_state`, e sem store aberto o
 * `setState` é um no-op silencioso — a retomada viraria não testada.
 */
export async function withSite<T>(
  routes: Array<[string, HdrRoute]>,
  run: (input: { site: CrawlSite; urls: string[] }) => Promise<T>,
  options: { seriesProbe?: boolean } = {},
): Promise<T> {
  const { open, resetForTests } = await import('../../src/utils/crawl-store.js');
  // O cursor de LISTAGEM é durável e por site: sem o reset, o teste seguinte
  // herdaria a posição do anterior e "descobriria" a partir da página 21.
  // `open()` sozinho é no-op quando já existe engine — daí o `resetForTests`.
  resetForTests();
  open(undefined, { forceMemory: true });
  const { surface, urls, restore } = hdrSurface(routes);
  try {
    const { createHdrtorrentsCrawlSite } = await import('../../src/providers/crawl-sites/hdrtorrents.js');
    const site = createHdrtorrentsCrawlSite(surface, { seriesProbe: options.seriesProbe === true });
    return await run({ site, urls });
  } finally {
    restore();
  }
}

/**
 * Rota da PRIMEIRA página da listagem. O site responde a página 1 na HOME
 * (`/`) — é ela que devolve os 20 cards — e as seguintes em `/pagina/N/`. O
 * casamento é exato, então a página 2 cai em 404 e o teste mede paginação de
 * verdade.
 */
export function listingRoute(name: string): [string, HdrRoute] {
  return ['https://hdrtorrents.net/', { body: hdrFixture(name) }];
}
