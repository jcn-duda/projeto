// Dublês de teste do adaptador NerdFilmes (Fase 8) — módulo folha compartilhado
// pelas DUAS suítes (`crawl-nerdfilmes` e `crawl-nerdfilmes-series`), para que
// rota de fetch, superfície do profile e leitura de fixture tenham UMA
// definição. Divergir aqui entre as suítes mediria duas rotas diferentes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolver } from '../../resolvers/profiles/nerdfilmes.js';
import { createNerdfilmesCrawlSite } from '../../src/providers/crawl-sites/nerdfilmes.js';
import type { NerdfilmesResolverSurface } from '../../src/providers/crawl-sites/nerdfilmes.js';
import { stubFetch, type FetchStub } from './stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, '..', 'fixtures', 'crawl', 'nerdfilmes');

/** Conteúdo de um fixture real (recorte declarado no cabeçalho do arquivo). */
export const fixture = (name: string): string => fs.readFileSync(path.join(FIX, name), 'utf8');

export const SITE = 'https://www.filmesviatorrenthd.net';
export const MOVIE = `${SITE}/bancarios-2020/`;
export const SERIES = `${SITE}/lanternas-1a-temporada-2026/`;
export const NO_BUTTONS = `${SITE}/o-assassinato-de-rachel-nickell-2026/`;

/** btih REAL extraído do gate capturado (32 base32, não 40 hex). */
export const REAL_BTIH = 'nmf6zyusxnxg5sun3bqeft3hkywalsmj';

/** 2026-09-28T01:15:24+00:00 — lastmod do primeiro post do sitemap real
 *  ("lanternas-1a-temporada-2026", que é temporada e não entra na fila). */
export const FIRST_LASTMOD = '2026-09-28T01:15:24+00:00';
/** lastmod do 2º post ("a-revolta-2026") — o 1º FILME do recorte real. */
export const SECOND_LASTMOD = '2026-09-27T20:59:10+00:00';
/** 3º post do recorte real (lastmod em ordem decrescente). */
export const THIRD_LASTMOD = '2026-09-27T20:57:54+00:00';

/** Os 13 slugs de TEMPORADA do recorte real, na ordem do arquivo. */
export const SEASON_SLUGS = [
  'lanternas-1a-temporada-2026', 'outlander-blood-of-my-blood-2a-temporada-2026',
  'american-hostage-1a-temporada-2026', 'confinada-1a-temporada-2026',
  'um-conto-de-duas-cidades-1a-temporada-2026', 'american-horror-story-13a-temporada-2026',
  's-w-a-t-exiles-1a-temporada-2026', 'terra-da-mafia-2a-temporada-2026',
  'materia-escura-2a-temporada-2026', 'stuart-nao-consegue-salvar-o-universo-1a-temporada-2026',
  'a-arca-the-ark-3a-temporada-2026', 'star-trek-strange-new-worlds-4a-temporada-2026',
  'brothers-1a-temporada-2026',
];

/** Corpo de resposta do dublê: string = 200; objeto = status explícito. */
export type Route = () => string | { status: number; body: string };

export function resolverSurface(): NerdfilmesResolverSurface {
  const resolver = createResolver({
    port: 0,
    selfUrl: 'http://127.0.0.1:0',
    siteUrl: SITE,
    extraProtectors: [],
  });
  // O profile devolve a superfície completa; o adaptador declara o recorte que
  // usa — a atribuição direta é o teste de que a API do profile continua batendo.
  return resolver;
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

/** Rotas mínimas de uma página de post + o gate do filme. */
export function pageRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/sitemap.xml': () => fixture('sitemap-index.xml'),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml'),
    [MOVIE]: () => fixture('post-movie.html'),
    '/link.php': () => fixture('gate-magnet.html'),
    ...extra,
  };
}

/** Rotas mínimas de uma página de TEMPORADA (post + gate). */
export function seriesRoutes(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/sitemap.xml': () => fixture('sitemap-index.xml'),
    '/post-sitemap.xml': () => fixture('post-sitemap.xml'),
    [SERIES]: () => fixture('post-series.html'),
    '/link.php': () => fixture('gate-magnet.html'),
    ...extra,
  };
}

/** Todas as 6 entradas `post-sitemap*` do índice respondendo o mesmo arquivo. */
export const ALL_SITEMAPS = {
  '/post-sitemap2.xml': () => fixture('post-sitemap.xml'),
  '/post-sitemap3.xml': () => fixture('post-sitemap.xml'),
  '/post-sitemap4.xml': () => fixture('post-sitemap.xml'),
  '/post-sitemap5.xml': () => fixture('post-sitemap.xml'),
  '/post-sitemap6.xml': () => fixture('post-sitemap.xml'),
};

/** Roda o corpo com o dublê montado e o `fetch` restaurado no fim. */
export async function withStub(routes: Record<string, Route>, fn: (stub: FetchStub) => Promise<void>): Promise<void> {
  const stub = stubRoutes(routes);
  try { await fn(stub); } finally { stub.restore(); }
}

/** Adapter novo por teste: a superfície é do profile real (sem estado global). */
export const site = () => createNerdfilmesCrawlSite(resolverSurface());
/** Adapter em MODO AMOSTRA: o único que abre página de temporada. */
export const probeSite = () => createNerdfilmesCrawlSite(resolverSurface(), { seriesProbe: true });

export const pathsOf = (stub: FetchStub): string[] => stub.calls.map((c) => new URL(c.url).pathname);
export const slugsOf = (urls: { url: string }[]): string[] =>
  urls.map((u) => new URL(u.url).pathname.replace(/^\/|\/$/g, ''));
