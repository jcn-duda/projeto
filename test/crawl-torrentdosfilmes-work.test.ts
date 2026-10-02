// `fetchWork` do adaptador TorrentDosFilmes V2 contra os POSTS REAIS capturados
// em 2026-09-28 (sem rede). Suíte irmã de `crawl-torrentdosfilmes.test.ts`
// (que cobre a régua de título e o `discover`) — a divisão é de tamanho, e os
// dublês são os mesmos, definidos uma vez em
// `helpers/crawl-torrentdosfilmes-fixtures.ts`.
//
// O que esta suíte fixa, e por quê:
//
//   - o magnet é DIRETO no post (sem salto de protetor), então o custo real de
//     uma página de filme é 1 request e 3 âncoras viram 2 releases (o site
//     repete o botão do mesmo torrent);
//   - o `imdb` é SEMPRE null, e o fixture do filme tem o link do plugin de
//     recomendação na página — a prova de que ler aquele tt gravaria a obra
//     ERRADA no acervo;
//   - o portão de série: pack recusado como filme, `tv_show` recusado fora do
//     modo amostra, e o modo amostra lendo o pack com os denominadores da
//     sonda (sem `groups`, porque o botão não traz episódio);
//   - o título da release é o MESMO do card vivo, porque quem limpa é o
//     `releaseTitle` do profile, com o `<h1>` cru.
//
// O resolver é o PROFILE REAL (createResolver do torrentdosfilmes) com fetch
// dublê por baixo. Nada grava banco de magnets e nada liga o crawler.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { torrentdosfilmesCrawlSite } from '../src/providers/crawl-sites/torrentdosfilmes.js';
import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import {
  HOME,
  MOVIE,
  MOVIE_BTIH_BASE32,
  MOVIE_BTIH_HEX,
  SERIES,
  SERIES_BTIH,
  fixture,
  pageRoutes,
  pathsOf,
  probeSite,
  seriesRoutes,
  site,
  withStub,
} from './helpers/crawl-torrentdosfilmes-fixtures.js';

const h1 = (text: string): string => `<!DOCTYPE html><html><body><h1>${text}</h1></body></html>`;

describe('crawl-sites/torrentdosfilmes: fetchWork de filme (post real, sem rede)', () => {
  test('post de filme: 2 releases (3 botões, 2 hashes), custo 1 request', () => withStub(pageRoutes(), async (stub) => {
    const result = await site().fetchWork(MOVIE);
    assert.equal(result.status, 'done');
    assert.equal(result.title, 'Como Viajar com o Mala do seu Pai', 'nome vem do h1 com o ano no meio');
    assert.equal(result.year, 2008);
    assert.equal(result.type, 'movie');
    // O ÚNICO `imdb.com/title/` da página é o do plugin de recomendação, que
    // aponta para "Refém (2005)" (o alt da imagem confirma) numa página de
    // "Como Viajar com o Mala do seu Pai (2008)". Ler esse tt gravaria a obra
    // ERRADA no acervo: é a prova de que aqui `imdb` é sempre null.
    assert.equal(result.imdb, null, 'o IMDb da página é do widget de recomendação, não da obra');
    const releases = result.releases ?? [];
    assert.equal(releases.length, 2, '3 âncoras de magnet, 2 btih — o repetido é um item só');
    assert.deepEqual(
      releases.map((r) => r.magnet?.match(/xt=urn:btih:([A-Za-z0-9]{32,40})/)?.[1]),
      [MOVIE_BTIH_HEX, MOVIE_BTIH_BASE32],
      'os dois hashes reais, na ordem da página, 40 hex e 32 base32',
    );
    assert.equal(releases[0].indexer, 'torrentdosfilmesv2', 'id do CARD (não o nome do profile)');
    assert.equal(releases[0].tracker, 'TorrentDosFilmes');
    assert.equal(releases[0].isBr, true, 'invariante 2: origem BR é campo do provider');
    assert.equal(releases[0].seeders, 1, 'invariante 3: fonte BR não publica swarm');
    // F3: o magnet é DIRETO no post, então o custo real é só a página — é o que
    // separa este site (1 request/página) do NerdFilmes (página + 1 por botão).
    assert.equal(result.requestCost, 1);
    assert.deepEqual(pathsOf(stub), [new URL(MOVIE).pathname], 'só o post: nenhum salto de protetor');
  }));

  test('título da release é o MESMO do card vivo (régua do profile, não do crawl)', () => withStub(pageRoutes(), async () => {
    // O que está aqui é literalmente o que o `releaseTitle` do PROFILE produz
    // com o `<h1>` cru e o botão real — a string que o torznab (`/api`) deste
    // site já devolve hoje, incluindo o resíduo "GDRIVE" que o cleaner do
    // profile não conhece. Fixar a string inteira é o que impede uma segunda
    // limpeza no adaptador de criar uma terceira régua de título: a etiqueta
    // de qualidade/áudio vem do CONTEXTO do botão (`[1080p BLURAY DUBLADO]`),
    // que é o que o filtro de qualidade e de áudio do addon lê.
    const releases = (await site().fetchWork(MOVIE)).releases ?? [];
    assert.equal(
      releases[0].title,
      'Como Viajar com o Mala do seu Pai (2008) BluRay – /GDRIVE [1080p BLURAY DUBLADO]',
    );
    assert.equal(
      releases[1].title,
      'Como Viajar com o Mala do seu Pai (2008) BluRay – /GDRIVE [DUBLADO]',
      'o 2º botão é o mesmo torrent sem metadado de qualidade: entra como release própria',
    );
  }));

  test('post sem botão → no-torrent sem gastar rede de protetor', () => withStub(
    pageRoutes({ [MOVIE]: () => h1('Algum Filme (2010) Dublado 720p') }),
    async (stub) => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'no-torrent');
      assert.equal(result.title, 'Algum Filme');
      assert.equal(result.year, 2010);
      assert.equal(result.requestCost, 1, 'só a página');
      assert.equal(stub.calls.length, 1, 'nenhum botão procurado');
    },
  ));

  test('link de protetor terminal → no-torrent, sem retry eterno', () => withStub(
    // O caminho comum do site não usa protetor, mas a allowlist do profile
    // aceita host de protetor e um post pode trazê-lo: o `http_400` com o texto
    // do protetor é terminal pelo nome do erro do transporte.
    pageRoutes({
      [MOVIE]: () => `${h1('Algum Filme (2010) Dublado 720p')}<a href="https://systemads1.com/abc">download</a>`,
      'systemads1.com': () => ({ status: 400, body: 'Link inválido ou expirado' }),
    }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'no-torrent', 'terminal: não há torrent a colher');
      assert.equal(result.requestCost, 2, 'a página + o salto do botão');
    },
  ));

  test('rede caída no botão continua RETENTÁVEL (erro com o custo já gasto)', () => withStub(
    pageRoutes({
      [MOVIE]: () => `${h1('Algum Filme (2010) Dublado 720p')}<a href="https://systemads1.com/abc">download</a>`,
      'systemads1.com': () => { throw new Error('timeout injetado'); },
    }),
    async () => assert.rejects(() => site().fetchWork(MOVIE), (err: Error & { requestCost?: number }) => {
      assert.match(err.message, /timeout injetado/);
      // F1: o throw carrega o que foi gasto — o motor cobra 2, não 1.
      assert.equal(err.requestCost, 2);
      return true;
    }),
  ));

  test('página de temporada (pack) pedida como FILME é recusada antes de qualquer rede', () => withStub(
    seriesRoutes(),
    async (stub) => {
      // Gravar o pack como filme é obra que não existe no catálogo: o `dn=` do
      // magnet medido é "O_Caçador.S01Complete".
      const result = await site().fetchWork(SERIES);
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /temporada_com_kind_movie/);
      assert.equal(stub.calls.length, 0, 'recusa na porta, antes do fetch');
      const explicito = await site().fetchWork(SERIES, { kind: 'movie' });
      assert.equal(explicito.status, 'error');
      assert.equal(stub.calls.length, 0);
    },
  ));

  test('kind tv_show com séries DESLIGADAS é erro explícito, com zero rede', () => withStub(seriesRoutes(), async (stub) => {
    const result = await site().fetchWork(SERIES, { kind: 'tv_show', series: { enabled: false, maxCards: 10, maxButtons: 40 } });
    assert.equal(result.status, 'error');
    assert.match(String(result.error), /fora do motor/);
    assert.equal(stub.calls.length, 0, 'o portão responde antes do fetch');
  }));

  test('kind tv_show com séries LIGADAS: o pack nasce na temporada, nunca na raiz', () => withStub(seriesRoutes(), async () => {
    const result = await site().fetchWork(SERIES, { kind: 'tv_show', series: { enabled: true, maxCards: 10, maxButtons: 40 } });
    assert.equal(result.status, 'done');
    assert.equal(result.season, 1);
    // `dn=O_Caçador.S01Complete`: o pack cobre a temporada 1 inteira.
    assert.deepEqual(result.groups?.map((g) => [g.season, g.episode]), [[1, null]]);
  }));

  test('modo amostra: o pack é lido e reporta os denominadores da sonda', () => withStub(seriesRoutes(), async (stub) => {
    const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
    assert.equal(result.status, 'done');
    assert.equal(result.type, 'series');
    assert.equal(result.title, 'O Caçador', 'a página identifica a série, não o pack');
    assert.equal(result.year, 2014);
    assert.equal(result.imdb, null);
    const sample = result as { buttons?: number; buttonsFollowed?: number; releases?: unknown[] };
    assert.equal(sample.buttons, 1, 'botões anunciados (o denominador da taxa de magnet)');
    assert.equal(sample.buttonsFollowed, 1);
    assert.equal(sample.releases?.length, 1);
    assert.equal(result.requestCost, 1, 'magnet direto: só a página');
    assert.equal(stub.calls.length, 1);
    const releases = result.releases ?? [];
    // O magnet sai com a CAIXA que o site publicou (o base32 vem em maiúscula);
    // é o `magnetHash` que minúscula para o dedupe, não a URI entregue.
    assert.equal(releases[0].magnet?.match(/xt=urn:btih:([A-Za-z0-9]{32,40})/)?.[1], SERIES_BTIH);
    assert.match(String(releases[0].magnet), /dn=O_Ca%C3%A7ador\.S01Comp/, 'o magnet REAL é o pack da temporada');
    // O `dn` do pack declara a temporada: grupo S1 inteiro (nunca a raiz).
    assert.deepEqual(result.groups?.map((g) => [g.season, g.episode]), [[1, null]]);
  }));

  test('teto de botões da amostra corta o pack, sem estourar o orçamento', () => withStub(seriesRoutes(), async () => {
    const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show', series: { enabled: true, maxCards: 10, maxButtons: 1 } });
    assert.equal((result as { buttons?: number }).buttons, 1);
    assert.equal(result.status, 'done');
  }));

  test('página sem h1 é quebra de layout, não obra sem nome', () => withStub(
    pageRoutes({ [MOVIE]: () => '<!DOCTYPE html><html><body><div>sem título nenhum</div></body></html>' }),
    async () => {
      const result = await site().fetchWork(MOVIE);
      assert.equal(result.status, 'error');
      assert.match(String(result.error), /sem <h1>/);
    },
  ));

  test('host safety: página de fora do site é rejeitada na porta', () => withStub(pageRoutes(), async (stub) => {
    for (const url of ['http://169.254.169.254/x/', 'https://evil.example/x/', 'http://torrentdosfilmes-v2.xyz.evil.example/x/']) {
      await assert.rejects(() => site().fetchWork(url), /blocked_host/);
    }
    // A home é a PRIMEIRA entrada do sitemap do site: se a fila a trouxesse,
    // ela devolveria a página inicial com <h1> e viraria obra duplicada.
    await assert.rejects(() => site().fetchWork(HOME), /not_a_work_page/);
    assert.equal(stub.calls.length, 0, 'rejeição na porta, antes de qualquer fetch');
  }));

  test('crawl não aciona FlareSolverr: o tdf não tem esse caminho', () => withStub(pageRoutes(), async (stub) => {
    await site().fetchWork(MOVIE);
    assert.ok(
      stub.calls.every((c) => new URL(c.url).host === 'torrentdosfilmes-v2.xyz'),
      'só o site: nenhum host de browser, nenhuma porta do FlareSolverr',
    );
  }));
});

describe('crawl-sites/torrentdosfilmes: instância de produção e contrato', () => {
  test('adapter de produção pergunta a instância pelo NOME do profile', () => {
    // O card é `torrentdosfilmesv2` e o profile é `torrentdosfilmes`: se o
    // adaptador perguntasse pelo id do card, `br-resolvers.instance()` devolveria
    // `null` e a raspagem seria declarada indisponível em produção.
    assert.throws(() => torrentdosfilmesCrawlSite(), /resolvedor embutido não carregado/);
  });

  test('o id do site é o do CARD e o tipo de contrato aceita a flag por chamada', async () => {
    assert.equal(site().id, 'torrentdosfilmesv2', 'id do card do Jackett, não o nome do profile');
    assert.equal(site().label, 'TorrentDosFilmes');
    // A flag por chamada é o caminho de quem só tem a interface `CrawlSite`
    // (a sonda): o contrato compartilhado não ganhou campo, e o teste monta o
    // objeto com o tipo do contrato mais o extra.
    const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
    assert.equal(opts.kind, 'tv_show');
  });
});
