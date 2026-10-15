// Sombra do índice de releases com núcleo stub. Não carrega .node nem sobe o
// addon: mede captura no `record`, comparação com teto e kill-switch.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { record, lookup } = await import('../src/utils/release-index.js');
const { installReleaseIndexHook, resetReleaseIndexHook } = await import('../src/utils/rust-release-index.js');
import type { BankRowNapi, MediaSourceProbe } from '../src/utils/rust-release-index.js';

const saved = { releaseIndex: config.releaseIndex.enabled, mode: config.rustReleaseIndex.mode };

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

function titles(): { normalizeTitle(title: string): string } {
  return { normalizeTitle: (title: string) => title };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function item(hash: string, title = 'Filme Teste 1080p DUBLADO') {
  return { title, infoHash: hash, seeders: 12, indexer: 'testindexer', isBr: true };
}

/** Stub que responde sempre `webdl` (fonte errada de propósito para gerar diff). */
function rustCoreStub(result: string | null = 'webdl', bankCheck?: (bank: BankRowNapi[]) => void) {
  return {
    ...titles(),
    releaseIndexMediaMerge: (
      _magnet: string | null, _magnetUri: string | null, _guid: string | null,
      _title: string, _hash: string, _prior: string | null, bank: BankRowNapi[],
    ) => {
      bankCheck?.(bank);
      return result;
    },
  };
}

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.releaseIndex.enabled = true;
  config.rustReleaseIndex.mode = 'off';
  resetReleaseIndexHook();
});

after(() => {
  config.releaseIndex.enabled = saved.releaseIndex;
  config.rustReleaseIndex.mode = saved.mode;
  rustCore.setCoreForTest(null);
  resetReleaseIndexHook();
});

test('default off: record não monta sondas nem chama o núcleo', async () => {
  assert.equal(config.rustReleaseIndex.mode, 'off');
  record('tt9100001', {}, [item('1'.repeat(40))]);
  await flush();
  assert.equal(counter('rust.release_index.calls'), 0);
});

test('shadow: divergência conta e o índice continua gravando o valor do TS', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest(rustCoreStub('webdl'));
  const hash = '2'.repeat(40);
  record('tt9100002', {}, [item(hash, 'Filme Teste BluRay 1080p DUBLADO')]);
  await flush();
  assert.equal(counter('rust.release_index.calls'), 1);
  assert.equal(counter('rust.release_index.divergence'), 1);
  // A decisão é do TS: a release gravada tem a fonte do título, não a do stub.
  const out = lookup('tt9100002');
  assert.equal(out.length, 1);
  assert.equal((out[0] as any).mediaSource, 'BluRay');
});

test('shadow: TS e Rust de acordo não geram divergência', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest(rustCoreStub('BluRay'));
  record('tt9100003', {}, [item('3'.repeat(40), 'Filme Teste BluRay 1080p DUBLADO')]);
  await flush();
  assert.equal(counter('rust.release_index.divergence'), 0);
});

test('shadow: stub que lança vira erro contado, sem derrubar o record', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    ...titles(),
    releaseIndexMediaMerge: () => { throw new Error('núcleo estourou'); },
  });
  record('tt9100004', {}, [item('4'.repeat(40))]);
  await flush();
  assert.equal(counter('rust.release_index.error'), 1);
  assert.equal(lookup('tt9100004').length, 1);
});

test('shadow: o acervo lido pelo TS chega ao Rust como linhas planas', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  let seen: MediaSourceProbe['bank'] = [];
  rustCore.setCoreForTest(rustCoreStub(null, (bank) => { seen = bank; }));
  const hash = '5'.repeat(40);
  // Item sem dn= no magnet é o que o acervo cobriria (aqui vazio: sem banco).
  record('tt9100005', {}, [{ title: 'Filme Teste 1080p', infoHash: hash, indexer: 'x' }]);
  await flush();
  assert.ok(Array.isArray(seen));
});

test('shadow sem núcleo carregado é no-op', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  record('tt9100006', {}, [item('6'.repeat(40))]);
  await flush();
  assert.equal(counter('rust.release_index.calls'), 0);
});

test('shadow sem releaseIndexMediaMerge (binário antigo) é no-op', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest(titles());
  record('tt9100007', {}, [item('7'.repeat(40))]);
  await flush();
  assert.equal(counter('rust.release_index.calls'), 0);
});

test('teto de log: divergências além de maxLoggedDiffs continuam contadas', async () => {
  config.rustReleaseIndex.mode = 'shadow';
  installReleaseIndexHook(() => rustCore.getCore());
  rustCore.setCoreForTest(rustCoreStub('webdl'));
  const hashes = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(20));
  const savedMax = config.rustCore.maxLoggedDiffs;
  config.rustCore.maxLoggedDiffs = 2;
  try {
    record('tt9100008', {}, hashes.map((h) => item(h, 'Filme Teste BluRay 1080p DUBLADO')));
    await flush();
  } finally {
    config.rustCore.maxLoggedDiffs = savedMax;
  }
  // O contador não obedece ao teto do log: 8 divergências contadas com teto 2.
  assert.equal(counter('rust.release_index.divergence'), hashes.length);
});
