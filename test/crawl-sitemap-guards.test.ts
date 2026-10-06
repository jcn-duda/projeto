import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nerdfilmesCrawlSite } from '../src/providers/crawl-sites/nerdfilmes.js';
import { comandotorrentsCrawlSite } from '../src/providers/crawl-sites/comandotorrents.js';
import { createTorrentdosfilmesCrawlSite } from '../src/providers/crawl-sites/torrentdosfilmes.js';
import { createVacaCrawlSite } from '../src/providers/crawl-sites/vaca.js';
import { createResolver } from '../resolvers/profiles/vacatorrent.js';
import {
  SITE as NERD, site as nerd, withStub as withNerdStub,
} from './helpers/crawl-nerdfilmes-fixtures.js';
import {
  SITE as COMANDO, pageRoutes as comandoRoutes, site as comando,
  withStub as withComandoStub,
} from './helpers/crawl-comandotorrents-fixtures.js';
import {
  SITE as TDF, pageRoutes as tdfRoutes, resolverSurface as tdfSurface,
  withStub as withTdfStub,
} from './helpers/crawl-torrentdosfilmes-fixtures.js';
import {
  stubFetch,
} from './helpers/stub.js';

const VACA = 'https://vaqueirofilmes.com';
const vacaSurface = () => createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: VACA, extraProtectors: [] });

const xmlIndex = (base: string, ...names: string[]) => `<sitemapindex>${names.map((name) =>
  `<sitemap><loc>${base}/${name}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (...rows: Array<[string, string]>) => `<urlset>${rows.map(([loc, date]) =>
  `<url><loc>${loc}</loc><lastmod>${date}</lastmod></url>`).join('')}</urlset>`;
const movieRow = (base: string, slug: string, date = '2026-09-30T00:00:00Z') =>
  [`${base}/${slug}/`, date] as [string, string];
const unknownHtml = '<html><body>Just a moment... <table><tr><td>challenge</td></tr></table></body></html>';

describe('guardas de descoberta em sitemaps WordPress mistos', () => {
  for (const [label, base, factory, withStub] of [
    ['NerdFilmes', NERD, nerd, withNerdStub],
    ['Comando', COMANDO, comando, withComandoStub],
    ['TorrentDosFilmes', TDF, () => createTorrentdosfilmesCrawlSite(tdfSurface()), withTdfStub],
  ] as const) {
    test(`${label}: filho desconhecido bloqueia cursor e mantém URLs parciais; todos desconhecidos falham`, async () => {
      const index = xmlIndex(base, 'post-sitemap.xml', 'post-sitemap2.xml');
      const rows = urlset(movieRow(base, 'filme-novo'),
        ['https://evil.example/obra-alheia/', '2026-09-30T00:00:00Z'])
        .replace('</urlset>', `<url><image:image><image:loc>${base}/imagem-nao-e-obra/</image:loc></image:image></url></urlset>`);
      await withStub({ '/sitemap.xml': () => index, '/sitemap_index.xml': () => index,
        '/post-sitemap.xml': () => rows, '/post-sitemap2.xml': () => unknownHtml }, async () => {
        const result = await factory().discover();
        assert.equal(result.urls.length, 1);
        assert.equal(result.complete, false);
        assert.ok(result.failures.length > 0);
        assert.equal(result.completeByKind?.movie, false);
        assert.equal(result.completeByKind?.tv_show, false, 'fonte mista ilegível bloqueia ambos os kinds');
        assert.equal(result.requestCost, 3, 'índice e os dois arquivos filhos são cobrados mesmo com parcial');
      });
      await withStub({ '/sitemap.xml': () => index, '/sitemap_index.xml': () => index,
        '/post-sitemap.xml': () => unknownHtml, '/post-sitemap2.xml': () => unknownHtml }, async () => {
        await assert.rejects(() => factory().discover(), (err: Error & { requestCost?: number }) => {
          assert.match(err.message, /todos os post-sitemaps falharam/);
          assert.equal(err.requestCost, 3, 'índice e os dois filhos já consumiram três requests');
          return true;
        });
      });
    });
  }

  test('Nerd: CDATA válido, corte sem novidade completo e série isolada fora do gate não falha', async () => {
    const index = xmlIndex(NERD, 'post-sitemap.xml');
    const onlySeries = `<urlset><url><loc><![CDATA[${NERD}/lanternas-1a-temporada-2026/]]></loc>`
      + '<lastmod><![CDATA[2026-09-01T00:00:00Z]]></lastmod></url></urlset>';
    await withNerdStub({ '/sitemap.xml': () => index, '/post-sitemap.xml': () => onlySeries }, async () => {
      const result = await nerd().discover(null, {
        sinceByKind: { movie: null }, series: { enabled: false, maxCards: 10, maxButtons: 40 },
      });
      assert.deepEqual(result.urls, []);
      assert.equal(result.complete, true, 'arquivo válido só de séries está fora do gate sem declarar falha');
    });
    await withNerdStub({ '/sitemap.xml': () => index,
      '/post-sitemap.xml': () => urlset([`${NERD}/filme-antigo/`, '2020-01-01T00:00:00Z']) }, async () => {
      const result = await nerd().discover(null, { sinceByKind: { movie: '2026-01-01T00:00:00Z' } });
      assert.deepEqual(result.urls, []);
      assert.equal(result.complete, true, 'sem novidade não é sitemap vazio/corrompido');
    });
  });

  test('Comando/TDF: XML reconhecido sem novidade é sucesso vazio; série gated não inventa filme', async () => {
    for (const [base, factory, withStub, routes] of [
      [COMANDO, comando, withComandoStub, comandoRoutes()],
      [TDF, () => createTorrentdosfilmesCrawlSite(tdfSurface()), withTdfStub, tdfRoutes()],
    ] as const) {
      const indexPath = base === COMANDO ? '/sitemap.xml' : '/sitemap_index.xml';
      const sitemapPath = '/post-sitemap.xml';
      const index = xmlIndex(base, 'post-sitemap.xml');
      const validSeries = urlset([`${base}/serie-1a-temporada/`, '2026-09-01T00:00:00Z']);
      await withStub({ ...routes, [indexPath]: () => index, [sitemapPath]: () => validSeries }, async () => {
        const result = await factory().discover(null, { sinceByKind: { movie: '2026-10-01T00:00:00Z' } });
        assert.equal(result.complete, true);
        assert.deepEqual(result.urls, [], 'série antiga filtrada por gate/cursor não é falha');
      });
    }
  });
});

test('Vaca: falha apenas do sitemap de filme preserva completude e URLs de série', async () => {
  const index = `<sitemapindex><sitemap><loc>${VACA}/movie-sitemap.xml</loc></sitemap>`
    + `<sitemap><loc>${VACA}/tv_show-sitemap.xml</loc></sitemap></sitemapindex>`;
  const series = urlset([`${VACA}/pt/tv-shows/serie/`, '2026-09-30T00:00:00Z']);
  const stub = stubFetch((url) => {
    const body = url.includes('/sitemap_index.xml') ? index
      : url.includes('/movie-sitemap.xml') ? unknownHtml
        : url.includes('/tv_show-sitemap.xml') ? series : null;
    if (body === null) throw new Error(`fetch fora do mapa (sem rede): ${url}`);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  });
  try {
    const result = await createVacaCrawlSite(vacaSurface()).discover(null, {
      series: { enabled: true, maxCards: 10, maxButtons: 40 },
    });
    assert.equal(result.complete, false);
    assert.equal(result.urls.length, 1);
    assert.equal(result.urls[0].kind, 'tv_show');
    assert.equal(result.completeByKind?.movie, false);
    assert.equal(result.completeByKind?.tv_show, true);
    assert.ok(result.failures.length > 0);
  } finally { stub.restore(); }
  const unknownIndex = `<sitemapindex><sitemap><loc>${VACA}/movie-sitemap.xml</loc></sitemap></sitemapindex>`;
  const unknownStub = stubFetch((url) => {
    const body = url.includes('/sitemap_index.xml') ? unknownIndex
      : url.includes('/movie-sitemap.xml') ? unknownHtml : null;
    if (body === null) throw new Error(`fetch fora do mapa (sem rede): ${url}`);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  });
  try {
    await assert.rejects(() => createVacaCrawlSite(vacaSurface()).discover(), (err: Error & { requestCost?: number }) => {
      assert.match(err.message, /todos os sitemaps falharam/);
      assert.equal(err.requestCost, undefined, 'Vaca mantém o fallback de descoberta sem medição própria');
      return true;
    });
  } finally { unknownStub.restore(); }
});

test('Vaca aceita o viewer HTML conhecido e rejeita HTML desconhecido como falha', async () => {
  const index = `<sitemapindex><sitemap><loc>${VACA}/movie-sitemap.xml</loc></sitemap></sitemapindex>`;
  const viewer = '<table id="sitemap"><thead><tr><th>URL</th><th>Images</th><th>Last Modified</th></tr></thead><tbody>'
    + `<tr><td><a href="${VACA}/pt/movie/maquina-de-guerra/">obra</a></td><td>1</td><td>2026-03-15 01:36 +00:00</td></tr>`
    + '</tbody></table>';
  const stub = stubFetch((url) => {
    const body = url.includes('/sitemap_index.xml') ? index
      : url.includes('/movie-sitemap.xml') ? viewer : null;
    if (!body) throw new Error(`fetch fora do mapa (sem rede): ${url}`);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  });
  try {
    const result = await createVacaCrawlSite(vacaSurface()).discover();
    assert.equal(result.complete, true);
    assert.equal(result.urls.length, 1);
    assert.equal(result.urls[0].url, `${VACA}/pt/movie/maquina-de-guerra/`);
  } finally { stub.restore(); }
});
