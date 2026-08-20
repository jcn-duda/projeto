import { test } from 'node:test';
import assert from 'node:assert';

import * as latestWriter from '../src/utils/latest-writer.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('fase nova impede passe tardio antigo de sobrescrever o cache', async () => {
  const oldBuild = deferred();
  const writes: any[] = [];
  const writer = latestWriter.createLatestWriter(
    (value) => value === 'episodio' ? oldBuild.promise : Promise.resolve(value),
    (value) => writes.push(value),
  );

  const episodePhase = writer.phase();
  const oldRun = writer('episodio', episodePhase);
  const packPhase = writer.advance();
  await writer('pack', packPhase);
  oldBuild.resolve('episodio');
  await oldRun;

  assert.deepEqual(writes, ['pack']);
});

test('episódio tardio útil salva a busca quando o pack fica vazio', async () => {
  const episodeBuild = deferred();
  const writes: any[] = [];
  const writer = latestWriter.createLatestWriter(
    (value) => value === 'episodio' ? episodeBuild.promise : Promise.resolve(value),
    (value) => writes.push(value),
  );

  const episodePhase = writer.phase();
  const episodeRun = writer('episodio', episodePhase);
  const packPhase = writer.advance();
  await writer([], packPhase);
  episodeBuild.resolve(['episodio']);
  await episodeRun;

  assert.deepEqual(writes, [[], ['episodio']]);
});

test('lote tardio mais novo vence o parcial dentro da mesma fase', async () => {
  const partialBuild = deferred();
  const writes: any[] = [];
  const writer = latestWriter.createLatestWriter(
    (value) => value === 'parcial' ? partialBuild.promise : Promise.resolve(value),
    (value) => writes.push(value),
  );

  const phase = writer.phase();
  const partialRun = writer('parcial', phase);
  await writer('completo', phase);
  partialBuild.resolve('parcial');
  await partialRun;

  assert.deepEqual(writes, ['completo']);
});
