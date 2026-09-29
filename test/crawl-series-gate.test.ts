// O PORTÃO DE SÉRIES do motor, nas duas pontas onde ele pode se partir sem
// nenhum teste reclamar:
//
//   A) O FIO (`crawl-step` -> `crawl-page` -> `fetchWork`): o motor tem que
//      REPASSAR a opção de séries viva ao adaptador. Nenhum `fetchWork` dublê
//      anterior olhava `opts`, e o adaptador tem o portão CERTO
//      (`series.enabled === true` recusa com zero rede) — ou seja, a falha
//      silenciosa aqui é um site que devolve `error: séries desligadas` em
//      todas as páginas de série, com a opção LIGADA no painel.
//
//   B) A IDENTIDADE DO CURSOR DE LISTAGEM: com séries desligadas, a página da
//      listagem é lida, a URL de série é descartada e a página é consumida pelo
//      cursor do mesmo jeito. Sem o marcador do portão na identidade do cursor,
//      a âncora declarava cobertura de série que ninguém tem, e ligar séries
//      depois não recuperava nada. Este bloco roda o ADAPTADOR REAL do
//      HDRTorrent contra as fixtures reais do site, com o `crawl.db` em memória.
//
// Motor e adaptador reais; só o `fetch` e o site do caso A são dublê. Sem rede:
// a suíte carrega `test/fixtures/env-empty`, então não há chave de TMDB, e o
// dublê ainda devolve página sem título — identificação `unidentified` local.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const {
  loadListingCursorForSeries, saveListingCursorForSeries,
} = await import('../src/providers/crawl-listing-series.js');
const { startListingCursor, saveListingCursor } = await import('../src/providers/crawl-cursor.js');
import { listingRoute, withSite } from './helpers/crawl-hdrtorrents-fixtures.js';
import type { CrawlSite, CrawlUrlRow, CrawlWorkResult } from '../src/providers/crawl-types.js';

const SERIES_URL = 'https://exemplo.inimigo/serie-torrent-download/';
/** Tetos DISTINTOS de propósito: `{enabled:true,10,40}` hardcoded não passa. */
const CARDS = 7;
const BUTTONS = 9;
const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: true, dryRun: true, sites: ['fake'], delayMs: 0,
    maxPerHour: 1000, idleWindowMs: 0, maxTries: 2, layoutCanary: 10,
    seriesEnabled: false, seriesMaxCards: CARDS, seriesMaxButtons: BUTTONS,
  });
});

after(() => {
  crawler._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

/** Loop até o site não ter rodada aberta (mesmo drible de `crawl-cursor-kinds`). */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (!crawler.status().runOpen) return;
    await crawler.tick();
  }
}

/**
 * Site dublê que REGISTRA o `opts` que recebeu em `fetchWork`.
 *
 * A asserção fica FORA do dublê, de propósito: um `assert` que estourasse lá
 * dentro viraria exceção no meio do `processCrawlPage`, que a engine de página
 * transforma em `error` na fila — o teste passaria com a página vermelha. Um fio
 * que se partiu tem que dar VERMELHO no teste, não uma linha de status.
 */
function recordingSite(seen: Array<Record<string, unknown>>): CrawlSite {
  return {
    id: 'fake',
    label: 'Fake',
    discover: async () => ({
      urls: [{ url: SERIES_URL, lastmod: '', kind: 'tv_show' as const }],
      complete: true,
      failures: [],
    }),
    fetchWork: async (url, opts): Promise<CrawlWorkResult> => {
      seen.push({ ...(opts ?? {}) });
      // Sem título: a identificação sai `unidentified` sem tocar rede e a linha
      // vira `no-work` (terminal), então a rodada fecha e o caso não fica
      // refém de backoff de retry.
      return { url, status: 'no-torrent', imdb: null, title: '', year: 0, type: 'series' };
    },
  };
}

describe('A) FIO: o motor repassa a opção viva de séries ao fetchWork', () => {
  test('séries LIGADAS: o adaptador recebe enabled + os tetos da config viva', async () => {
    Object.assign(config.crawl, { seriesEnabled: true });
    const seen: Array<Record<string, unknown>> = [];
    crawler._setSitesForTest(() => recordingSite(seen));
    crawler.start();
    await crawler.tick();
    await drainAll();

    assert.ok(seen.length >= 1, 'a página de série foi processada pelo motor');
    const series = seen[0].series as { enabled?: boolean; maxCards?: number; maxButtons?: number };
    assert.ok(series, 'opts.series chega ao adaptador');
    assert.equal(series.enabled, true, 'o portão do adaptador tem que ver LIGADO');
    assert.equal(series.maxCards, CARDS, 'teto de cards vem da config viva');
    assert.equal(series.maxButtons, BUTTONS, 'teto de botões vem da config viva');
    assert.equal(seen[0].kind, 'tv_show', 'o kind vem da fila, não do adaptador');
  });

  test('séries DESLIGADAS: o mesmo fio chega com enabled=false (não com o objeto fixo)', async () => {
    // O estado real do painel com séries desligadas é `opts.series` AUSENTE, e
    // aí o adaptador recusa com zero rede. O que este caso trava é o INVERSO: se
    // o motor mandasse sempre `{enabled:true,...}`, desligar no painel não
    // desligaria nada.
    const seen: Array<Record<string, unknown>> = [];
    crawler._setSitesForTest(() => recordingSite(seen));
    crawler.start();
    await crawler.tick();
    await drainAll();

    assert.ok(seen.length >= 1);
    const series = seen[0].series as { enabled?: boolean } | undefined;
    assert.equal(series?.enabled, false, 'o motor não pode mentir "ligado" para o adaptador');
  });
});

describe('B1) O marcador do portão é parte da identidade do cursor de listagem', () => {
  const SITE = 'hdrtorrent-cardigann';
  const LISTING = '/pagina/';
  const cursorAt = (page: number) => ({ ...startListingCursor(SITE, 'movie', LISTING, 1000), page });

  test('mesmo portão: o cursor é lido e a página NÃO recua', () => {
    saveListingCursorForSeries(cursorAt(41), true);
    const lido = loadListingCursorForSeries(SITE, 'movie', LISTING, true);
    assert.equal(lido?.page, 41, 'portão igual = retomada normal, sem releitura');
  });

  test('inversão do portão descarta o cursor nos DOIS sentidos', () => {
    saveListingCursorForSeries(cursorAt(41), false);
    assert.equal(
      loadListingCursorForSeries(SITE, 'movie', LISTING, true), null,
      'desligado -> ligado: o acervo de série some da cobertura antiga e volta pela releitura',
    );
    // E o inverso: com séries ligadas e o painel desligando, o cursor escrito
    // descreve um mundo que não existe mais.
    saveListingCursorForSeries(cursorAt(41), true);
    assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, false), null);
  });

  test('o cursor recusado some do `crawl_state` (o "Zerar site" não é o caminho)', () => {
    saveListingCursorForSeries(cursorAt(41), false);
    loadListingCursorForSeries(SITE, 'movie', LISTING, true);
    // Recusar e NÃO apagar deixaria o cursor velho reinstalado a cada leitura, e
    // a correção passaria a depender da gravação seguinte.
    assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, true), null, 'o segundo load também recusa');
    saveListingCursorForSeries(cursorAt(7), true);
    assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, true)?.page, 7, 'o cursor novo vale');
  });

  test('cursor de versão anterior (sem marcador) é descartado uma vez só', () => {
    // Instalação que já tem cursor gravado de antes do marcador existir: ele não
    // declara com que portão foi escrito, então conta como incompatível. O lado
    // barato do descarte é releitura, não perda.
    saveListingCursor(cursorAt(41));
    assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, true), null);
    saveListingCursorForSeries(cursorAt(3), true);
    assert.equal(loadListingCursorForSeries(SITE, 'movie', LISTING, true)?.page, 3);
  });
});

describe('B2) HDRTorrent real: série desligada e depois ligada volta a ser descoberta', () => {
  const SERIES_ON = { enabled: true, maxCards: 10, maxButtons: 40 };
  const SERIES_OFF = { enabled: false, maxCards: 10, maxButtons: 40 };
  const HOME = 'https://hdrtorrents.net/';

  test('a inversão do portão recomeça a varredura e devolve as séries da página', async () => {
    await withSite([listingRoute('pagina-1-cheia')], async ({ site, urls }) => {
      // 1) Séries desligadas: a página mista é lida inteira e só os filmes saem.
      const semSerie = await site.discover(null, { series: SERIES_OFF });
      assert.equal(semSerie.urls.filter((u) => u.kind === 'tv_show').length, 0, 'nenhuma série na fila');
      assert.equal(semSerie.urls.length, 11, 'os 11 filmes da página 1 real');
      // O cursor avançou: a página 2 foi pedida e não existe no dublê.
      assert.match(urls.at(-1) ?? '', /\/pagina\/2\//);

      // 2) Mesma série desligada: a varredura CONTINUA de onde parou (o cursor
      //    é preservado enquanto o portão não muda).
      urls.length = 0;
      await site.discover(null, { series: SERIES_OFF });
      assert.ok(
        !urls.includes(HOME),
        'com o portão igual a listagem NÃO volta à página 1 (seria reler o acervo inteiro)',
      );

      // 3) Séries LIGADAS: o cursor gravado é incompatível com o portão novo, é
      //    descartado, e a varredura recomeça da página 1 — as séries que a
      //    primeira rodada leu e descartou voltam. Este é o item 1.
      urls.length = 0;
      const comSerie = await site.discover(null, { series: SERIES_ON });
      assert.equal(urls[0], HOME, 'a releitura abre na página 1 (o cursor foi descartado)');
      assert.equal(
        comSerie.urls.filter((u) => u.kind === 'tv_show').length, 9,
        'as 9 séries da página 1 real voltaram para a fila',
      );
      assert.equal(comSerie.urls.filter((u) => u.kind === 'movie').length, 11, 'e os filmes seguem lá');
      // Completude por kind: com séries desligadas a rodada NÃO cobre série.
      assert.equal(semSerie.completeByKind?.movie, false, 'a página 2 faltou: a listagem não está completa');
      assert.equal(semSerie.completeByKind?.tv_show, false, 'série lida e DESCARTADA não é "coberta"');
      assert.equal(comSerie.completeByKind?.tv_show, false, 'o round de série também não é cobertura');
    });
  });
});

describe('B3) A releitura é segura porque a fila é idempotente', () => {
  test('a mesma URL relida não duplica linha nem ressuscita página processada', () => {
    const site = 'hdrtorrent-cardigann';
    store.engine().upsertUrls(site, [{ url: SERIES_URL, lastmod: '', kind: 'tv_show' }], Date.now());
    store.engine().markResult(site, SERIES_URL, { status: 'done', releases: 2 }, Date.now());
    store.engine().upsertUrls(site, [{ url: SERIES_URL, lastmod: '', kind: 'tv_show' }], Date.now());
    const row = store.engine().getUrl(site, SERIES_URL) as CrawlUrlRow;
    assert.equal(row.status, 'done', 'o upsert da releitura NÃO ressuscita a página já lida');
    assert.equal(row.releases, 2, 'o que foi gravado continua');
    assert.equal(store.engine().counters(site).total, 1, 'uma linha só na fila');
  });
});
