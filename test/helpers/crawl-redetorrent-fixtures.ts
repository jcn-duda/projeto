// Dublês do adaptador RedeTorrent. Os POSTS são os HTML já commitados do
// resolver (`test/fixtures/redetorrent/`), lidos atrás do `stubFetch`; o
// SITEMAP é fixture desta mesma pasta e existe nos DOIS formatos que o site
// devolve (medido em 2026-09-29 pelo FlareSolverr): XML CRU do AIOSEO (com
// `<loc>` em CDATA, `*.xml-cdata.xml`) e o VISUALIZADOR XML do Chromium
// (tabela renderizada, zero `<loc>`, `*.html`).
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

// ── MOLDES DE SITEMAP (os DOIS formatos que o site devolve) ──────────────────
// Ficam aqui, e não no arquivo de teste, porque as duas suítes (a do adaptador e
// a dos formatos) montam linha nos dois formatos e uma cópia divergiria em
// silêncio — que é exatamente a classe de bug que esta suíte existe para pegar.

/** FORMATO B: uma linha da tabela do visualizador XML do Chromium. A data é o
 *  que o browser renderiza: `16 de September de 2026` (locale inglês, com o "de"
 *  português no meio) + `17:56`. */
export const viewerRow = (url: string, date: string, time: string): string =>
  `<tr><td class="left"><a href="${url}">${url}</a></td>`
  + `<td><div class="date">${date}</div><div class="time">${time}</div></td></tr>`;

/** FORMATO B: o documento inteiro (a tabela renderizada). */
export const viewerDoc = (...rows: string[]): string =>
  '<html><head><title>Sitemap</title></head><body><table class="xml-tree"><tbody>'
  + `${rows.join('')}</tbody></table></body></html>`;

/** FORMATO A: um bloco `<url>` do AIOSEO, com CDATA (é assim que o site
 *  escreve) — `lastmod` em ISO 8601 de verdade, com fuso. */
export const xmlRow = (url: string, lastmod: string): string =>
  `<url><loc><![CDATA[${url}]]></loc><lastmod><![CDATA[${lastmod}]]></lastmod></url>`;

/** FORMATO A: o documento inteiro. Sem linha alguma, é `<urlset/>` vazio — o
 *  formato reconhecido sem entrada, que a descoberta tem de tratar como falha. */
export const xmlDoc = (...rows: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8"?>'
  + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.join('')}</urlset>`;

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

/**
 * Um `movies-sitemap*.xml` SINTÉTICO em FORMATO A (XML cru, CDATA) com UMA
 * obra. É o que serve os arquivos 2..7 do acervo: a descoberta precisa LER os
 * sete (um por requisição no teto por hora) e, desde que "sitemap sem entrada"
 * passou a ser FALHA, nenhum deles pode responder vazio. São slugs de teste
 * declarados como tal — o acervo real está em `movies-sitemap.html`.
 */
export function extraMovieSitemap(n: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + `<url><loc><![CDATA[${SITE}/filmes/exemplo-sitemap${n}/]]></loc>`
    + `<lastmod><![CDATA[2026-0${n}-1${n}T09:00:00+00:00]]></lastmod></url>`
    + '</urlset>';
}

/** Slugs sintéticos dos arquivos 2..7, na ordem em que a descoberta os lê. */
export const extraSlugs = (): string[] => [2, 3, 4, 5, 6, 7].map((n) => `filmes/exemplo-sitemap${n}`);

/**
 * As 8 rotas que a descoberta real percorre: índice + 7 de filme + 1 de série.
 *
 * `pageRoutes()` serve o índice e o primeiro `movies-sitemap` no FORMATO B
 * (tabela, o recorte real) e os outros seis no FORMATO A — a descoberta
 * atravessa os dois caminhos em toda rodada, e `pageRoutesXml()` entrega os
 * MESMOS arquivos todos em XML cru para o teste de igualdade entre formatos.
 */
export function pageRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  const movies: Record<string, Route> = {};
  for (let i = 1; i <= 7; i += 1) {
    const name = i === 1 ? 'movies-sitemap.xml' : `movies-sitemap${i}.xml`;
    movies[`/${name}`] = () => (i === 1 ? fixture('movies-sitemap.html') : extraMovieSitemap(i));
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

/** As mesmas 8 rotas, com índice e `movies-sitemap.xml` em FORMATO A (XML cru
 *  com CDATA) — o gêmeo medido do `movies-sitemap.html`. */
export function pageRoutesXml(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    ...pageRoutes(extra),
    '/sitemap.xml': () => fixture('sitemap-index-cdata.xml'),
    '/sitemap_index.xml': () => fixture('sitemap-index-cdata.xml'),
    '/movies-sitemap.xml': () => fixture('movies-sitemap-cdata.xml'),
  };
}

/** Devolve o que `fn` devolveu (o teste de igualdade entre os dois formatos
 *  precisa do `CrawlDiscovery`, não só do efeito colateral). */
export async function withStub<T>(
  routes: Record<string, Route>,
  fn: (stub: FetchStub) => Promise<T>,
): Promise<T> {
  const stub = stubRoutes(routes);
  try { return await fn(stub); } finally { stub.restore(); }
}

export const site = () => createRedetorrentCrawlSite(resolverSurface());
export const probeSite = () => createRedetorrentCrawlSite(resolverSurface(), { seriesProbe: true });

export const pathsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).pathname; } catch { return c.url; }
});
export const hostsOf = (stub: FetchStub): string[] => stub.calls.map((c) => {
  try { return new URL(c.url).hostname; } catch { return c.url; }
});
