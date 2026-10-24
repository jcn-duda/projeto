// O SITEMAP DO REDETORRENT CHEGA EM DOIS FORMATOS — e o bug que esta suíte
// fecha é o parser que só sabia ler um deles.
//
// Medido em 2026-09-29 no site real, chamadas em sequência no MESMO endpoint
// (FlareSolverr em 127.0.0.1:8191):
//   FORMATO A: XML CRU do AIOSEO, `<loc>`/`<lastmod>` em CDATA, `lastmod` em ISO
//     8601 de verdade (`2026-09-28T19:32:39+00:00`) — `/movies-sitemap.xml`
//     devolveu `XML/308220` em 4 chamadas seguidas;
//   FORMATO B: HTML RENDERIZADO, o VISUALIZADOR XML do Chromium (o XSL
//     `default-sitemap.xsl` aplicado): tabela HTML e NENHUM `<loc>` — a 1ª
//     renderização de uma sessão fria pagou o XSL e devolveu `HTML/390513`, e
//     `/sitemap.xml` alternou `HTML/32311` → `XML/15337` nas três seguintes.
// Nenhuma das duas respostas é challenge do Cloudflare nem truncada: são as duas
// legítimas, e a PRIMEIRA renderização paga o XSL só uma vez por sessão.
//
// O sintoma do parser de formato único: `discover()` devolvia
// `{ urls: [], complete: true, failures: [], requestCost: 8 }` — zero URL com
// descoberta declarada COMPLETA, que é a combinação que faz o cursor do crawler
// avançar por cima de 6.737 páginas de filme e 705 de série nunca lidas. E é
// INTERMITENTE, que é a pior classe: uma rodada descobre 6.737 e a próxima 0.
//
// O que esta suíte prova, obrigatoriamente:
//   1. o MESMO endpoint nos dois formatos devolve a MESMA descoberta (o objeto
//      inteiro, não só a contagem);
//   2. o `lastmod` sai em ISO nos dois caminhos;
//   3. formato desconhecido, tabela/`<urlset>` sem entrada e arquivo sem URL do
//      tipo que ele alimenta são FALHA — nunca `urls: []` com `complete: true`.
//
// Fetch dublê: zero rede, zero crawl.db, zero FlareSolverr. A leitura da página
// e a amostra de temporada moram em `crawl-redetorrent.test.ts` e
// `crawl-redetorrent-series.test.ts`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSitemapIndexLocs, parseSitemapRows, sitemapShape,
} from '../src/providers/crawl-sites/redetorrent-discovery.js';
import type { Route } from './helpers/crawl-redetorrent-fixtures.js';
import {
  SITE, extraSlugs, fixture, pageRoutes, pageRoutesXml, site, viewerDoc, viewerRow, withStub, xmlDoc, xmlRow,
} from './helpers/crawl-redetorrent-fixtures.js';

const slugsOf = (urls: { url: string }[]): string[] =>
  urls.map((u) => new URL(u.url).pathname.replace(/^\/|\/$/g, ''));
/** Só o host do site é aceito (dublê do `isDetailHost` do profile). */
const isSiteHost = (h: string | null): boolean => h === 'www.redetorrent.xyz' || h === 'redetorrent.com';

describe('crawl-sites/redetorrent: o formato da resposta', () => {
  test('é detectado pelo conteúdo — o status 200 é o mesmo nos dois', () => {
    assert.equal(sitemapShape(fixture('sitemap-index-cdata.xml')), 'xml');
    assert.equal(sitemapShape(fixture('movies-sitemap-cdata.xml')), 'xml');
    assert.equal(sitemapShape(fixture('sitemap-index.html')), 'viewer');
    assert.equal(sitemapShape(fixture('movies-sitemap.html')), 'viewer');
    // 200 com HTML que não é sitemap: precisa ser RECONHECIDO como tal, senão
    // volta lista vazia e o motor acha que leu o acervo inteiro.
    assert.equal(sitemapShape(fixture('formato-desconhecido.html')), 'unknown');
    assert.equal(sitemapShape(''), 'unknown');
  });

  test('comentário que NOMEIA a tag do outro formato não vira o outro formato', () => {
    // O cabeçalho de uma resposta real (e o das fixtures) descreve o formato
    // que NÃO é o dela: `… zero <loc> …`. Se a detecção lesse o comentário, a
    // tabela do visualizador seria classificada como XML e vice-versa.
    const comComentario = '<!-- nesta resposta não há <loc> nenhum -->\n' + viewerDoc(
      viewerRow(`${SITE}/filmes/coringa/`, '2 de March de 2025', '10:05'),
    );
    assert.equal(sitemapShape(comComentario), 'viewer');
    assert.deepEqual(slugsOf(parseSitemapRows(comComentario)), ['filmes/coringa']);
  });
});

describe('crawl-sites/redetorrent: os DOIS formatos entregam a mesma coisa', () => {
  test('CONTRATO CENTRAL: as linhas são idênticas (URL, ordem e lastmod)', () => {
    // `movies-sitemap-cdata.xml` e `movies-sitemap.html` são o MESMO sitemap do
    // mesmo site, cada um no formato que a rota entregou naquela chamada.
    const fromXml = parseSitemapRows(fixture('movies-sitemap-cdata.xml'));
    const fromViewer = parseSitemapRows(fixture('movies-sitemap.html'));
    assert.deepEqual(fromXml, fromViewer);
    assert.equal(fromXml.length, 11, '11 locs, dos quais 5 são de obra');
  });

  test('o `lastmod` sai em ISO nos DOIS caminhos: do XML do site e da tabela', () => {
    const fromXml = parseSitemapRows(fixture('movies-sitemap-cdata.xml'));
    const fromViewer = parseSitemapRows(fixture('movies-sitemap.html'));
    assert.equal(fromXml[0]?.url, `${SITE}/filmes/coringa-delirio-a-dois/`);
    // O site escreve ISO com fuso; o caminho XML canonicaliza em UTC `Z`, que
    // é o mesmo formato que o caminho da tabela produz — daí a igualdade byte a
    // byte acima, e daí o cursor comparar as duas rotas pela mesma semântica.
    assert.equal(fromXml[0]?.lastmod, '2026-02-06T14:22:00Z');
    assert.equal(fromViewer[0]?.lastmod, '2026-02-06T14:22:00Z');
    for (const linha of [...fromXml, ...fromViewer]) {
      assert.ok(linha.lastmod === '' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(linha.lastmod), linha.lastmod);
    }
  });

  test('CDATA é opcional, `<image:loc>` não é loc, e data ilegível não vira data', () => {
    const rows = parseSitemapRows(fixture('movies-sitemap-cdata.xml'));
    const urls = rows.map((r) => r.url);
    // Sem CDATA (duas linhas da fixture) a linha é lida igual — o site troca de
    // plugin de SEO sem aviso, e o parser não pode quebrar no dia da troca…
    assert.ok(urls.includes(`${SITE}/filmes/`));
    // …o `<image:loc>` do AIOSEO (a capa do post) nunca entra como loc da
    // página, e a linha continua sendo a obra…
    assert.ok(!urls.some((u) => u.includes('/wp-content/uploads/')), 'capa não é página');
    // …e `0000-00-00` / `<lastmod>` vazio continuam vazios, com a URL entrando.
    assert.equal(rows.find((r) => r.url === `${SITE}/filmes/injustice/`)?.lastmod, '');
    assert.equal(rows.find((r) => r.url === `${SITE}/filmes/lego-batman-o-filme/`)?.lastmod, '');
  });

  test('resposta MISTA (os dois formatos no mesmo corpo) deduplica e fica com o lastmod maior', () => {
    const url = `${SITE}/filmes/coringa/`;
    // O site renderiza a data como "16 de September de 2026": locale inglês com
    // o "de" português no meio. A forma tradutível ("of 2026") NÃO é a medida e
    // volta vazio — data ilegível é data ausente, nunca data inventada.
    const misto = xmlDoc(xmlRow(url, '2025-03-02T10:05:00+00:00'))
      + viewerDoc(viewerRow(url, '2 de March de 2025', '10:05'), viewerRow(url, '16 de September de 2026', '17:56'));
    const rows = parseSitemapRows(misto);
    assert.equal(rows.length, 1, 'a mesma URL nos dois formatos é uma linha só');
    // Data antiga aqui é o acervo inteiro daquela linha sendo cortado pelo
    // cursor do motor — sobrevive a maior.
    assert.equal(rows[0]?.lastmod, '2026-09-16T17:56:00Z');
  });

  test('o índice entrega os mesmos 8 sitemaps de obra nos dois formatos', () => {
    const esperado = [
      '/movies-sitemap.xml', '/movies-sitemap2.xml', '/movies-sitemap3.xml', '/movies-sitemap4.xml',
      '/movies-sitemap5.xml', '/movies-sitemap6.xml', '/movies-sitemap7.xml', '/tvshows-sitemap.xml',
    ];
    for (const nome of ['sitemap-index-cdata.xml', 'sitemap-index.html']) {
      const locs = parseSitemapIndexLocs(fixture(nome), SITE, isSiteHost);
      assert.deepEqual(locs.map((l) => new URL(l).pathname), esperado, nome);
      assert.ok(locs.every((l) => l.startsWith(SITE)), 'nenhum host alheio sobrevive');
    }
  });
});

describe('crawl-sites/redetorrent: discover nos dois formatos (regressão do 0 silencioso)', () => {
  test('o MESMO acervo em FORMATO A e em FORMATO B produz a MESMA descoberta', async () => {
    const emXml = await withStub(pageRoutesXml(), async () => site().discover());
    const emTabela = await withStub(pageRoutes(), async () => site().discover());
    // Igualdade do objeto INTEIRO: mesmas URLs, mesmo lastmod, mesmo `complete`,
    // mesmo custo. O formato da resposta não pode aparecer no resultado.
    assert.deepEqual(emXml, emTabela);
    assert.equal(emXml.urls.length, 11);
    assert.equal(emXml.complete, true);
    assert.equal(emXml.requestCost, 8);
    assert.deepEqual(slugsOf(emXml.urls).slice(0, 5), [
      'filmes/coringa-delirio-a-dois', 'filmes/coringa', 'filmes/batman-a-mascara-do-fantasma',
      'filmes/injustice', 'filmes/lego-batman-o-filme',
    ]);
    assert.deepEqual(slugsOf(emXml.urls).slice(5), extraSlugs());
  });

  test('XML cru com CDATA: 5 obras do primeiro arquivo, com o lastmod do site', async () => {
    const disc = await withStub(pageRoutesXml(), async () => site().discover());
    const primeira = disc.urls[0];
    assert.equal(primeira?.lastmod, '2026-02-06T14:22:00Z', 'ISO do site, canonicalizado em UTC');
    assert.equal(disc.urls.find((u) => u.url.endsWith('/filmes/injustice/'))?.lastmod, '');
    assert.deepEqual(disc.failures, []);
  });

  test('REGRESSÃO: formato desconhecido é FALHA, nunca `urls: []` com `complete: true`', () => withStub(
    // Um arquivo responde 200 com HTML que não é sitemap. Antes, isso virava
    // "vazio" e a rodada fechava `complete: true` por cima de um acervo que
    // ninguém leu.
    pageRoutes({ '/movies-sitemap.xml': () => fixture('formato-desconhecido.html') }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false, 'descoberta parcial: o cursor de filme não anda');
      assert.equal(disc.failures.length, 1);
      assert.match(disc.failures[0] ?? '', /movies-sitemap\.xml/);
      assert.match(disc.failures[0] ?? '', /formato de sitemap não reconhecido/);
      assert.deepEqual(disc.completeByKind, { movie: false, tv_show: true });
      assert.ok(disc.urls.length > 0, 'os outros arquivos ainda rendem URLs');
    },
  ));

  test('REGRESSÃO: sitemap lido sem NENHUMA entrada também é falha', () => withStub(
    // `<urlset>` sem nenhum `<url>`: o formato É reconhecido e o arquivo é o do
    // acervo (1.000 linhas em produção), então é resposta lida e vazia — que é
    // falha, não "o site não tem filme".
    pageRoutes({ '/movies-sitemap2.xml': () => xmlDoc() }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false);
      assert.match(disc.failures[0] ?? '', /sem nenhuma entrada/);
      assert.deepEqual(disc.completeByKind, { movie: false, tv_show: true });
    },
  ));

  test('a tabela do visualizador sem linha nenhuma também é falha', () => withStub(
    // Tabela vazia não tem `<td class="left">` — é indistinguível de um HTML que
    // não é sitemap e cai no mesmo ramo. O que importa é o desfecho: falha com
    // o cursor de filme travado.
    pageRoutes({ '/movies-sitemap2.xml': () => fixture('movies-sitemap-vazio.html') }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false);
      assert.match(disc.failures[0] ?? '', /movies-sitemap2\.xml/);
      assert.deepEqual(disc.completeByKind, { movie: false, tv_show: true });
      assert.ok(disc.urls.length > 0, 'os outros arquivos ainda rendem URLs');
    },
  ));

  test('entradas que existem mas nenhuma é do tipo do arquivo é falha do tipo', () => withStub(
    // `movies-sitemap2.xml` respondeu com linhas de `/series/`: o arquivo que
    // alimenta o cursor de filme não produziu nenhum filme. Declarar isso
    // completo é o cursor pulando 6.000 páginas.
    pageRoutes({ '/movies-sitemap2.xml': () => xmlDoc(xmlRow(`${SITE}/series/fallout/`, '2026-09-16T17:55:00+00:00')) }),
    async () => {
      const disc = await site().discover();
      assert.equal(disc.complete, false);
      assert.match(disc.failures[0] ?? '', /sem URL de movie/);
      assert.deepEqual(disc.completeByKind, { movie: false, tv_show: true });
    },
  ));

  test('formato desconhecido em TODOS os arquivos é erro, não rodada vazia', () => withStub(
    pageRoutes(Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => {
        const n = i + 1;
        return [`/movies-sitemap${n === 1 ? '' : n}.xml`, () => fixture('formato-desconhecido.html')];
      }),
    )),
    async () => assert.rejects(() => site().discover(), /todos os sitemaps de obra falharam/),
  ));

  test('índice em formato desconhecido nos dois nomes é erro de descoberta', () => withStub(
    pageRoutes({
      '/sitemap.xml': () => fixture('formato-desconhecido.html'),
      '/sitemap_index.xml': () => fixture('formato-desconhecido.html'),
    }),
    async () => assert.rejects(() => site().discover(), /formato de sitemap não reconhecido/),
  ));

  test('índice só com sitemap de série e séries desligadas é erro (não há fonte de filme)', () => withStub(
    pageRoutes({
      '/sitemap.xml': () => xmlDoc(xmlRow(`${SITE}/tvshows-sitemap.xml`, '2026-09-16T17:55:00+00:00')),
      '/sitemap_index.xml': () => xmlDoc(xmlRow(`${SITE}/tvshows-sitemap.xml`, '2026-09-16T17:55:00+00:00')),
    }),
    async () => assert.rejects(() => site().discover(), /só tem sitemap de série/),
  ));

  test('NUNCA sai `urls: []` com `complete: true` (invariante de rodapé)', async () => {
    // Varredura de todos os caminhos de "não deu URL": cada um tem de chegar
    // como falha explícita, e nenhum deles como rodada vazia bem-sucedida.
    const casos: { nome: string; rotas: Record<string, Route> }[] = [
      { nome: 'formato desconhecido', rotas: { '/movies-sitemap.xml': () => fixture('formato-desconhecido.html') } },
      { nome: 'tabela vazia', rotas: { '/movies-sitemap.xml': () => fixture('movies-sitemap-vazio.html') } },
      { nome: 'XML sem url', rotas: { '/movies-sitemap.xml': () => xmlDoc() } },
      { nome: 'só de série no arquivo de filme', rotas: { '/movies-sitemap.xml': () => xmlDoc(xmlRow(`${SITE}/series/fallout/`, '2026-09-16T17:55:00+00:00')) } },
      { nome: 'nada de obra', rotas: { '/movies-sitemap.xml': () => xmlDoc(xmlRow(`${SITE}/genero/acao/`, '2026-09-16T17:49:00+00:00')) } },
    ];
    for (const caso of casos) {
      const disc = await withStub(pageRoutes(caso.rotas), async () => site().discover());
      assert.equal(disc.complete, false, caso.nome);
      assert.ok(disc.urls.length > 0 || disc.failures.length > 0, caso.nome);
    }
  });
});
