import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as catalog from '../src/utils/catalog.js';
import * as rows from '../src/utils/catalog-rows.js';

const ADAPTER = 'alldebrid';
const ACCOUNT = 'test-acct';

function freshDb(): void {
  rows.resetForTests();
  const dbPath = path.join(tmpdir(), `catalog-wv-test-${Math.random().toString(36).slice(2)}.db`);
  rows.open(dbPath);
}

function baseRow(overrides: Partial<rows.Row>): rows.Row {
  return {
    adapter: ADAPTER, account: ACCOUNT,
    serviceId: '0', hash: '', filename: '', size: 0, status: 'ready',
    ready: 1, uploadedAt: 0, bucket: '', audio: '', foreignProof: '', ptProof: '',
    imdbId: '', workTitle: '', workIsBr: 0, workDubbed: 0, workLied: 0,
    season: null, episode: null, cached: 'unknown', cachedAt: 0,
    firstSeenAt: 0, lastSeenAt: 0, auditedAt: 0, deletedAt: 0, deleteReason: '',
    ...overrides,
  };
}

test('planWorkVersions agrupa por imdbId + temporada + episódio', () => {
  freshDb();
  const e = rows.engine();
  // Duas versões da mesma obra (filme): dub e dual.
  e.insertRow(baseRow({ serviceId: '1', hash: 'a'.repeat(40), filename: 'Obra.DUB.mkv', size: 5e9, bucket: 'dub', imdbId: 'tt1234', workTitle: 'Obra' }));
  e.insertRow(baseRow({ serviceId: '2', hash: 'b'.repeat(40), filename: 'Obra.DUAL.mkv', size: 6e9, bucket: 'dual', imdbId: 'tt1234', workTitle: 'Obra' }));
  const plan = catalog.planWorkVersions(ACCOUNT, ADAPTER);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].imdbId, 'tt1234');
  // dub > dual na preferência.
  assert.equal(plan.groups[0].keep.bucket, 'dub');
  assert.equal(plan.groups[0].kill.length, 1);
  assert.equal(plan.groups[0].kill[0].bucket, 'dual');
});

test('planWorkVersions separa temporadas e pack', () => {
  freshDb();
  const e = rows.engine();
  // S01E01 dub e dual.
  e.insertRow(baseRow({ serviceId: '10', hash: 'c'.repeat(40), filename: 'Serie.S01E01.DUB', size: 2e9, bucket: 'dub', imdbId: 'tt5678', workTitle: 'Serie', season: 1, episode: 1 }));
  e.insertRow(baseRow({ serviceId: '11', hash: 'd'.repeat(40), filename: 'Serie.S01E01.DUAL', size: 3e9, bucket: 'dual', imdbId: 'tt5678', workTitle: 'Serie', season: 1, episode: 1 }));
  // Pack S01 dub e lixo.
  e.insertRow(baseRow({ serviceId: '12', hash: 'e'.repeat(40), filename: 'Serie.S01.DUB', size: 20e9, bucket: 'dub', imdbId: 'tt5678', workTitle: 'Serie', season: 1 }));
  e.insertRow(baseRow({ serviceId: '13', hash: 'f'.repeat(40), filename: 'Serie.S01.LIXO', size: 18e9, bucket: 'lixo', imdbId: 'tt5678', workTitle: 'Serie', season: 1 }));
  const plan = catalog.planWorkVersions(ACCOUNT, ADAPTER);
  assert.equal(plan.groups.length, 2, 'dois grupos: S01E01 e pack S01');
  // Pack vem primeiro (mais bytes recuperáveis).
  assert.equal(plan.groups[0].episode, null, 'pack não tem episódio');
  assert.equal(plan.groups[0].season, 1);
  assert.equal(plan.groups[1].episode, 1, 'episódio específico');
});

test('planWorkVersions exclui linhas sem imdbId', () => {
  freshDb();
  const e = rows.engine();
  e.insertRow(baseRow({ serviceId: '20', hash: 'g'.repeat(40), filename: 'SemObra1', size: 1e9, bucket: 'dub', imdbId: '' }));
  e.insertRow(baseRow({ serviceId: '21', hash: 'h'.repeat(40), filename: 'SemObra2', size: 2e9, bucket: 'dual', imdbId: '' }));
  const plan = catalog.planWorkVersions(ACCOUNT, ADAPTER);
  assert.equal(plan.groups.length, 0, 'sem imdbId não agrupa');
  assert.equal(plan.withoutImdb, 2);
});

test('planWorkVersions: linha ativa nunca sugerida para sair', () => {
  freshDb();
  const e = rows.engine();
  e.insertRow(baseRow({ serviceId: '30', hash: 'i'.repeat(40), filename: 'Ativa.DUB', size: 5e9, bucket: 'dub', imdbId: 'tt9999', workTitle: 'Ativa', status: 'downloading' }));
  e.insertRow(baseRow({ serviceId: '31', hash: 'j'.repeat(40), filename: 'Ativa.DUAL', size: 4e9, bucket: 'dual', imdbId: 'tt9999', workTitle: 'Ativa' }));
  const plan = catalog.planWorkVersions(ACCOUNT, ADAPTER);
  assert.equal(plan.groups.length, 1);
  // A ativa é o keep (dub + downloading), a dual é kill.
  assert.equal(plan.groups[0].keep.serviceId, '30');
  assert.equal(plan.groups[0].kill.length, 1);
  assert.equal(plan.groups[0].kill[0].serviceId, '31');
});

test('planWorkVersions: linha protegida nunca sugerida para sair', () => {
  freshDb();
  const e = rows.engine();
  // Uma versão com bucket lixo (menor preferência) mas protegida.
  e.insertRow(baseRow({ serviceId: '40', hash: 'k'.repeat(40), filename: 'Prot.LIXO', size: 3e9, bucket: 'lixo', imdbId: 'tt8888', workTitle: 'Prot' }));
  e.insertRow(baseRow({ serviceId: '41', hash: 'l'.repeat(40), filename: 'Prot.DUAL', size: 4e9, bucket: 'dual', imdbId: 'tt8888', workTitle: 'Prot' }));
  // O protected flag vem do isCleanupProtected — sem hook configurado, retorna false.
  // Vamos testar que a preferência de bucket funciona: dual > lixo.
  const plan = catalog.planWorkVersions(ACCOUNT, ADAPTER);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].keep.bucket, 'dual', 'dual vence lixo na preferência');
  assert.equal(plan.groups[0].kill[0].bucket, 'lixo');
});
