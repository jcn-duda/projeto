// Dublês de teste do adaptador TorrentDosFilmes (Fase 8) — módulo folha
// compartilhado pelas suítes de filme e de temporada, para que rota de fetch,
// superfície do profile e leitura de fixture tenham UMA definição. Divergir
// aqui entre as suítes mediria duas rotas diferentes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/torrentdosfilmes.js';
import { createTorrentdosfilmesCrawlSite } from '../../src/providers/crawl-sites/torrentdosfilmes.js';
import type { TorrentdosfilmesResolverSurface } from '../../src/providers/crawl-sites/torrentdosfilmes.js';
import { stubFetch, type FetchStub } from './stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures', 'crawl', 'torrentdosfilmes');

/** Conteúdo de um fixture real (recorte declarado no cabeçalho do arquivo). */
export const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');

export const SITE = 'https://torrentdosfilmes-v2.xyz';
/** Filme real: 3 âncoras de magnet com 2 btih distintos, e o plugin de IMDb de
 *  recomendação (tt de obra ALEATÓRIA) na mesma página. */
export const MOVIE = `${SITE}/como-viajar-com-o-mala-do-seu-pai-2008-bluray-1080p-dual-audio-torrentgdrive/`;
/** Temporada real: pack (`dn=…S01Comp`), 1 magnet, sem IMDb. */
export const SERIES = `${SITE}/o-cacador-1a-temporada-completa-mini-serie-2014-hdtv-720p-dublado-torrent-download/`;
/** A home que o post-sitemap do site inclui como PRIMEIRA entrada. */
export const HOME = `${SITE}/`;

/** btih REAIS dos dois magnets distintos do post de filme (40 hex e 32 base32).
 *  A caixa do base32 é a que o SITE publica (o `magnetHash` do adaptador
 *  minúscula para o dedupe — a distinção é o que a suíte fixa). */
export const MOVIE_BTIH_HEX = '74c56042d7775f2900d0bc6fd7ee18bad05ebd42';
export const MOVIE_BTIH_BASE32 = 'GJK25RHW5HNUXLY3GCPNENRKZYO5U6RW';
/** btih do pack de temporada (o site publica em maiúscula). */
export const SERIES_BTIH = '0A9D58F9B2ED97415B29030E38E82E060BE7F0C0';

/** lastmod do 1º post do recorte real (a home, que não é obra). */
export const HOME_LASTMOD = '2026-09-28T18:22:10+00:00';
/** lastmod do post de filme usado nos testes (bloco 2 do recorte real). */
export const MOVIE_LASTMOD = '2015-02-05T01:26:15+00:00';

/** Os 2 slugs de TEMPORADA do recorte real de 40, na ordem do arquivo, sem
 *  as barras (mesmo formato de `slugsOf`). */
export const SEASON_SLUGS: string[] = [...fixture('post-sitemap.xml')
  .matchAll(/<loc>([^<]+)<\/loc>/gi)]
  .map((m) => new URL(m[1]).pathname.replace(/^\/|\/$/g, ''))
  .filter((slug) => slug && /temporada/i.test(slug));

/** Corpo de resposta do dublê: string = 200; objeto = status explícito. */
export type Route = () => string | { status: number; body: string };

/**
 * A superfície do PROFILE REAL (mesmos parsers, mesmo allowlist, mesmo
 * transporte). Sem o `fetchTextDirect` novo o adaptador nem compila — a
 * atribuição direta é o teste de que a API do profile continua batendo.
 */
export function resolverSurface(): TorrentdosfilmesResolverSurface {
  return createResolver({
    port: 0,
    selfUrl: 'http://127.0.0.1:0',
    siteUrl: SITE,
    extraProtectors: [],
  });
}

/**
 * Dublê de fetch com as rotas dos fixtures. `routes` casa por substring e o
 * PRIMEIRO vence; uma função pode lançar para simular falha. URL fora do mapa
 * falha — é o que trava "descobriu host de fora" e "crawl não saiu do site".
 */
export function stubRoutes(routes: Record<string, Route>): FetchStub {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) {
        const value = body();
        const status = typeof value === 'string' ? 200 : value.status;
        const text = typeof value === 'string' ? value : value.body;
        // O transporte do protetor lê `headers.get('set-cookie')` em todo salto.
        return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
      }
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

/** Rotas mínimas de uma página de post de filme. */
export function pageRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/sitemap_index.xml': () => fixture('sitemap-index.xml'),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml'),
    [MOVIE]: () => fixture('post-movie.html'),
    ...extra,
  };
}

/** Rotas mínimas de uma página de TEMPORADA (o pack). */
export function seriesRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/sitemap_index.xml': () => fixture('sitemap-index.xml'),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml'),
    [SERIES]: () => fixture('post-series.html'),
    ...extra,
  };
}

/** Os outros 2 `post-sitemap*` do índice respondendo o mesmo arquivo. */
export const ALL_SITEMAPS = {
  '/post-sitemap2.xml': () => fixture('post-sitemap.xml'),
  '/post-sitemap3.xml': () => fixture('post-sitemap.xml'),
};

/** Roda o corpo com o dublê montado e o `fetch` restaurado no fim. */
export async function withStub(routes: Record<string, Route>, fn: (stub: FetchStub) => Promise<void>): Promise<void> {
  const stub = stubRoutes(routes);
  try { await fn(stub); } finally { stub.restore(); }
}

/** Adapter novo por teste: a superfície é do profile real (sem estado global). */
export const site = () => createTorrentdosfilmesCrawlSite(resolverSurface());
/** Adapter em MODO AMOSTRA: o único que abre página de temporada. */
export const probeSite = () => createTorrentdosfilmesCrawlSite(resolverSurface(), { seriesProbe: true });

export const pathsOf = (stub: FetchStub): string[] => stub.calls.map((c) => new URL(c.url).pathname);
export const slugsOf = (urls: { url: string }[]): string[] =>
  urls.map((u) => new URL(u.url).pathname.replace(/^\/|\/$/g, ''));
