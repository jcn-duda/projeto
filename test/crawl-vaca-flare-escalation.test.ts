// Crawl do Vaca atrás do Cloudflare (domínio vaqueirofilmes1.com): o fetch DIRETO
// frio é desafiado (403) e antes isso virava error-streak e pausa do site.
// `fetchTextCrawl` escalona ao FlareSolverr SÓ com desafio, conta a resolução no
// custo da página e deixa a sessão memorizada para o próximo fetch ir direto.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createResolver } from '../resolvers/profiles/vacatorrent.js';
import { crawlFetch } from '../src/providers/crawl-sites/vaca-fetch.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import { stubFetch } from './helpers/stub.js';

const SITE = 'https://vaqueirofilmes1.com';
const WORK = `${SITE}/pt/movie/expresso-do-amanha/`;
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/turnstile"></script>cf-chl</body></html>';
const REAL = '<html><body><h1>Expresso do Amanhã</h1></body></html>';

function surface(): VacaResolverSurface & { fetchTextCrawl: NonNullable<VacaResolverSurface['fetchTextCrawl']> } {
  return createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: SITE, extraProtectors: [] }) as any;
}

function cfStub(state: { flareCalls: number; directCalls: number }, solved: () => boolean) {
  return stubFetch((url) => {
    if (url.includes('/v1')) {
      state.flareCalls += 1;
      return {
        ok: true, status: 200,
        json: async () => ({ status: 'ok', solution: { status: 200, url: WORK, response: REAL, cookies: [{ name: 'cf_clearance', value: 'x' }], userAgent: 'UA' } }),
      };
    }
    state.directCalls += 1;
    const ok = solved();
    return {
      ok, status: ok ? 200 : 403,
      headers: { get: (n: string) => (n.toLowerCase() === 'cf-mitigated' && !ok ? 'challenge' : null) },
      text: async () => (ok ? REAL : CHALLENGE),
    };
  });
}

describe('fetchTextCrawl: direto → Flare só com desafio', () => {
  test('desafio no direto → resolve pelo Flare, conta 1 requisição a mais e devolve o HTML', async () => {
    const state = { flareCalls: 0, directCalls: 0 };
    const stub = cfStub(state, () => false);
    try {
      let hops = 0;
      const html = await surface().fetchTextCrawl(WORK, undefined, { onRequest: () => { hops += 1; } });
      assert.match(html, /Expresso do Amanh/);
      assert.equal(state.flareCalls, 1, 'uma resolução pelo FlareSolverr');
      assert.equal(hops, 2, 'o salto direto + a resolução entram no custo da página');
    } finally {
      stub.restore();
    }
  });

  test('sem desafio → NÃO aciona o Flare', async () => {
    const state = { flareCalls: 0, directCalls: 0 };
    const stub = cfStub(state, () => true);
    try {
      const html = await surface().fetchTextCrawl(WORK);
      assert.match(html, /Expresso do Amanh/);
      assert.equal(state.flareCalls, 0);
    } finally {
      stub.restore();
    }
  });

  test('Flare que devolve o desafio de novo → erro (pausa do motor), sem laço', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/v1')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', solution: { status: 200, url: WORK, response: CHALLENGE, cookies: [], userAgent: 'UA' } }) };
      }
      return { ok: false, status: 403, headers: { get: () => 'challenge' }, text: async () => CHALLENGE };
    });
    try {
      await assert.rejects(() => surface().fetchTextCrawl(WORK), /desafio Cloudflare não resolvido/);
    } finally {
      stub.restore();
    }
  });

  test('erro que não é desafio (HTTP 500) sobe sem tocar no Flare', async () => {
    let flare = 0;
    const stub = stubFetch((url) => {
      if (url.includes('/v1')) { flare += 1; return { ok: true, status: 200, json: async () => ({}) }; }
      return { ok: false, status: 500, headers: { get: () => null }, text: async () => 'erro' };
    });
    try {
      await assert.rejects(() => surface().fetchTextCrawl(WORK), /http_500/);
      assert.equal(flare, 0);
    } finally {
      stub.restore();
    }
  });
});

describe('crawlFetch (adaptador)', () => {
  test('prefere fetchTextCrawl e cai no fetchTextDirect quando o profile não o tem', async () => {
    const calls: string[] = [];
    const base = { fetchTextDirect: async () => { calls.push('direct'); return 'd'; } } as unknown as VacaResolverSurface;
    assert.equal(await crawlFetch(base, WORK), 'd');
    const withCrawl = { ...base, fetchTextCrawl: async () => { calls.push('crawl'); return 'c'; } } as VacaResolverSurface;
    assert.equal(await crawlFetch(withCrawl, WORK), 'c');
    assert.deepEqual(calls, ['direct', 'crawl']);
  });
});

describe('sitemap do Yoast no formato viewer (HTML renderizado pelo Flare)', () => {
  const VIEWER = '<table id="sitemap"><thead><tr><th>URL</th><th>Images</th><th>Last Modified</th></tr></thead><tbody>'
    + `<tr><td><a href="${SITE}/movie/">${SITE}/movie/</a></td><td>0</td><td>2026-10-01 16:05 +00:00</td></tr>`
    + `<tr><td><a href="${SITE}/pt/movie/maquina-de-guerra/">${SITE}/pt/movie/maquina-de-guerra/</a></td><td>1</td><td>2026-03-15 01:36 +00:00</td></tr>`
    + `<tr><td><a href="${SITE}/movie-sitemap2.xml">${SITE}/movie-sitemap2.xml</a></td><td>2026-07-07 21:14 +00:00</td></tr>`
    + '</tbody></table>';

  test('lê loc e lastmod das linhas (com e sem coluna de imagens)', async () => {
    const { parseViewerEntries } = await import('../src/providers/crawl-sites/vaca-sitemap-viewer.js');
    assert.deepEqual(parseViewerEntries(VIEWER), [
      { loc: `${SITE}/movie/`, lastmod: '2026-10-01T16:05:00+00:00' },
      { loc: `${SITE}/pt/movie/maquina-de-guerra/`, lastmod: '2026-03-15T01:36:00+00:00' },
      { loc: `${SITE}/movie-sitemap2.xml`, lastmod: '2026-07-07T21:14:00+00:00' },
    ]);
    assert.deepEqual(parseViewerEntries('<html>nada</html>'), []);
  });
});
