// Integração REAL do recorder da raspagem (plano "Raspagem total", Fase 5):
// recorder ↔ banco de magnets VIVO (engine de MEMÓRIA/TEMPORÁRIA) + índice de
// releases no cache isolado. Sem dublê dos colaboradores internos — só o
// `buildContext` (fronteira de rede: Cinemeta/TMDB) e o adaptador de site são
// substituídos. Prova o contrato que o piloto de gravação precisa para ser
// liberado:
//
//   - magnet/source do acervo gravados e `magnet_work.passed_filter=1` SÓ na
//     release relevante (a cortada fica 0, mas continua no acervo — a página
//     inteira entra ANTES do filtro);
//   - `idx` da obra nasce `partial=true` (uma página não cobre a obra);
//   - transição BR invalida as listas `streams` prontas da obra;
//   - falha de flush do acervo NÃO marca a página `done` (erro retentável).
process.env.CACHE_PERSIST = 'false';

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const releaseIndex = await import('../src/utils/release-index.js');
const bank = await import('../src/utils/magnet-bank.js');
const store = await import('../src/utils/crawl-store.js');
const metrics = await import('../src/utils/metrics.js');
const { prefix } = await import('../src/utils/cache-keys.js');
const { createCrawlRecorder } = await import('../src/providers/crawl-recorder.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');
import type { RawItem } from '../types/domain.js';
import type { CrawlDiscovery, CrawlSite, CrawlUrlRow } from '../src/providers/crawl-types.js';

const saved = {
  magnetBank: config.magnetBank.enabled,
  releaseIndex: config.releaseIndex.enabled,
  crawl: { ...config.crawl },
  indexOnly: config.jackett.indexOnlyIndexers,
};

beforeEach(() => {
  bank.resetForTests();
  bank.open(undefined, { forceMemory: true });
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  cache.clear();
  config.magnetBank.enabled = true;
  config.releaseIndex.enabled = true;
});

after(() => {
  bank.resetForTests();
  store.resetForTests();
  config.magnetBank.enabled = saved.magnetBank;
  config.releaseIndex.enabled = saved.releaseIndex;
  Object.assign(config.crawl, saved.crawl);
  config.jackett.indexOnlyIndexers = saved.indexOnly;
});

const IMDB = 'tt7700001';
const CONTEXT = { names: ['Expresso do Amanhã'], year: 2013, isSeries: false, season: null, episode: null };
const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}`;

const goodHash = 'a'.repeat(40);
const cutHash = 'b'.repeat(40);
const releases: RawItem[] = [
  {
    title: 'Expresso do Amanhã (2013) 1080p DUBLADO', magnet: magnet(goodHash),
    indexer: 'vacatorrent', tracker: 'Vaca Torrent', isBr: true, seeders: 1, size: 1000,
  },
  {
    title: 'Uma Obra Totalmente Alheia (1999) 720p', magnet: magnet(cutHash),
    indexer: 'vacatorrent', tracker: 'Vaca Torrent', isBr: true, seeders: 1, size: 900,
  },
];

describe('crawl-recorder: integração real com o acervo e o índice', () => {
  test('grava magnet/source/work (passed_filter=1), idx partial e invalida streams na transição BR', async () => {
    const streamKey = `${prefix('streams')}movie:${IMDB}:abc`;
    cache.set(streamKey, [{ name: 'antiga' }], 900);

    const recorder = createCrawlRecorder({ buildContext: async () => CONTEXT });
    const report = await recorder.record('vacatorrent', { imdb: IMDB, title: 'Expresso do Amanhã', year: 2013, kind: 'movie' }, releases);

    // --- Banco vivo (memória): a página inteira entra, o filtro só marca.
    assert.ok(bank.lookup(goodHash), 'magnet do relevante gravado');
    assert.equal(bank.sourcesFor(goodHash)[0].indexer, 'vacatorrent', 'source com o id do card');
    const goodWork = bank.worksFor(goodHash).find((w) => w.season === -1 && w.episode === -1);
    assert.ok(goodWork, 'work da obra do pedido');
    assert.equal(goodWork!.passedFilter, 1, 'relevante sobrevive ao filtro');

    assert.ok(bank.lookup(cutHash), 'a release cortada TAMBÉM entra no acervo');
    const cutWork = bank.worksFor(cutHash).find((w) => w.season === -1 && w.episode === -1);
    assert.equal(cutWork?.passedFilter, 0, 'cortada fica 0 — não contaminou o passed_filter');

    // --- Índice: obra nova nasce parcial e só com o relevante.
    const entry = cache.peek(`${prefix('idx')}${IMDB}`) as { partial?: boolean } | null;
    assert.ok(entry, 'índice gravou a obra');
    assert.equal(entry!.partial, true, 'uma página não cobre a obra → partial');
    assert.equal(releaseIndex.isPartial(IMDB), true);
    const indexed = releaseIndex.lookup(IMDB);
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].hash, goodHash);

    // --- Transição BR invalidou a lista pronta.
    assert.equal(report.added, 1);
    assert.equal(report.transition, 'br');
    assert.equal(report.cleared, 1);
    assert.ok(!cache.peek(streamKey), 'streams pronta da obra foi invalidada');
  });

  test('preserva partial e releases de um registro pré-existente', async () => {
    const imdb = 'tt7700002';
    const oldHash = 'c'.repeat(40);
    const newHash = 'd'.repeat(40);
    releaseIndex.record(imdb, {}, [{
      title: 'Expresso do Amanhã (2013) 1080p DUBLADO', infoHash: oldHash,
      indexer: 'vacatorrent', isBr: true, seeders: 1,
    }], { partial: true });
    assert.equal(releaseIndex.isPartial(imdb), true, 'pré-condição: já era parcial');

    const recorder = createCrawlRecorder({ buildContext: async () => CONTEXT });
    const newRelease: RawItem = {
      title: 'Expresso do Amanhã (2013) 1080p DUBLADO', magnet: magnet(newHash),
      indexer: 'vacatorrent', tracker: 'Vaca Torrent', isBr: true, seeders: 1, size: 1000,
    };
    await recorder.record('vacatorrent', { imdb, title: 'Expresso do Amanhã', year: 2013, kind: 'movie' }, [newRelease]);

    const entry = cache.peek(`${prefix('idx')}${imdb}`) as { partial?: boolean } | null;
    assert.equal(entry!.partial, true, 'a escrita do crawler NÃO limpou o partial');
    const hashes = releaseIndex.lookup(imdb).map((r) => r.hash).sort();
    assert.deepEqual(hashes, [oldHash, newHash].sort(), 'release antiga preservada junto da nova');
  });

  test('falha de flush do acervo não marca a página done (erro retentável)', async () => {
    const imdb = 'tt7700003';
    const hash = 'e'.repeat(40);
    config.crawl.enabled = true;
    config.crawl.dryRun = false;
    metrics.reset();

    store.engine().upsertUrls('fake', [{ url: '/x', lastmod: '', kind: 'movie' }], 1);
    const row = store.engine().takeNext('fake', 10) as CrawlUrlRow;
    const site: CrawlSite = {
      id: 'fake',
      label: 'Fake',
      discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
      fetchWork: async (url: string) => ({
        url, status: 'done', imdb, title: 'Expresso do Amanhã', year: 2013, type: 'movie',
        releases: [{
          title: 'Expresso do Amanhã (2013) 1080p DUBLADO', magnet: magnet(hash),
          indexer: 'vacatorrent', tracker: 'Vaca Torrent', isBr: true, seeders: 1, size: 1000,
        }],
      }),
    };

    const recorder = createCrawlRecorder({ buildContext: async () => CONTEXT });
    const process = createPageProcessor({ record: (siteId, obra, rel) => recorder.record(siteId, obra, rel) });
    bank.failNextWriteForTests();

    const outcome = await process(site, row, { dryRun: false });
    assert.equal(outcome.kind, 'error', 'flush falho vira erro retentável');
    assert.equal(store.engine().getUrl('fake', '/x')?.status, 'error', 'a URL NÃO ficou done');
    assert.equal(releaseIndex.lookup(imdb).length, 0, 'índice não recebeu o lote que não persistiu');
    assert.ok((metrics.snapshot().counters['crawl.record.flushFailed'] ?? 0) >= 1, 'métrica própria de falha');
  });

  test('fila cheia: drop atômico sem half-write (nada no acervo após flush)', async () => {
    const imdb = 'tt7700004';
    const hash = 'f'.repeat(40);
    const prevMax = config.magnetBank.queueMax;
    // needed=2 (capture+filter) com queueMax=1 → drop ANTES de qualquer push.
    config.magnetBank.queueMax = 1;
    config.crawl.enabled = true;
    config.crawl.dryRun = false;
    metrics.reset();
    try {
      store.engine().upsertUrls('fake', [{ url: '/q', lastmod: '', kind: 'movie' }], 1);
      const row = store.engine().takeNext('fake', 10) as CrawlUrlRow;
      const site: CrawlSite = {
        id: 'fake',
        label: 'Fake',
        discover: async (): Promise<CrawlDiscovery> => ({ urls: [], complete: true, failures: [] }),
        fetchWork: async (url: string) => ({
          url, status: 'done', imdb, title: 'Expresso do Amanhã', year: 2013, type: 'movie',
          releases: [{
            title: 'Expresso do Amanhã (2013) 1080p DUBLADO', magnet: magnet(hash),
            indexer: 'vacatorrent', tracker: 'Vaca Torrent', isBr: true, seeders: 1, size: 1000,
          }],
        }),
      };

      const recorder = createCrawlRecorder({ buildContext: async () => CONTEXT });
      const process = createPageProcessor({ record: (siteId, obra, rel) => recorder.record(siteId, obra, rel) });
      const outcome = await process(site, row, { dryRun: false });

      assert.equal(outcome.kind, 'error', 'drop de fila é erro retentável');
      assert.equal(store.engine().getUrl('fake', '/q')?.status, 'error', 'a URL NÃO ficou done');
      assert.equal(releaseIndex.lookup(imdb).length, 0, 'índice não recebeu lote descartado');
      assert.ok((metrics.snapshot().counters['crawl.record.queueDropped'] ?? 0) >= 1);
      assert.ok((metrics.snapshot().counters['magnetbank.queue.dropped'] ?? 0) >= 1);

      // Prova anti half-write: mesmo após o setImmediate do scheduleFlush (que
      // NÃO foi armado — drop sem push), o hash da página não está no acervo.
      await new Promise<void>((r) => setImmediate(r));
      bank.flushNow();
      assert.equal(bank.lookup(hash), null, 'nenhum half-write: capture não entrou sozinha');
      assert.equal(bank.status().queue, 0, 'fila vazia após o drop atômico');
    } finally {
      config.magnetBank.queueMax = prevMax;
      bank.flushNow();
    }
  });

  test('captureItems no caminho vivo: retorno boolean é ignorável (não bloqueia)', () => {
    // Contrato: busca ao vivo fire-and-forget — o boolean existe para o crawler;
    // callers vivos podem descartar. Kill-switch e vazio devolvem true.
    const prev = config.magnetBank.enabled;
    try {
      config.magnetBank.enabled = false;
      assert.equal(bank.captureItems([{ title: 'X', infoHash: 'a'.repeat(40) }], 'x', {}), true);
      config.magnetBank.enabled = true;
      assert.equal(bank.captureItems([], 'x', {}), true, 'vazio é no-op aceito');
      const ok = bank.captureItems([{
        title: 'Y', infoHash: 'b'.repeat(40), magnet: magnet('b'.repeat(40)),
      }], 'x', {});
      assert.equal(typeof ok, 'boolean');
      // Não await / não flush: prova que a API é síncrona e o caller segue.
    } finally {
      config.magnetBank.enabled = prev;
      bank.flushNow();
    }
  });
});

describe('crawl-recorder: identidade do id do piloto', () => {
  test('vacatorrent é o card LOCAL real (definição presente e fora dos index-only)', () => {
    const yml = path.join(process.cwd(), 'jackett-bludv', 'vacatorrent.yml');
    assert.ok(fs.existsSync(yml), `definição Cardigann do Vaca existe (${yml})`);
    const body = fs.readFileSync(yml, 'utf8');
    assert.match(body, /vacatorrent/i, 'a definição carrega o id do card');
    // O id do piloto não pode ser index-only: `allowedSourceIndexer` o deixaria
    // entrar por outro braço, mas o plano o trata como indexer BR comum.
    assert.equal(config.jackett.indexOnlyIndexers.includes('vacatorrent'), false);
  });
});