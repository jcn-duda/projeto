// Fase 7 v2 — store e codec do progresso de série: partial na fila (ordem,
// requeues), flip dry→live sobre progresso SECO em QUALQUER status (F1/F2) e
// o codec render/parse. Extraído de `crawl-series-resume.test.ts` pela
// catraca de linhas. Sem rede: store em memória.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const store = await import('../src/utils/crawl-store.js');
import { parseProgress, progressAdvanced, renderProgress, withDryFlag } from '../src/utils/crawl-store-rules.js';
import type { CrawlUrlRow, SeriesWorkProgress } from '../src/providers/crawl-types.js';

const SHOW = 'https://site.example/pt/tv-shows/one-piece/';

beforeEach(() => {
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
});

after(() => {
  store.resetForTests();
});

describe('store: partial na fila (devido, ordem, requeues)', () => {
  test('pending (next_at=0) vence partial; partial vence error com backoff', () => {
    store.engine().upsertUrls('fake', [{ url: '/p', lastmod: 'x', kind: 'tv_show' }, { url: '/part', lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', '/part', {
      status: 'partial', releases: 1, progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 }),
    }, 100);
    const first = store.engine().takeNext('fake', 200) as CrawlUrlRow;
    assert.equal(first.url, '/p', 'pending primeiro');
    const second = store.engine().takeNext('fake', 200 + 120_000) as CrawlUrlRow;
    assert.equal(second.url, '/part', 'partial due após a base');
    assert.equal(second.progress.includes('/c1'), true, 'claim preserva progresso');
  });

  test('requeueErrors limpa progress de error e NÃO toca partial', () => {
    store.engine().upsertUrls('fake', [{ url: '/e', lastmod: 'x', kind: 'tv_show' }, { url: '/part', lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', '/e', {
      status: 'partial', progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 }),
    }, 100);
    // Falha DEPOIS de progresso (crash de rede): o erro preserva o avanço.
    store.engine().markResult('fake', '/e', { status: 'error', error: 'http_503' }, 110);
    const errBefore = store.engine().getUrl('fake', '/e') as CrawlUrlRow;
    assert.equal(parseProgress(errBefore.progress)?.doneCards.length, 1, 'erro não perde progresso');
    store.engine().markResult('fake', '/part', {
      status: 'partial', releases: 1, progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 }),
    }, 120);
    assert.equal(store.engine().requeueErrors('fake'), 1);
    const err = store.engine().getUrl('fake', '/e') as CrawlUrlRow;
    assert.equal(err.status, 'pending');
    assert.equal(err.progress, '', 'escape do estagnado recomeça do zero');
    const part = store.engine().getUrl('fake', '/part') as CrawlUrlRow;
    assert.equal(part.status, 'partial', 'partial saudável não é resetado');
    assert.ok(part.progress.includes('/c1'));
  });

  test('requeueSimulated reseta simulated E partial seco; partial vivo é preservado', () => {
    store.engine().upsertUrls('fake', [
      { url: '/sim', lastmod: 'x', kind: 'tv_show' },
      { url: '/drypart', lastmod: 'x', kind: 'tv_show' },
      { url: '/part', lastmod: 'x', kind: 'tv_show' },
    ], 1);
    store.engine().markResult('fake', '/sim', { status: 'simulated', imdb: 'tt1', releases: 1 }, 100);
    store.engine().markResult('fake', '/drypart', {
      status: 'partial', progress: withDryFlag(renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 })),
    }, 110);
    store.engine().markResult('fake', '/part', {
      status: 'partial', progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 }),
    }, 120);
    const n = store.engine().requeueSimulated('fake');
    assert.equal(n, 2, 'simulated + partial seco');
    assert.equal(store.engine().getUrl('fake', '/sim')?.status, 'pending');
    const dry = store.engine().getUrl('fake', '/drypart') as CrawlUrlRow;
    assert.equal(dry.status, 'pending');
    assert.equal(dry.progress, '', 'resume de passe seco faria pular cards nunca gravados');
    const live = store.engine().getUrl('fake', '/part') as CrawlUrlRow;
    assert.equal(live.status, 'partial', 'partial ao vivo NÃO é tocado');
    assert.ok(live.progress.includes('/c1'));
  });

  test('refresh de lastmod limpa o progresso (conteúdo novo reexecuta do zero)', () => {
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'a', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', SHOW, {
      status: 'partial', progress: renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 4 }),
    }, 100);
    store.engine().upsertUrls('fake', [{ url: SHOW, lastmod: 'b', kind: 'tv_show' }], 200);
    const row = store.engine().getUrl('fake', SHOW) as CrawlUrlRow;
    assert.equal(row.status, 'pending');
    assert.equal(row.progress, '');
  });

  test('F1/F2: flip reseta progresso SECO em QUALQUER status (error/pending/inflight); dry:0 intocado; idempotente', () => {
    // inflight seco PRIMEIRO (claim determinístico: é a única linha na fila).
    store.engine().upsertUrls('fake', [{ url: '/inflight', lastmod: 'x', kind: 'tv_show' }], 1);
    store.engine().markResult('fake', '/inflight', {
      status: 'partial', progress: withDryFlag(renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 })),
    }, 130);
    store.engine().takeNext('fake', 1_000_000);
    assert.equal(store.engine().getUrl('fake', '/inflight')?.status, 'inflight');

    store.engine().upsertUrls('fake', [
      { url: '/err', lastmod: 'x', kind: 'tv_show' },
      { url: '/pend', lastmod: 'x', kind: 'tv_show' },
      { url: '/live-err', lastmod: 'x', kind: 'tv_show' },
    ], 2);
    const dry = withDryFlag(renderProgress({ v: 1, doneCards: ['/c1'], totalCards: 2 }));
    // error com progresso seco (falha DEPOIS de marcar a fatia seca).
    store.engine().markResult('fake', '/err', { status: 'partial', progress: dry }, 100);
    store.engine().markResult('fake', '/err', { status: 'error', error: 'http_503' }, 110);
    // pending com progresso seco (requeueUrl preserva o progresso).
    store.engine().markResult('fake', '/pend', { status: 'partial', progress: dry }, 120);
    store.engine().requeueUrl('fake', '/pend');
    // Controle: error com progresso AO VIVO não é tocado.
    store.engine().markResult('fake', '/live-err', {
      status: 'partial', progress: renderProgress({ v: 1, doneCards: ['/c9'], totalCards: 2 }),
    }, 140);
    store.engine().markResult('fake', '/live-err', { status: 'error', error: 'http_503' }, 150);

    const n = store.engine().requeueSimulated('fake');
    assert.equal(n, 3, 'seco em error + pending + inflight; live-err e NENHUM simulated');
    const err = store.engine().getUrl('fake', '/err') as CrawlUrlRow;
    assert.equal(err.status, 'pending');
    assert.equal(err.progress, '');
    assert.equal(err.tries, 0, 'passe seco não provou tentativa');
    assert.equal(err.error, '');
    const pend = store.engine().getUrl('fake', '/pend') as CrawlUrlRow;
    assert.equal(pend.status, 'pending');
    assert.equal(pend.progress, '');
    const inflight = store.engine().getUrl('fake', '/inflight') as CrawlUrlRow;
    assert.equal(inflight.status, 'pending', 'inflight seca do crash volta à fila limpa');
    assert.equal(inflight.progress, '');
    const liveErr = store.engine().getUrl('fake', '/live-err') as CrawlUrlRow;
    assert.equal(liveErr.status, 'error', 'error com progresso ao vivo NÃO é tocado');
    assert.equal(parseProgress(liveErr.progress)?.doneCards.length, 1);

    assert.equal(store.engine().requeueSimulated('fake'), 0, 'segunda passada é no-op (idempotente)');
  });
});

describe('codec de progresso', () => {
  test('parse/render/roundtrip; ilegível é null; dry não conta como avanço', () => {
    const p: SeriesWorkProgress = { v: 1, doneCards: ['/c2', '/c1'], card: { url: '/c3', skip: 4 }, totalCards: 9 };
    const raw = renderProgress(p);
    assert.deepEqual(parseProgress(raw), p);
    assert.equal(parseProgress('lixo'), null);
    assert.equal(parseProgress('{"v":2,"doneCards":[]}'), null, 'versão estranha é recusada');
    assert.equal(progressAdvanced('', p), true, 'primeira marcação avança');
    assert.equal(progressAdvanced(raw, p), false, 'mesmo progresso não avança');
    assert.equal(progressAdvanced(raw, withDryFlag(raw)), false, 'dry é metadado do passe');
    assert.equal(progressAdvanced(raw, renderProgress({ ...p, doneCards: ['/c2', '/c1', '/c3'] })), true);
    assert.equal(progressAdvanced(raw, null), false, 'partial sem progresso nunca prova avanço');
  });
});
