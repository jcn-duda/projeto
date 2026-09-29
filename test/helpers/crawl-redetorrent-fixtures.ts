// Dublês do adaptador RedeTorrent. Os POSTS são os HTML já commitados do
// resolver (`test/fixtures/redetorrent/`), lidos atrás do `stubFetch`; o
// SITEMAP é fixture desta mesma pasta e reproduz o VISUALIZADOR XML do
// Chromium (o que o FlareSolverr devolve, medido em 2026-09-28 — tabela
// renderizada, zero `<loc>`).
//
// O dublê é mais ESTRITO que o do ComandoTorrents de propósito: aqui o magnet é
// direto no HTML do post, então NÃO existe salto de protetor a servir. Qualquer
// URL fora do mapa estoura — é assim que o "custo 1 por página" do teste
// ganha valor (uma segunda requisição seria erro de rota, não número bonito).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/redetorrent.js';
import { createRedetorrentCrawlSite } from '../../src/providers/crawl-sites/redetorrent.js';
import type { RedetorrentResolverSurface } from '../../src/providers/crawl-sites/redetorrent.js';
import { stubFetch, type FetchStub } from './stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures', 'redetorrent');

/** Host canônico do site (o `siteUrl` que o seletor assume como primário). */
export const SITE = 'https://www.redetorrent.xyz';
/** Página de filme do acervo real; `<h1>` = "Coringa: Delírio a Dois (2024)". */
export const MOVIE = `${SITE}/filmes/coringa-delirio-a-dois/`;
/** Página de série do acervo real; `<h1>` = "Fallout 1ª 2ª Temporada (2025)". */
export const SERIES = `${SITE}/series/fallout/`;
/** Host alheio usado no sitemap para provar a trava de host. */
export const OFFSITE = 'https://filmes-exemplo-spam.test';

export const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');
/** Os posts são os HTML do RESOLVER (não há fixture de post nova: o layout do
 *  post é o mesmo que o card vivo consome, e duplicá-lo seria uma terceira
 *  versão do mesmo HTML). */
export const postFixture = fixture;

export type Route = () => string | { status: number; body: string };

export function resolverSurface(): RedetorrentResolverSurface {
  return createResolver({
    port: 0,
    selfUrl: 'http://127.0.0.1:0',
    siteUrl: SITE,
    extraProtectors: [],
  });
}

function responseOf(value: string | { status: number; body: string }) {
  const status = typeof value === 'string' ? 200 : value.status;
  const text = typeof value === 'string' ? value : value.body;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
  };
}

/** Casa por substring, primeira chave vence; fora do mapa é erro de rota. */
export function stubRoutes(routes: Record<string, Route>): FetchStub {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) return responseOf(body());
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

/** As 8 rotas que a descoberta real percorre: índice + 7 de filme + 1 de série. */
export function pageRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  const movies: Record<string, Route> = {};
  // O acervo real tem 7 arquivos `movies-sitemap*` (1.000 URLs cada, 6.737 no
  // total). Só o primeiro traz linhas; os outros entram VAZIOS de propósito —
  // a descoberta precisa LER os sete (um por requisição no teto por hora), e
  // os testes só precisam saber o que o primeiro devolve.
  for (let i = 1; i <= 7; i += 1) {
    const name = i === 1 ? 'movies-sitemap.xml' : `movies-sitemap${i}.xml`;
    movies[`/${name}`] = () => fixture(i === 1 ? 'movies-sitemap.html' : 'movies-sitemap-vazio.html');
  }
  return {
    '/sitemap.xml': () => fixture('sitemap-index.html'),
    '/sitemap_index.xml': () => fixture('sitemap-index.html'),
    ...movies,
    '/tvshows-sitemap.xml': () => fixture('tvshows-sitemap.html'),
    [MOVIE]: () => postFixture('post-coringa-delirio.html'),
    [SERIES]: () => postFixture('serie-fallout.html'),
    ...extra,
  };
}

export async function withStub(
  routes: Record<string, Route>,
  fn: (stub: FetchStub) => Promise<void>,
): Promise<void> {
  const stub = stubRoutes(routes);
  try { await fn(stub); } finally { stub.restore(); }
}

export const site = () => createRedetorrentCrawlSite(resolverSurface());
export const probeSite = () => createRedetorrentCrawlSite(resolverSurface(), { seriesProbe: true });

export const pathsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).pathname; } catch { return c.url; }
});
export const hostsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).hostname; } catch { return c.url; }
});
