// Dublês do adaptador BLUDV. As fixtures são RECORTES REAIS capturados do site
// em 2026-09-29 (`test/fixtures/crawl/bludv/`), lidos atrás do `stubFetch`.
//
// O dublê é mais ESTRITO que o do TorrentDosFilmes de propósito: aqui o magnet é
// DIRETO no HTML do post, então NÃO existe salto de protetor a servir, e o
// `requestCost` de uma página tem de ser 1. Qualquer URL fora do mapa estoura —
// é assim que "custo 1 por página" ganha valor (uma segunda requisição seria
// erro de rota, não número bonito).
//
// O SITEMAP é a única parte que precisa de gêmeo: o índice real tem 18
// `post-sitemap*` e o acervo 17.860 linhas, o que é caro demais para uma rodada
// de teste. O arquivo 1 é o real (`post-sitemap.xml`, 1.001 linhas) e os outros
// 17 são SINTÉTICOS, declarados como tais nos slugs — a descoberta precisa ler
// os dezoito (um por requisição no teto por hora) e nenhum deles pode responder
// vazio, porque "sitemap sem entrada" é FALHA.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/bludv.js';
import { createBludvCrawlSite } from '../../src/providers/crawl-sites/bludv.js';
import type { BludvResolverSurface } from '../../src/providers/crawl-sites/bludv.js';
import { stubFetch, type FetchStub } from './stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures', 'crawl', 'bludv');

/** Host canônico do site (o `siteUrl` que o seletor assume como primário). */
export const SITE = 'https://bludvfilmes1.xyz';
/** Página de filme real; `<h1>` = "O Final da Turnê Torrent – Blu-ray Rip 720p e 1080p Dublado (2016)". */
export const MOVIE = `${SITE}/o-final-da-turne-torrent-blu-ray-rip-720p-e-1080p-dublado-2016/`;
/** Página de série real; `<h1>` = "O Exterminador do Futuro: Crônicas de Sarah Connor 2ª Temporada … (2009)". */
export const SERIES = `${SITE}/o-exterminador-do-futuro-cronicas-de-sarah-connor-2a-temporada-torrent-blu-ray-rip-720p-dublado-2009/`;
/** Host alheio usado no sitemap para provar a trava de host. */
export const OFFSITE = 'https://filmes-exemplo-spam.test';

export const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');

/** Quantos `post-sitemap*` o índice real declara (medido: 18). */
export const SITEMAP_FILES = 18;

export function resolverSurface(): BludvResolverSurface {
  return createResolver({
    port: 0,
    selfUrl: 'http://127.0.0.1:0',
    siteUrl: SITE,
    extraProtectors: [],
  });
}

export type Route = () => string | { status: number; body: string };

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

/**
 * Um `post-sitemap*.xml` SINTÉTICO com UMA obra. Serve os arquivos 2..18 do
 * acervo: a descoberta precisa ler os dezoito (um por requisição no teto por
 * hora) e nenhum pode responder vazio. São slugs de teste declarados como tal —
 * o acervo real está em `post-sitemap.xml`.
 */
export function extraPostSitemap(n: number): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + `<url><loc>https://bludvfilmes1.xyz/exemplo-sitemap-${n}-torrent-dublado-20${10 + n}/</loc>`
    + `<lastmod>2026-0${(n % 9) + 1}-1${n % 9}T09:00:00+00:00</lastmod></url>`
    + '</urlset>';
}

/** Slugs SINTÉTICOS dos arquivos 3..18, na ordem em que a descoberta os lê.
 *  O arquivo 2 é o recorte real (`post-sitemap-recorte.xml`) e não entra aqui. */
export const extraSlugs = (): string[] =>
  Array.from({ length: SITEMAP_FILES - 2 }, (_, i) => `exemplo-sitemap-${i + 3}-torrent-dublado-20${13 + i}`);

/**
 * As 19 rotas que a descoberta real percorre: índice + os 18 `post-sitemap*`.
 * DOIS deles são recorte REAL — `post-sitemap.xml` (1.001 linhas, com a home na
 * primeira e a única linha que traz `image:loc`) e `post-sitemap-recorte.xml`
 * (6 linhas, a mesma linha da capa em tamanho legível). Os outros 16 são
 * SINTÉTICOS, declarados como tal nos slugs: a descoberta precisa ler os dezoito
 * (um por requisição no teto por hora) e nenhum pode responder vazio, porque
 * "sitemap sem entrada" é FALHA.
 */
export function pageRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  const posts: Record<string, Route> = {};
  for (let i = 1; i <= SITEMAP_FILES; i += 1) {
    const name = i === 1 ? 'post-sitemap.xml' : i === 2 ? 'post-sitemap2.xml' : `post-sitemap${i}.xml`;
    const body = i === 1 ? fixture('post-sitemap.xml')
      : i === 2 ? fixture('post-sitemap-recorte.xml')
        : extraPostSitemap(i);
    posts[`/${name}`] = () => body;
  }
  return {
    '/sitemap_index.xml': () => fixture('sitemap-index.xml'),
    '/sitemap.xml': () => fixture('sitemap-index.xml'),
    '/wp-sitemap.xml': () => fixture('sitemap-index.xml'),
    ...posts,
    [MOVIE]: () => fixture('post-movie.html'),
    [SERIES]: () => fixture('post-series.html'),
    ...extra,
  };
}

/** Devolve o que `fn` devolveu (o teste precisa do `CrawlDiscovery`, não só o efeito). */
export async function withStub<T>(
  routes: Record<string, Route>,
  fn: (stub: FetchStub) => Promise<T>,
): Promise<T> {
  const stub = stubRoutes(routes);
  try { return await fn(stub); } finally { stub.restore(); }
}

export const site = () => createBludvCrawlSite(resolverSurface());
export const probeSite = () => createBludvCrawlSite(resolverSurface(), { seriesProbe: true });

export const pathsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).pathname; } catch { return c.url; }
});
export const hostsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).hostname; } catch { return c.url; }
});
