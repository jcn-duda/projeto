// A DESCOBERTA DO BLUDV e a REGRA DURA que ela precisa sustentar:
// `urls: []` com `complete: true` NUNCA sai. Essa combinação faz o cursor do
// crawler avançar por cima de um acervo que ninguém leu — 17.860 páginas do
// BLUDV, no pior caso — e ela é silenciosa por definição.
//
// O BLUDV devolve o sitemap em XML CRU do Yoast (medido em 2026-09-29, fetch
// direto sem desafio: `text/xml`, 1.001 linhas no primeiro `post-sitemap`, sem
// CDATA), ao contrário do RedeTorrent, que alterna entre XML e o visualizador do
// Chromium. Ainda assim as TRÊS recusas que fecham a classe de bug continuam
// válidas aqui, e são o que esta suíte fixa:
//
//   1. corpo que o parser não entende (interstitial 200, quebra de layout);
//   2. sitemap lido sem NENHUMA entrada — o arquivo real tem ~1.000;
//   3. entradas que existem, mas nenhuma é página de obra (o `post-sitemap.xml`
//      inclui a home `/` na primeira linha, e um arquivo inteiro reprovado pelo
//      filtro de caminho é a mesma falha sem o nome).
//
// E o `image:loc` do Yoast: a única linha do acervo real com `image:image` traz
// a capa e o botão, e a PÁGINA continua sendo a obra — o `<loc>` da página é o
// primeiro do bloco e a tag do `image` é `<image:loc>`, que não casa `<loc>`.
//
// Fetch dublê: zero rede, zero crawl.db, zero FlareSolverr.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSitemapEntries, parseSitemapIndexLocs } from '../src/providers/crawl-sites/bludv-discovery.js';
import { extraPostSitemap, fixture, pageRoutes, site, withStub, type Route } from './helpers/crawl-bludv-fixtures.js';

const SITE = 'https://bludvfilmes1.xyz';
const isSiteHost = (h: string | null): boolean => h === 'bludvfilmes1.xyz' || h === 'bludvfilmes.xyz';

/** Documento Yoast com as linhas dadas. */
const doc = (...rows: string[]): string =>
  '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  + `${rows.join('')}</urlset>`;
/** Uma linha `<url>` com a data do site (ISO 8601 com fuso, como o Yoast grava). */
const row = (url: string, lastmod: string): string =>
  `<url><loc>${url}</loc><lastmod>${lastmod}</lastmod></url>`;
/** A MESMA linha com CDATA — o site troca de plugin de SEO sem aviso. */
const rowCdata = (url: string, lastmod: string): string =>
  `<url><loc><![CDATA[${url}]]></loc><lastmod><![CDATA[${lastmod}]]></lastmod></url>`;

describe('crawl-sites/bludv: o recorte real do post-sitemap', () => {
  test('1.001 linhas, a PRIMEIRA é a home, e nenhuma é multi-segmento', () => {
    const entries = parseSitemapEntries(fixture('post-sitemap.xml'));
    assert.equal(entries.length, 1001);
    assert.equal(entries[0]?.loc, `${SITE}/`);
    // A forma do acervo inteiro (medido nos 18 arquivos): UM segmento, barra
    // final, sem extensão.
    for (const e of entries.slice(1)) {
      const path = new URL(e.loc).pathname;
      assert.ok(path.endsWith('/'), path);
      assert.equal(path.replace(/^\/|\/$/g, '').includes('/'), false, path);
    }
  });

  test('o `image:loc` (capa e botão) nunca entra como loc da página', () => {
    const entries = parseSitemapEntries(fixture('post-sitemap.xml'));
    assert.equal(entries.some((e) => e.loc.includes('/wp-content/uploads/')), false);
    // A linha que traz `image:image` continua sendo a obra.
    const linha = entries.find((e) => e.loc.includes('espirito-de-lobo'));
    assert.equal(linha?.loc, `${SITE}/espirito-de-lobo-torrent-blu-ray-rip-720p-e-1080p-dublado-2015/`);
  });

  test('CDATA é opcional e `&amp;` é desescapado: o site pode trocar de plugin', () => {
    const comCdata = parseSitemapEntries(doc(rowCdata(`${SITE}/filme-a/`, '2026-01-02T03:04:05+00:00')));
    const semCdata = parseSitemapEntries(doc(row(`${SITE}/filme-a/`, '2026-01-02T03:04:05+00:00')));
    assert.deepEqual(comCdata, semCdata);
    assert.equal(comCdata[0]?.lastmod, '2026-01-02T03:04:05+00:00');
    // `&amp;` numa URL de sitemap é real: desescapar devolve a URL consultável.
    const escapado = parseSitemapEntries(doc(row(`${SITE}/filme-b/?a=1&amp;b=2`, '2026-01-02T03:04:05+00:00')));
    assert.equal(escapado[0]?.loc, `${SITE}/filme-b/?a=1&b=2`);
  });

  test('lastmod ilegível vira vazio, nunca data inventada', () => {
    // `0000-00-00` e data em branco não viram cursor: o motor compara com
    // `Date.parse`, e adivinhar aqui pula acervo.
    const entradas = parseSitemapEntries(doc(
      row(`${SITE}/sem-data/`, '0000-00-00'),
      row(`${SITE}/com-data/`, '2026-03-04T05:06:07+00:00'),
    ));
    assert.equal(entradas[0]?.lastmod, '');
    assert.equal(entradas[1]?.lastmod, '2026-03-04T05:06:07+00:00');
  });
});

describe('crawl-sites/bludv: o índice só vale se renderizar obra', () => {
  test('18 `post-sitemap*` e nenhum de taxonomia (36 das 54 entradas do índice)', () => {
    const locs = parseSitemapIndexLocs(fixture('sitemap-index.xml'), SITE, isSiteHost);
    assert.equal(locs.length, 18);
    assert.equal(locs[0], `${SITE}/post-sitemap.xml`);
    assert.equal(locs[17], `${SITE}/post-sitemap18.xml`);
    assert.ok(locs.every((l) => isSiteHost(new URL(l).hostname)));
  });

  test('host alheio no índice é recusado ANTES de qualquer requisição', () => {
    const xml = doc(`<sitemap><loc>https://filmes-exemplo-spam.test/post-sitemap.xml</loc></sitemap>`)
      .replace('<urlset', '<sitemapindex')
      .replace('</urlset>', '</sitemapindex>');
    assert.deepEqual(parseSitemapIndexLocs(xml, SITE, isSiteHost), []);
  });
});

describe('crawl-sites/bludv: REGRESSÃO — "vazio" é FALHA, nunca descoberta completa', () => {
  const CASOS: { nome: string; rotas: Record<string, Route> }[] = [
    { nome: 'formato desconhecido', rotas: { '/post-sitemap3.xml': () => '<html><body>Just a moment...</body></html>' } },
    { nome: 'XML sem <url>', rotas: { '/post-sitemap3.xml': () => doc() } },
    { nome: 'só a home e taxonomia', rotas: { '/post-sitemap3.xml': () => doc(row(`${SITE}/`, '2026-01-01T00:00:00+00:00'), row(`${SITE}/generos/acao/`, '2026-01-01T00:00:00+00:00')) } },
  ];

  for (const caso of CASOS) {
    test(`${caso.nome}: complete=false e o cursor de filme não anda`, () => withStub(
      pageRoutes(caso.rotas),
      async () => {
        const disc = await site().discover();
        assert.equal(disc.complete, false, caso.nome);
        assert.equal(disc.failures.length, 1, caso.nome);
        assert.match(disc.failures[0] ?? '', /post-sitemap3\.xml/);
        assert.ok(disc.urls.length > 0, 'os outros arquivos ainda rendem URLs');
      },
    ));
  }

  test('o motivo da recusa é distinguível: formato vs. entrada vs. tipo', () => withStub(
    pageRoutes({
      '/post-sitemap3.xml': () => '<html><body>nada a ver</body></html>',
      '/post-sitemap4.xml': () => doc(),
      '/post-sitemap5.xml': () => doc(row(`${SITE}/generos/acao/`, '2026-01-01T00:00:00+00:00')),
    }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false);
      const motivos = disc.failures.join(' | ');
      assert.match(motivos, /formato de sitemap não reconhecido/);
      assert.match(motivos, /sem nenhuma entrada/);
      assert.match(motivos, /sem URL de obra/);
    },
  ));

  test('formato desconhecido em TODOS os arquivos é erro, não rodada vazia', () => withStub(
    pageRoutes(Object.fromEntries(
      Array.from({ length: 18 }, (_, i) => {
        const n = i + 1;
        const nome = n === 1 ? '/post-sitemap.xml' : `/post-sitemap${n}.xml`;
        return [nome, () => '<html><body>Just a moment...</body></html>'] as [string, Route];
      }),
    )),
    async () => assert.rejects(() => site().discover(), /todos os post-sitemaps falharam/),
  ));

  test('NUNCA sai `urls: []` com `complete: true` (invariante de rodapé)', async () => {
    for (const caso of CASOS) {
      const disc = await withStub(pageRoutes(caso.rotas), async () => site().discover());
      assert.equal(disc.complete, false, caso.nome);
      assert.ok(disc.urls.length > 0 || disc.failures.length > 0, caso.nome);
    }
  });

  test('o `requestCost` é o REAL mesmo com arquivo falhando (o teto por hora cobra o gasto)', () => withStub(
    pageRoutes({ '/post-sitemap3.xml': () => { throw new Error('http_500'); } }),
    async () => {
      const disc = await site().discover();
      // índice + 18 arquivos: o que falhou foi gasto, e o teto por hora o cobra.
      assert.equal(disc.requestCost, 19);
    },
  ));
});

describe('crawl-sites/bludv: o arquivo sintético dos arquivos 2..18', () => {
  test('cada um declara UMA obra de teste, com data — nunca vazio', () => {
    // Se um deles respondesse vazio, a descoberta o trataria como FALHA (a
    // situação real que a classe de bug produce) e o teste inteiro quebraria.
    const entradas = parseSitemapEntries(extraPostSitemap(2));
    assert.equal(entradas.length, 1);
    assert.equal(entradas[0]?.loc, `${SITE}/exemplo-sitemap-2-torrent-dublado-2012/`);
    assert.ok(Date.parse(entradas[0]?.lastmod ?? '') > 0);
  });
});
