// Sombra do pickFile com núcleo stub (`setCoreForTest`). Não carrega `.node`
// e não importa o processo do addon. Sem o gancho, o pickFile segue sendo o TS.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = await import('../src/utils/metrics.js');
const rustCore = await import('../src/utils/rust-core.js');
const { installDebridPickHook, resetDebridPickHook } = await import('../src/utils/rust-debrid-pick.js');
const { pickFile, isEpisodePickError, isNoVideoError } = await import('../src/debrid/file-selector.js');

const saved = config.rustDebrid.file;

function counter(name: string): number {
  return Number(metrics.snapshot().counters[name] || 0);
}

beforeEach(() => {
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.rustDebrid.file = 'off';
  resetDebridPickHook();
});

after(() => {
  config.rustDebrid.file = saved;
  rustCore.setCoreForTest(null);
  resetDebridPickHook();
});

const files = [
  { path: 'a.mkv', size: 10, id: 'a' },
  { path: 'b.mkv', size: 90, id: 'b' },
];

test('sem gancho, o stub não entra mesmo com o modo shadow', () => {
  config.rustDebrid.file = 'shadow';
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => ({ kind: 'file', path: 'a.mkv', size: 10 }),
  });
  const chosen = pickFile(files, {});
  assert.equal(chosen?.path, 'b.mkv');
  assert.equal(counter('rust.debrid.pick.calls'), 0);
});

test('shadow: divergência conta e o retorno continua o do TS', () => {
  config.rustDebrid.file = 'shadow';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => ({ kind: 'file', path: 'a.mkv', size: 10 }),
  });
  const chosen = pickFile(files, {});
  assert.equal(chosen, files[1], 'objeto do TS, não o do stub');
  assert.equal(counter('rust.debrid.pick.diff'), 1);
  assert.equal(counter('rust.debrid.pick.calls'), 1);
  assert.equal(counter('rust.debrid.pick.error'), 0);
});

test('shadow: throw do stub conta erro e o TS segue valendo', () => {
  config.rustDebrid.file = 'shadow';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => { throw new Error('núcleo estourou'); },
  });
  assert.equal(pickFile(files, {})?.path, 'b.mkv');
  assert.equal(counter('rust.debrid.pick.error'), 1);
  assert.equal(counter('rust.debrid.pick.diff'), 0);
});

test('shadow: NoVideo do TS continua sendo lançado quando o stub discorda', () => {
  config.rustDebrid.file = 'shadow';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => ({ kind: 'null' }),
  });
  assert.throws(() => pickFile([{ path: 'leia-me.txt', size: 4 }], {}), isNoVideoError);
  assert.equal(counter('rust.debrid.pick.diff'), 1);
});

test('on: o retorno é o arquivo original apontado pelo stub', () => {
  config.rustDebrid.file = 'on';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => ({ kind: 'file', path: 'a.mkv', size: 10 }),
  });
  const chosen = pickFile(files, {});
  assert.equal(chosen, files[0]);
  assert.equal((chosen as { id?: string }).id, 'a');
  assert.equal(counter('rust.debrid.pick.calls'), 1);
  assert.equal(counter('rust.debrid.pick.diff'), 0);
});

test('on: throw do stub cai no TS', () => {
  config.rustDebrid.file = 'on';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => { throw new Error('núcleo estourou'); },
  });
  assert.equal(pickFile(files, {})?.path, 'b.mkv');
  assert.equal(counter('rust.debrid.pick.error'), 1);
});

test('on: EpisodePickError é reconstruído com code, evidence, context e name', () => {
  config.rustDebrid.file = 'on';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => ({
      kind: 'error',
      code: 'EPISODE_PICK',
      evidence: null,
      context: { videoCount: 2, samples: ['parte-a.mkv', 'parte-b.mkv'] },
    }),
  });
  assert.throws(
    () => pickFile(files, { season: 1, episode: 5 }),
    (err: unknown) => {
      assert.equal(isEpisodePickError(err), true);
      const error = err as { name?: string; evidence?: unknown; context?: { videoCount: number; samples: string[] } };
      assert.equal(error.name, 'EpisodePickError');
      assert.equal(error.evidence, undefined);
      assert.equal(error.context?.videoCount, 2);
      assert.deepEqual(error.context?.samples, ['parte-a.mkv', 'parte-b.mkv']);
      return true;
    },
  );
  assert.equal(counter('rust.debrid.pick.error'), 0);
});

test('on: NoVideoError reconstruído; binário sem pickFile segue só no TS', () => {
  config.rustDebrid.file = 'on';
  installDebridPickHook(() => rustCore.getCore());
  rustCore.setCoreForTest({
    normalizeTitle: (title: string) => title,
    pickFile: () => ({ kind: 'error', code: 'NO_VIDEO', evidence: null, context: null }),
  });
  assert.throws(() => pickFile([{ path: 'leia-me.txt', size: 4 }], {}), (err: unknown) => {
    assert.equal(isNoVideoError(err), true);
    assert.equal((err as { name?: string }).name, 'NoVideoError');
    return true;
  });

  metrics.reset();
  rustCore.setCoreForTest({ normalizeTitle: (title: string) => title });
  assert.equal(pickFile(files, {})?.path, 'b.mkv');
  assert.equal(counter('rust.debrid.pick.calls'), 0);
  assert.equal(pickFile(files, {})?.path, 'b.mkv');
  assert.equal(counter('rust.debrid.pick.calls'), 0);
});
