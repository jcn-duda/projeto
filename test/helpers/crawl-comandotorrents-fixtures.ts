// Dublês do adaptador ComandoTorrents. Sitemap é fixture desta pasta; o post
// de filme e o de temporada reutilizam os HTML já commitados do resolver, com
// o fetch dublê — o salto do botão nunca sai da máquina.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/comandotorrents.js';
import { createComandotorrentsCrawlSite } from '../../src/providers/crawl-sites/comandotorrents.js';
import type { ComandotorrentsResolverSurface } from '../../src/providers/crawl-sites/comandotorrents.js';
import { stubFetch, type FetchStub } from './stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures', 'crawl', 'comandotorrents');
const POSTS = path.join(__dirname, '..', 'fixtures');

export const SITE = 'https://comandotorrents.to';
export const MOVIE = `${SITE}/furiosa-uma-saga-mad-max/`;
export const SERIES = `${SITE}/the-boys-4a-temporada-torrent/`;
/** btih fixo do dublê: os botões do fixture caem no mesmo corpo. */
export const STUB_BTIH = '0123456789abcdef0123456789abcdef01234567';

const MAGNET_HTML = `<a href="magnet:?xt=urn:btih:${STUB_BTIH}&amp;dn=obra">magnet</a>`;

export const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');
export const postFixture = (name: string): string => fs.readFileSync(path.join(POSTS, name), 'utf8');

export type Route = () => string | { status: number; body: string; location?: string };

export function resolverSurface(): ComandotorrentsResolverSurface {
  return createResolver({
    port: 0,
    selfUrl: 'http://127.0.0.1:0',
    siteUrl: SITE,
    extraProtectors: [],
  });
}

function responseOf(value: string | { status: number; body: string; location?: string }) {
  const status = typeof value === 'string' ? 200 : value.status;
  const text = typeof value === 'string' ? value : value.body;
  const location = typeof value === 'string' ? null : (value.location ?? null);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : null) },
    text: async () => text,
  };
}

/**
 * Casa por substring e o primeiro vence. URL do site fora do mapa falha (trava
 * host alheio no sitemap). URL de outro host que não é sitemap devolve o
 * magnet do dublê: é o salto do botão, sem rede.
 */
export function stubRoutes(routes: Record<string, Route>, offsite: Route = () => MAGNET_HTML): FetchStub {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return responseOf(body());
    }
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { /* segue */ }
    if (hostname && hostname !== 'comandotorrents.to' && !url.includes('.xml')) {
      return responseOf(offsite());
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

export function pageRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/sitemap.xml': () => fixture('sitemap-index.xml'),
    '/sitemap_index.xml': () => fixture('sitemap-index.xml'),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml'),
    '/post-sitemap2.xml': () => fixture('post-sitemap2.xml'),
    '/redirect': () => `<a href="magnet:?xt=urn:btih:${STUB_BTIH}&amp;dn=obra">magnet</a>`,
    [MOVIE]: () => postFixture('comandotorrents-post.html'),
    [SERIES]: () => postFixture('comandotorrents-series-episodic.html'),
    ...extra,
  };
}

export async function withStub(
  routes: Record<string, Route>,
  fn: (stub: FetchStub) => Promise<void>,
  offsite?: Route,
): Promise<void> {
  const stub = offsite ? stubRoutes(routes, offsite) : stubRoutes(routes);
  try { await fn(stub); } finally { stub.restore(); }
}

export const site = () => createComandotorrentsCrawlSite(resolverSurface());
export const probeSite = () => createComandotorrentsCrawlSite(resolverSurface(), { seriesProbe: true });

export const pathsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).pathname; } catch { return c.url; }
});
export const hostsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).hostname; } catch { return c.url; }
});
