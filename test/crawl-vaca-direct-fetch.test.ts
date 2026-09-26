// Endurecimento do transporte do crawl Vaca (revisão da Fase 1), sem rede:
//
//   - fetchTextDirect segue redirects HTTP MANUALMENTE (redirect:'manual'):
//     cada salto resolve o Location e é validado na allowlist do profile
//     ANTES do fetch — 301/302 para loopback (FlareSolverr local) ou
//     metadado de nuvem nunca saem em rede; o teto de saltos é o maxHops do
//     profile (`too_many_redirects`) e o desafio Cloudflare no fim da cadeia
//     segue sendo ERRO do caminho direto, nunca fallback.
//   - Cadeia que resolve sem magnet nenhum é falha TOTAL (layout/protetor
//     mudou), nunca `done` com 0 releases nem `no-torrent`; botão INDIVIDUAL
//     falho é tolerado quando outro botão rende release.
//
// O redirect roda no PROFILE REAL (createResolver do vacatorrent) com fetch
// dublê; a cadeia sem magnet usa superfície sintética — o profile real hoje
// só devolve magnet ou erro, e o contrato do adaptador tem que segurar o dia
// em que o transporte passa a devolver HTML final sem magnet.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResolver, DEFAULTS } from '../resolvers/profiles/vacatorrent.js';
import { createVacaCrawlSite } from '../src/providers/crawl-sites/vaca.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { ResolverLink } from '../resolvers/types.js';
import { stubFetch, type FetchStub } from './helpers/stub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'crawl', 'vaca');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

const SITE = 'https://vaqueirofilmes.com';
const PAGE_TORRENT = `${SITE}/pt/movie/expresso-do-amanha/`;
const PAGE_REDIRECT = `${SITE}/pt/movie/expresso-do-amanha-hd/`;
const ALT_BTIH = '0123456789abcdef0123456789abcdef01234567';
const MAGNET_RE = /magnet:\?xt=urn:btih:[a-z0-9]+/i;

function resolverSurface(): VacaResolverSurface {
  return createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: SITE, extraProtectors: [] });
}

/** Rota: string (200), objeto (status/headers crus para redirect 3xx) ou função. */
type StubRoute = string | { body: string; status?: number; headers?: Record<string, string> } | (() => string);

function stubRoutes(routes: Record<string, StubRoute>): FetchStub {
  return stubFetch((url) => {
    for (const [match, route] of Object.entries(routes)) {
      if (url.includes(match)) {
        const body = typeof route === 'function' ? route() : typeof route === 'string' ? route : route.body;
        const status = typeof route === 'object' && 'status' in route ? (route.status ?? 200) : 200;
        const headers = typeof route === 'object' && 'headers' in route && route.headers ? route.headers : {};
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
          text: async () => body,
        };
      }
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

/** Cadeia real do protetor para os botões do fixture de movie-links. */
function protectorRoutes(): Record<string, StubRoute> {
  return {
    'systemtech.space/enc/go.php': () => fixture('protector-processar.html'),
    't.co/SFsPRm91bg': () => fixture('protector-tco.html'),
    'systemtech.space/enc/relay.php': () => fixture('protector-final-magnet.txt'),
    'vacadb.org': () => fixture('protector-final-magnet.txt'),
  };
}

describe('crawl-sites/vaca: fetchTextDirect segue redirect manual com allowlist por salto', () => {
  test('301 para loopback é bloqueado ANTES do fetch do salto', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: { body: '', status: 301, headers: { location: 'http://127.0.0.1:8191/v1' } },
    });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /blocked_host/,
      );
      assert.deepEqual(stub.calls.map((c) => c.url), [PAGE_TORRENT], 'o salto para loopback nunca é buscado');
      assert.equal(stub.calls[0].options?.redirect, 'manual', 'o crawl não usa redirect:follow');
    } finally {
      stub.restore();
    }
  });

  test('redirect para o metadado de nuvem também é bloqueado sem rede', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: { body: '', status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
    });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /blocked_host/,
      );
      assert.ok(stub.calls.every((c) => !c.url.includes('169.254.169.254')), 'metadado nunca é buscado');
    } finally {
      stub.restore();
    }
  });

  test('índice de sitemap que redireciona para host de fora derruba a rodada sem buscar o salto', async () => {
    const stub = stubRoutes({
      'sitemap_index.xml': { body: '', status: 302, headers: { location: 'http://127.0.0.1:7000/movie-sitemap12.xml' } },
    });
    try {
      await assert.rejects(() => createVacaCrawlSite(resolverSurface()).discover(), /blocked_host/);
      assert.equal(stub.calls.length, 1, 'só o índice pedido; o salto de fora nunca sai');
    } finally {
      stub.restore();
    }
  });

  test('redirect legítimo é seguido: Location relativo resolvido e obra lida no destino', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: { body: '', status: 302, headers: { location: '/pt/movie/expresso-do-amanha-hd/' } },
      'expresso-do-amanha-hd': () => fixture('movie-page-torrent.html'),
      [`${SITE}/movie-links/61616/`]: () => fixture('movie-links-torrent.html'),
      ...protectorRoutes(),
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT);
      assert.equal(result.status, 'done', 'a cadeia no destino do redirect rende release');
      assert.equal(result.releases?.length, 1);
      assert.ok(stub.calls.some((c) => c.url === PAGE_REDIRECT), 'o destino do redirect é buscado');
      assert.equal(stub.calls[0].options?.redirect, 'manual');
      assert.ok(stub.calls[0].options?.headers?.Accept, 'headers reconstruídos por hop');
    } finally {
      stub.restore();
    }
  });

  test('laço de redirects termina em too_many_redirects no teto do profile', async () => {
    const stub = stubRoutes({
      [PAGE_TORRENT]: { body: '', status: 301, headers: { location: PAGE_TORRENT } },
    });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /too_many_redirects/,
      );
      assert.equal(stub.calls.length, DEFAULTS.maxHops + 1, 'original + maxHops saltos, nada além');
    } finally {
      stub.restore();
    }
  });

  test('3xx sem Location é erro, não espera eterna nem loop', async () => {
    const stub = stubRoutes({ [PAGE_TORRENT]: { body: '', status: 302 } });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /missing_redirect/,
      );
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });

  test('desafio Cloudflare no FIM da cadeia segue erro do caminho direto, sem FlareSolverr', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body>'
      + '<script>window._cf_chl_opt = {"cvId":"3"}</script>'
      + 'Verifique se você é humano — challenges.cloudflare.com</body></html>';
    const stub = stubRoutes({
      [PAGE_TORRENT]: { body: '', status: 301, headers: { location: '/pt/movie/expresso-do-amanha-hd/' } },
      'expresso-do-amanha-hd': () => challenge,
    });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(PAGE_TORRENT),
        /desafio Cloudflare/,
      );
      assert.ok(stub.calls.every((c) => !c.url.includes(':8191')), 'o solver nunca é acionado pelo crawl');
    } finally {
      stub.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Cadeia sem magnet: superfície SINTÉTICA (o profile real devolve magnet ou
// erro; o contrato do adaptador tem que segurar o transporte que resolve sem
// magnet — layout/protetor mudou).
// ---------------------------------------------------------------------------

const H1_PAGE = '<html lang="pt-BR"><body><h1>Filme de Teste (2024)</h1>'
  + '<a href="https://www.imdb.com/title/tt1234567/" rel="noopener">7,1</a></body></html>';

const BUTTONS: ResolverLink[] = [
  { url: 'https://systemtech.space/enc/go.php?id=a', quality: 1080, size: '1 GB', audio: 'dual', source: null, episode: null },
  { url: 'https://systemtech.space/enc/go.php?id=b', quality: 720, size: '700 MB', audio: 'dual', source: null, episode: null },
];

interface SurfaceScript {
  follow(url: string): Promise<string>;
  extract(html: string | null | undefined): string | null;
}

function syntheticSurface(script: SurfaceScript): VacaResolverSurface {
  return {
    siteSelector: { url: () => SITE },
    assertAllowedUrl: (value) => new URL(String(value)),
    isDetailHost: (hostname) => hostname === 'vaqueirofilmes.com',
    fetchTextDirect: async () => H1_PAGE,
    extractMovieLinks: () => `${SITE}/movie-links/1/`,
    parseDownloadLinks: () => BUTTONS,
    fetchFollowingAllowed: script.follow,
    extractMagnet: (html) => script.extract(html),
    releaseTitle: (_post, link) => `Filme de Teste (2024) ${link.quality ?? ''} ${link.size ?? ''}`.trim(),
    parseSize: () => null,
  };
}

describe('crawl-sites/vaca: cadeia sem magnet é falha total, nunca done com 0 releases', () => {
  test('todos os botões resolvem sem magnet: erro de layout/protetor, nunca done vazio', async () => {
    const surface = syntheticSurface({
      follow: async () => '<html>cadeia terminou sem magnet</html>',
      extract: () => null,
    });
    await assert.rejects(
      () => createVacaCrawlSite(surface).fetchWork(`${SITE}/pt/movie/filme-teste/`),
      /2 botão\(ões\) anunciados, nenhum magnet \(2 sem magnet, 0 com falha\)/,
    );
  });

  test('falha total mista (erro + sem magnet) também é erro, e o último erro de botão viaja junto', async () => {
    const surface = syntheticSurface({
      follow: async (url) => {
        if (url.includes('id=a')) throw new Error('falha injetada no botão');
        return '<html>cadeia sem magnet</html>';
      },
      extract: () => null,
    });
    await assert.rejects(
      () => createVacaCrawlSite(surface).fetchWork(`${SITE}/pt/movie/filme-teste/`),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /nenhum magnet/);
        assert.match(msg, /1 sem magnet, 1 com falha/, 'os dois lados da falha total contam');
        assert.match(msg, /falha injetada no botão/, 'o erro real do botão segue no motivo');
        return true;
      },
    );
  });

  test('botão individual falho com o outro rendendo release segue done (diferenciação)', async () => {
    const surface = syntheticSurface({
      follow: async (url) => {
        if (url.includes('id=a')) throw new Error('falha só do botão 1');
        return `<a href="magnet:?xt=urn:btih:${ALT_BTIH}&dn=ok">m</a>`;
      },
      extract: (html) => MAGNET_RE.exec(html ?? '')?.[0] ?? null,
    });
    const result = await createVacaCrawlSite(surface).fetchWork(`${SITE}/pt/movie/filme-teste/`);
    assert.equal(result.status, 'done', 'falha de UM botão não derruba a página');
    assert.equal(result.releases?.length, 1);
    assert.match(result.releases![0].magnet || '', new RegExp(ALT_BTIH));
  });
});
