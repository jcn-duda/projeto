// Índice de releases por obra (`idx:v1`): a peça que faz o addon virar
// servidor. Cobertura do módulo: escrita idempotente com dedupe por hash,
// fallback de lookup (episódio → temporada → obra), exclusão do inventário da
// conta, kill-switches e status para o painel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import { prefix } from '../src/utils/cache-keys.js';
import { record, lookup, status } from '../src/utils/release-index.js';

const release = (hash: string, extra: any = {}) => ({
  title: `Filme Teste 1080p DUAL ${hash.slice(0, 4)}`,
  infoHash: hash,
  seeders: 12,
  size: 1024 * 1024 * 1024,
  indexer: 'testindexer',
  isBr: true,
  ...extra,
});

test('record grava por obra e lookup devolve as releases', () => {
  const hash = 'a'.repeat(40);
  const added = record('tt9000001', {}, [release(hash)]);
  assert.ok(added > 0);
  const out = lookup('tt9000001');
  assert.equal(out.length, 1);
  assert.equal(out[0].hash, hash);
  assert.equal(out[0].isBr, true);
  // Chave certa no cache: idx:v1:<imdbId>, sem config nem credencial.
  assert.ok(cache.get(`${prefix('idx')}tt9000001`));
});

test('record é idempotente e deduplica por hash', () => {
  const hash = 'b'.repeat(40);
  record('tt9000002', {}, [release(hash)]);
  const addedAgain = record('tt9000002', {}, [release(hash), release('c'.repeat(40))]);
  assert.equal(addedAgain, 1, 'só o hash NOVO conta como crescimento');
  const out = lookup('tt9000002');
  assert.equal(out.length, 2, 'mesmo hash não duplica');
});

test('lookup de série cai do episódio para a temporada (pack cobre episódio)', () => {
  record('tt9000003', { season: 2 }, [
    release('d'.repeat(40), { title: 'Serie Teste 2ª Temporada Completa DUBLADO' }),
  ]);
  const out = lookup('tt9000003', { season: 2, episode: 5 });
  assert.equal(out.length, 1, 'a chave da temporada cobre o episódio pedido');
  assert.equal(lookup('tt9000003').length, 0, 'sem locação nenhuma não mistura séries na obra-mãe');
});

test('item de inventário da conta NÃO entra no índice', () => {
  // O índice guarda o que EXISTE publicamente; o que está pronto em qual conta
  // é davail/mag, escopados. Vazar inventário seria cruzar contas.
  record('tt9000004', {}, [{ ...release('e'.repeat(40)), fromAccount: true }]);
  assert.equal(lookup('tt9000004').length, 0);
});

test('item sem hash não vira índice', () => {
  record('tt9000005', {}, [{ title: 'Sem Hash 1080p' }]);
  assert.equal(lookup('tt9000005').length, 0);
});

test('flag dublado segue a mesma regra do toStremioStream', () => {
  // Fora dos sites BR, DUAL/PT explícito no título vale; sem marca, não.
  record('tt9000010', {}, [
    { ...release('aa'.repeat(20), { isBr: false }), title: 'Test Title 2024 1080p DUBLADO' },
    { ...release('bb'.repeat(20), { isBr: false }), title: 'Test Title 2024 1080p' },
  ]);
  const out = lookup('tt9000010');
  const byHash = new Map(out.map((r) => [r.hash, r]));
  assert.equal(byHash.get('aa'.repeat(20))?.dubbed, true, 'PT explícito marca dublado');
  assert.equal(byHash.get('bb'.repeat(20))?.dubbed, false, 'sem marca não vale como dublado');
});

test('RELEASE_INDEX=false desliga escrita e leitura', async () => {
  const original = config.releaseIndex.enabled;
  try {
    config.releaseIndex.enabled = false;
    record('tt9000006', {}, [release('f'.repeat(40))]);
    assert.equal(cache.get(`${prefix('idx')}tt9000006`), null);
    assert.deepEqual(lookup('tt9000006'), []);
  } finally {
    config.releaseIndex.enabled = original;
  }
});

test('teto de releases por obra corta as mais antigas', () => {
  const originalMax = config.releaseIndex.maxReleases;
  try {
    config.releaseIndex.maxReleases = 3;
    const items = ['1', '2', '3', '4'].map((n) => release(n.repeat(40)));
    record('tt9000007', {}, items);
    const out = lookup('tt9000007');
    assert.equal(out.length, 3, 'a obra não cresce sem teto');
  } finally {
    config.releaseIndex.maxReleases = originalMax;
  }
});

test('status expõe entradas e cota para o painel', () => {
  const st = status() as any;
  assert.equal(typeof st.entries, 'number');
  assert.equal(st.maxEntries, 4000);
  assert.equal(st.enabled, true);
});
