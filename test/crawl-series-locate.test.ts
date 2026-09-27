// Fase 7 v2 — Parte A: locação por EVIDÊNCIA REAL (dn × card) e Parte B no
// adaptador: retomada por progresso (doneCards/card.skip). Fixtures reais de
// Stranger Things (2026-09-27) — slugs `season/stranger-things[-N]/` que o
// parser de `temporada-N` não lê. Sem rede: profile real com fetch dublê.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';

const store = await import('../src/utils/crawl-store.js');
const { createVacaCrawlSite } = await import('../src/providers/crawl-sites/vaca.js');
const { createResolver } = await import('../resolvers/profiles/vacatorrent.js');
const { declaredSeriesLocation } = await import('../src/providers/crawl-sites/vaca-series-locate.js');
import { stubFetch } from './helpers/stub.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import type { CrawlSeriesLimits, CrawlWorkResult, SeriesWorkProgress } from '../src/providers/crawl-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'crawl', 'vaca');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

const SITE = 'https://vaqueirofilmes.com';
const SHOW = `${SITE}/pt/tv-shows/stranger-things/`;
const LIMITS: CrawlSeriesLimits = { enabled: true, maxCards: 10, maxButtons: 40 };

const magnet = (hash: string, dn: string) =>
  `magnet:?xt=urn:btih:${hash}${dn ? `&dn=${encodeURIComponent(dn)}` : ''}`;
const H = {
  s1: 'aa'.repeat(20), s2: 'bb'.repeat(20), s3: 'cc'.repeat(20), s4: 'dd'.repeat(20),
  s5: 'ee'.repeat(20), s5e8: 'ff'.repeat(20),
};

function resolverSurface(): VacaResolverSurface {
  return createResolver({ port: 0, selfUrl: 'http://127.0.0.1:0', siteUrl: SITE, extraProtectors: [] });
}

const SHOW_PAGE = `<html><body><h1>Stranger Things (2025)</h1>`
  + `Avaliação da IMDb: <a href="https://www.imdb.com/title/tt4574334/">IMDb</a>`
  + `<div data-u="${Buffer.from(`${SITE}/pt/season-internal/?show=25245`).toString('base64')}"></div></body></html>`;

const packCard = (id: string, label: string) =>
  `<html><body><div class="ss-ep-wrap">`
  + `<div class="ss-ep-num">01</div>`
  + `<a href="https://systemtech.space/enc/go.php?id=${id}" class="ss-ep-btn ss-ep-btn-dl">${label} | 1080p</a>`
  + `</div></body></html>`;

/** Rotas de Stranger Things: 5 cards com slug sem `temporada-N`. */
function strangerRoutes() {
  const seasonCard = fixture('season-card-stranger.html');
  return {
    'pt/tv-shows/stranger-things': () => SHOW_PAGE,
    'season-internal': () => fixture('season-internal-stranger.html'),
    // Cards 1–4: 1 botão pack por card (magnets com o dn REAL medido).
    'season/stranger-things/': () => packCard('st1', 'COMPLETE'),
    'stranger-things-2/': () => packCard('st2', 'COMPLETE'),
    'stranger-things-3/': () => packCard('st3', 'S03'),
    'stranger-things-4/': () => packCard('st4', 'VOLUME 1'),
    // Card 5: layout por-episódio com pack + episódio final (fixture real).
    'stranger-things-5/': () => seasonCard,
    // Protetores: devolvem o magnet com o dn que declara o conteúdo.
    'id=st1': () => magnet(H.s1, 'Stranger.Things.1TemporadaCompleta.1080p'),
    'id=st2': () => magnet(H.s2, 'Stranger.Things.2TemporadaCompleta.1080p'),
    'id=st3': () => magnet(H.s3, 'Stranger.Things.S03.1080p'),
    'id=st4': () => magnet(H.s4, 'Stranger.Things.4Temporada2022VOLUME.1'),
    'id=st5vol1': () => magnet(H.s5, 'Stranger.Things.S05.VOLUME.01'),
    'id=st5e08': () => magnet(H.s5e8, 'Stranger.Things.S05E08.EPISODIO.FINAL'),
  };
}

function runStub(routes: Record<string, () => string>) {
  return stubFetch((url) => {
    for (const [match, body] of Object.entries(routes)) {
      if (url.includes(match)) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => body() };
      }
    }
    throw new Error(`fetch fora do mapa (sem rede): ${url}`);
  });
}

describe('vaca-series-locate: locação por evidência (regras 1–5)', () => {
  const base = { cardSeason: null, cardTitle: '', isBatch: false, realTitle: null, dn: null, linkEpisode: null };

  test('regra 1: dn vence — temporada única limpa o episódio (mata o E01)', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Stranger.Things.1TemporadaCompleta.1080p', linkEpisode: 1 }),
      { season: 1, episode: null }, 'pack completo NÃO herda o ss-ep-num',
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Stranger.Things.S05E08.EPISODIO.FINAL', linkEpisode: 3 }),
      { season: 5, episode: 8 },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Stranger.Things.4Temporada2022VOLUME.1' }),
      { season: 4, episode: null },
    );
  });

  test('regra 1: dn de série inteira vai para a raiz legítima', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Stranger.Things.Todas.as.Temporadas' }),
      { season: null, episode: null },
    );
  });

  test('regra 2: card temporada-N mantém a regressão exata (por-episódio usa linkEpisode)', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, cardSeason: 5, linkEpisode: 3 }),
      { season: 5, episode: 3 },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, cardSeason: 2, isBatch: true, linkEpisode: 1 }),
      { season: 2, episode: null }, 'batch nunca ganha episódio',
    );
  });

  test('regra 3: título do batch/card declara temporada única', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, isBatch: true, realTitle: 'BATCH – Reacher S01' }),
      { season: 1, episode: null },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, cardTitle: 'Stranger Things 4', linkEpisode: 2 }),
      { season: 4, episode: 2 },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, realTitle: 'BATCH – Série Completa' }),
      { season: null, episode: null },
    );
  });

  test('regra 4: dígito final do card ("East Blue1"); ano de 4 dígitos é rejeitado', () => {
    assert.deepEqual(declaredSeriesLocation({ ...base, cardTitle: 'East Blue1' }), { season: 1, episode: null });
    assert.deepEqual(declaredSeriesLocation({ ...base, cardTitle: 'Enies Lobby9' }), { season: 9, episode: null });
    assert.equal(declaredSeriesLocation({ ...base, cardTitle: 'Show 2020' }).season, null, 'ano não é temporada');
  });

  test('regra 5: nada declara → raiz conservadora (= comportamento de hoje)', () => {
    assert.deepEqual(declaredSeriesLocation({ ...base, cardTitle: 'Especial' }), { season: null, episode: null });
  });
});

// Bug 2026-09-27: entidades HTML na evidência ("4&ordf;" sem decodificar não
// declara temporada nenhuma) e título coerente com a locação (pack ⇒ Sxx SEM E
// herdado do bloco ss-ep-num).
describe('evidência com entidade HTML e título coerente com a locação', () => {
  const base = { cardSeason: null, cardTitle: '', isBatch: false, realTitle: null, dn: null, linkEpisode: null };

  test('dn com &ordf; vira 4ª: pack TWD T4 sai {S4,null} e NUNCA herda o E07 do bloco', () => {
    assert.deepEqual(
      declaredSeriesLocation({
        ...base, cardSeason: 4,
        cardTitle: 'The Walking Dead 4&ordf; Temporada',
        dn: 'The.Walking.Dead.4&ordf;.Temporada.Completa.1080p.DUAL',
        linkEpisode: 7,
      }),
      { season: 4, episode: null }, 'o E07 do bloco ss-ep-num não vira episódio do pack',
    );
  });

  test('dn duplamente codificado (&amp;#170;) e entidade sem ";" também decodificam', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'TWD.4&amp;#170;.Temporada.Completa.1080p', linkEpisode: 2 }),
      { season: 4, episode: null },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'TWD.4&ordf Temporada.Completa', linkEpisode: 2 }),
      { season: 4, episode: null },
    );
  });

  test('título do card com &ordf; declara a temporada (regra 3) com dn silencioso', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, cardTitle: 'The Walking Dead 4&#170; Temporada', linkEpisode: 7 }),
      { season: 4, episode: 7 }, 'dn silencioso: episódio do bloco por-episódio permanece',
    );
  });

  test('seasonFromCardSlug lê ordinal com entidade ("4&ordf;-temporada")', async () => {
    const { seasonFromCardSlug } = await import('../src/providers/crawl-sites/vaca-series-locate.js');
    assert.equal(seasonFromCardSlug('https://x/tv/twd/season/4&ordf;-temporada/'), 4);
    assert.equal(seasonFromCardSlug('https://x/tv/twd/season/temporada-4/'), 4, 'regressão');
  });

  test('groupSeriesReleases com título/dn com entidade: work APENAS S4 (nunca S1/S5)', async () => {
    const { groupSeriesReleases } = await import('../src/providers/crawl-sites/vaca-series-locate.js');
    const release = {
      title: 'The Walking Dead 4&#170; Temporada Completa DUAL 1080p',
      magnet: `magnet:?xt=urn:btih:${'ab'.repeat(20)}&dn=${encodeURIComponent('The.Walking.Dead.4&ordf;.Temporada.Completa.1080p')}`,
      indexer: 'vacatorrent', tracker: 'Vaca Torrent', isBr: true, seeders: 1,
    };
    const groups = groupSeriesReleases([{ release, request: { season: 4, episode: null } }]);
    const keys = groups.map((g) => `${g.season}:${g.episode}`);
    assert.deepEqual(keys, ['4:null'], 'work apenas na S4 — sem raiz, sem outra temporada');
  });

  test('matchesEpisode: pack da S4 atende E05 e NÃO atende a S3', async () => {
    const { matchesEpisode } = await import('../src/utils/episode-matching.js');
    const title = 'The Walking Dead 4ª Temporada Completa DUAL 1080p';
    assert.equal(matchesEpisode(title, { season: 4, episode: 5 }), true, 'pack cobre o E05 da própria temporada');
    assert.equal(matchesEpisode(title, { season: 3, episode: 5 }), false, 'pack da S4 não vira S3');
  });
});

describe('Stranger Things via fetchWork real: nunca raiz, nunca E01 fictício', () => {
  beforeEach(() => { store.resetForTests(); store.open(undefined, { forceMemory: true }); });
  after(() => { store.resetForTests(); });

  test('5 cards com slug novo → grupos {S,null} por dn + {5,8} do episódio final', async () => {
    const stub = runStub(strangerRoutes());
    try {
      const result: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW, { kind: 'tv_show', series: LIMITS });
      assert.equal(result.status, 'done');
      assert.equal(result.imdb, 'tt4574334');
      const keys = (result.groups ?? []).map((g) => `${g.season}:${g.episode}`).sort();
      assert.deepEqual(keys, ['1:null', '2:null', '3:null', '4:null', '5:8', '5:null']);
      assert.ok(!keys.includes('null:null'), 'nenhuma release na raiz');
      const e8 = result.groups!.find((g) => g.episode === 8)!.releases[0];
      assert.match(e8.title || '', /S05E08/, 'episódio real sai SxxEyy');
      const s1 = result.groups!.find((g) => g.season === 1)!.releases[0];
      assert.match(s1.title || '', /S01/, 'pack de temporada ganha Sxx no título');
      assert.doesNotMatch(s1.title || '', /E01/, 'NENHUM E01 fictício');
    } finally { stub.restore(); }
  });
});

// Bug 2026-09-27 via fetchWork real: o título FINAL de cada release é gerado
// pela locação — season pack ⇒ Sxx SEM o E fictício herdado do bloco
// ss-ep-num; entidades na evidência não atrapalham a inferência.
describe('ST T1 e TWD T4 via fetchWork real: pack sai Sxx sem E herdado do bloco', () => {
  beforeEach(() => { store.resetForTests(); store.open(undefined, { forceMemory: true }); });
  after(() => { store.resetForTests(); });

  const TWD = `${SITE}/pt/tv-shows/the-walking-dead/`;
  const TWD_PAGE = `<html><body><h1>The Walking Dead (2010)</h1>`
    + `Avaliação da IMDb: <a href="https://www.imdb.com/title/tt1520211/">IMDb</a>`
    + `<div data-u="${Buffer.from(`${SITE}/pt/season-internal/?show=99`).toString('base64')}"></div></body></html>`;
  const twdRoutes = () => ({
    'pt/tv-shows/the-walking-dead': () => TWD_PAGE,
    'season-internal': () => `<html><body><div class="sa-grid">`
      + `<a href="${SITE}/tv/the-walking-dead/season/the-walking-dead-1/" class="sa-card-title">The Walking Dead 1</a>`
      + `<a href="${SITE}/tv/the-walking-dead/season/the-walking-dead-4/" class="sa-card-title">The Walking Dead 4</a>`
      + `</div></body></html>`,
    // T1: bloco ss-ep-num 01 herdado; dn declara pack da 1ª.
    'the-walking-dead-1/': () => packCard('twdt1', 'COMPLETE'),
    // T4: bloco ss-ep-num 07 herdado; dn com &ordf; que declara o pack da 4ª.
    'the-walking-dead-4/': () => packCard('twdt4', 'COMPLETE'),
    'id=twdt1': () => magnet('99'.repeat(20), 'The.Walking.Dead.1TemporadaCompleta.1080p.DUAL'),
    'id=twdt4': () => magnet('88'.repeat(20), 'The.Walking.Dead.4&ordf;.Temporada.Completa.1080p.DUAL'),
  });

  test('T1: título S01 SEM E01 fictício; T4 (dn com &ordf;): S04 SEM E07 fictício', async () => {
    const stub = runStub(twdRoutes());
    try {
      const result: CrawlWorkResult = await createVacaCrawlSite(resolverSurface())
        .fetchWork(TWD, { kind: 'tv_show', series: LIMITS });
      assert.equal(result.status, 'done');
      const keys = (result.groups ?? []).map((g) => `${g.season}:${g.episode}`).sort();
      assert.deepEqual(keys, ['1:null', '4:null'], 'packs nas temporadas declaradas, sem episódio herdado');
      const t1 = result.groups!.find((g) => g.season === 1)!.releases[0];
      assert.match(t1.title || '', /S01/);
      assert.doesNotMatch(t1.title || '', /E01/, 'T1: NENHUM E01 fictício do bloco ss-ep-num');
      const t4 = result.groups!.find((g) => g.season === 4)!.releases[0];
      assert.match(t4.title || '', /S04/);
      assert.doesNotMatch(t4.title || '', /E07/, 'T4: NENHUM E07 fictício — dn com &ordf; vence o bloco');
    } finally { stub.restore(); }
  });
});

describe('retomada no adaptador: resume pula feito e retoma skip', () => {
  beforeEach(() => { store.resetForTests(); store.open(undefined, { forceMemory: true }); });
  after(() => { store.resetForTests(); });

  const SHOW_OBX = `${SITE}/pt/tv-shows/outer-banks/`;
  const CARD_URLS = [
    `${SITE}/tv/outer-banks/season/temporada-2/`,
    `${SITE}/tv/outer-banks/season/2a-temporada/`,
    `${SITE}/tv/outer-banks/season/especial/`,
    `${SITE}/batch/batch-sacrificio-de-sangue-s05/`,
  ];

  function outerRoutes(): Record<string, () => string> {
    const f = (n: string) => fixture(n);
    const batch = fs.readFileSync(path.join(__dirname, 'fixtures', 'vacatorrent', 'batch.html'), 'utf8');
    return {
      'pt/tv-shows/outer-banks': () => f('tv-show-page.html'),
      'season-internal': () => f('season-internal-mixed.html'),
      '/season/': () => f('season-card-episodes.html'),
      'batch-sacrificio': () => batch,
      'id=obx-s02e01': () => magnet('11'.repeat(20), ''),
      'id=obx-s02e02': () => magnet('22'.repeat(20), ''),
      'id=mDD': () => magnet('33'.repeat(20), ''),
    };
  }

  test('doneCards do resume não são re-visados (contagem de fetch de card)', async () => {
    const stub = runStub(outerRoutes());
    try {
      const resume: SeriesWorkProgress = { v: 1, doneCards: [CARD_URLS[0], CARD_URLS[1]], totalCards: 4 };
      const result = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW_OBX, { kind: 'tv_show', series: LIMITS, resume });
      const cardFetches = stub.calls.filter((c) => /\/season\/|batch-sacrificio/.test(c.url) && !c.url.includes('season-internal'));
      assert.equal(cardFetches.length, 2, 'só os cards QUE FALTAM são buscados');
      assert.ok(cardFetches.every((c) => !c.url.includes('temporada-2')), 'card feito não é re-buscado');
      assert.equal(result.status, 'done');
      assert.ok(result.progress!.doneCards.length >= 2, 'doneCards só cresce');
    } finally { stub.restore(); }
  });

  test('card.skip retoma o laço de botões no ponto cortado (botões feitos não são re-seguidos)', async () => {
    const stub = runStub(outerRoutes());
    try {
      const resume: SeriesWorkProgress = {
        v: 1, doneCards: [], card: { url: CARD_URLS[0], skip: 1 }, totalCards: 4,
      };
      await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW_OBX, { kind: 'tv_show', series: { enabled: true, maxCards: 1, maxButtons: 40 }, resume });
      const buttons = stub.calls.filter((c) => c.url.includes('systemtech'));
      assert.equal(buttons.length, 1, 'o botão 0 (já seguido) NÃO é re-seguido; segue só o 1');
    } finally { stub.restore(); }
  });

  test('card falho + ≥1 concluído nesta passada → partial com o falho FORA de doneCards', async () => {
    const stub = runStub({
      ...outerRoutes(),
      'batch-sacrificio': () => { throw new Error('http_503'); },
    });
    try {
      const result = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW_OBX, { kind: 'tv_show', series: LIMITS });
      assert.equal(result.status, 'partial');
      assert.match(result.error || '', /^cards_failed:/);
      assert.ok(!result.progress!.doneCards.some((u) => u.includes('batch-sacrificio')), 'card falho nunca entra no checkpoint');
      assert.ok(result.progress!.doneCards.length > 0, 'os concluídos entram');
    } finally { stub.restore(); }
  });

  test('TODOS os cards falham → throw (erro retentável com o custo medido)', async () => {
    const stub = runStub({
      'pt/tv-shows/outer-banks': () => SHOW_PAGE,
      'season-internal': () => fixture('season-internal-stranger.html'),
      'stranger-things': () => { throw new Error('http_503'); },
    });
    try {
      await assert.rejects(
        () => createVacaCrawlSite(resolverSurface()).fetchWork(SHOW_OBX, { kind: 'tv_show', series: LIMITS }),
        /http_503|card/,
      );
    } finally { stub.restore(); }
  });

  test('resume completo + fatia vazia → done SEM groups (não vira no-torrent)', async () => {
    const stub = runStub(outerRoutes());
    try {
      const resume: SeriesWorkProgress = { v: 1, doneCards: CARD_URLS, totalCards: 4 };
      const result = await createVacaCrawlSite(resolverSurface())
        .fetchWork(SHOW_OBX, { kind: 'tv_show', series: LIMITS, resume });
      assert.equal(result.status, 'done', 'conclusão por retomada');
      assert.equal(result.groups, undefined, 'fatia vazia não inventa grupo');
      const cardFetches = stub.calls.filter((c) => /\/season\/|batch-sacrificio/.test(c.url));
      assert.equal(cardFetches.length, 0, 'nada é re-buscado quando tudo já está feito');
    } finally { stub.restore(); }
  });
});
