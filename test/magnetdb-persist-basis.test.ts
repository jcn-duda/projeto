// Persistência do MagnetDB extraída (magnetdb-persist.ts) + base da soma de
// TTL restante (`ttlRemainingBasis`). Cobre: reexportação pela fachada pública,
// degradação l1-rebuild → aggregate-estimate na primeira mutação e o
// qualificador no painel (dashboard-panels.js, ES5, regexado no corpo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as persist from '../src/utils/magnetdb-persist.js';
import * as cache from '../src/utils/cache.js';
import { magMetaCountsKey } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';

const H = (c: string) => c.repeat(40);

test('fachada pública: magnetdb reexporta save/load e a base do TTL', () => {
  assert.equal(magnetdb.savePersistentCounts, persist.savePersistentCounts);
  assert.equal(magnetdb.loadPersistentCounts, persist.loadPersistentCounts);
  assert.equal(typeof magnetdb.status().ttlRemainingBasis, 'string');
});

test('mutação normal usa aggregate-estimate e sobrevive ao status()', () => {
  magnetdb.markAlive('premiumize', 'conta-basis-1', [H('a')]);
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'aggregate-estimate');
  assert.ok(magnetdb.status().sizeAlive >= 1);
});

test('agregado ausente com L1 cheio: rebuild do L1 marca l1-rebuild até a primeira mutação', () => {
  magnetdb.markAlive('premiumize', 'conta-basis-2', [H('b')]);
  cache.forget(magMetaCountsKey());
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'l1-rebuild');
  // A média reconstruída nasce do restante real: TTL vivo logo após a marca.
  const st = magnetdb.status();
  assert.ok((st.ttlRemainingSeconds.alive || 0) > 0, 'TTL restante veio do L1, não de soma nominal');
  // A primeira mutação degrada para estimativa — a precisão do rebuild já era.
  magnetdb.markBad('premiumize', 'conta-basis-2', H('c'));
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'aggregate-estimate');
});

test('restauração do agregado persistido (payload válido) é aggregate-estimate', () => {
  magnetdb.markAlive('premiumize', 'conta-basis-3', [H('d')]);
  persist.savePersistentCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  assert.ok(magnetdb.status().sizeAlive >= 1, 'contagem restaurada do payload');
});

test('painel: qualificador da base junto das médias, mantendo ES5', () => {
  const js = readFileSync(fileURLToPath(new URL('../src/public/dashboard-panels.js', import.meta.url)), 'utf8');
  assert.ok(js.includes('ttlRemainingBasis'), 'painel lê ttlRemainingBasis do status');
  assert.ok(js.includes('l1-rebuild') && js.includes('aggregate-estimate'), 'base explícita no corpo');
  assert.ok(/var ttlBasis = source\.ttlRemainingBasis === "l1-rebuild"/.test(js), 'default seguro: só l1-rebuild declarado vira reconstruída');
  assert.ok(js.includes('estimativa incremental ou restaurada'), 'guidance explica a natureza da média');
  assert.ok(!/\b(const |=>|`)/.test(js.split('renderMagnetDb')[1]?.split('function ')[0] || ''), 'corpo da renderização sem sintaxe pós-ES5');
});

test('renewAlive sobre chave existente degrada l1-rebuild para aggregate-estimate', () => {
  magnetdb.markAlive('premiumize', 'conta-basis-4', [H('e')]);
  cache.forget(magMetaCountsKey());
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  // Chave viva na primeira metade do TTL não seria renovada; para forçar a
  // renovação, plantamos o alive diretamente já envelhecido (restante < ttl/2).
  const key = `mag:v1:alive:premiumize:${accountScope('conta-basis-4')}:${H('f')}`;
  cache.set(key, 1, 60);
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  magnetdb.renewAlive('premiumize', 'conta-basis-4', [H('f')]);
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate', 'renovação sem gravação nova também degrada');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'aggregate-estimate');
});

function plantCountsPayload(payload: unknown) {
  magnetdb.markAlive('premiumize', 'conta-basis-5', [H('1')]);
  cache.set(magMetaCountsKey(), payload, 600);
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
}

test('payload com version estranha cai no rebuild do L1', () => {
  plantCountsPayload({ version: 2, updatedAt: Date.now(), adapters: { premiumize: { alive: 99, bad: 0, lie: 0, ttlRemainingSums: { alive: 99, bad: 0, lie: 0 } } } });
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  const totals = persist.adapterCounts.get('premiumize');
  assert.ok(totals && totals.alive >= 1 && totals.alive < 99, 'contagem veio do L1, não do payload estranho');
});

test('payload malformado (adapters não-objeto) cai no rebuild do L1', () => {
  plantCountsPayload({ version: 1, updatedAt: Date.now(), adapters: ['lixo'] });
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  assert.ok(persist.adapterCounts.get('premiumize'), 'contagem veio do L1');
});

test('ensureCountsLoaded com L1 vazio reseta a base para aggregate-estimate', () => {
  magnetdb.markAlive('premiumize', 'conta-basis-6', [H('2')]);
  cache.forget(magMetaCountsKey());
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  // L1 esvazia de verdade (namespace mag some): nenhum `l1-rebuild` órfão pode
  // sobreviver sem registros que o qualifiquem.
  const magKeys = cache.keysMatching('mag:v1:');
  for (const k of magKeys) cache.forget(k);
  const st = magnetdb.status();
  assert.equal(st.l1Entries, 0);
  assert.equal(st.ttlRemainingBasis, 'aggregate-estimate');
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
});

// Regressão medida no cache.db local: o agregado dizia 77 alive com 190 chaves
// vivas no namespace e o adapter alldebrid sumia inteiro do painel — legível,
// portanto aceito como verdade, somado às mutações e regravado a cada boot. O
// rebuild-por-ilegível não cobria isso: só ilegibilidade caía na recontagem.
test('agregado legível mas divergente do L1 cai no rebuild em vez de virar verdade', () => {
  const magKeys = cache.keysMatching('mag:v1:');
  for (const k of magKeys) cache.forget(k);
  persist.adapterCounts.clear();
  magnetdb.markAlive('premiumize', 'conta-deriva', [H('1'), H('2')]);
  magnetdb.markBad('alldebrid', 'conta-deriva', H('3'));
  const l1 = magnetdb.status().l1Entries;
  assert.equal(l1, 3, 'três registros físicos no namespace mag');

  // Agregado que ABRE e mente: subconta o premiumize e omite o alldebrid.
  cache.set(magMetaCountsKey(), {
    version: 1,
    updatedAt: Date.now(),
    adapters: { premiumize: { alive: 1, bad: 0, lie: 0, ttlRemainingSums: { alive: 10, bad: 0, lie: 0 } } },
  }, 7 * 86400);
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();

  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild', 'divergência força a recontagem');
  const st = magnetdb.status();
  assert.equal(st.sizeAlive + st.sizeBad + st.sizeLie, l1, 'soma volta a bater com o namespace');
  assert.equal(st.sizeAlive, 2);
  assert.equal(st.sizeBad, 1);
  assert.ok(st.byAdapter.alldebrid, 'adapter omitido pelo agregado reaparece');
});

test('agregado que confere com o L1 continua sendo restaurado, sem rebuild à toa', () => {
  const magKeys = cache.keysMatching('mag:v1:');
  for (const k of magKeys) cache.forget(k);
  persist.adapterCounts.clear();
  magnetdb.markAlive('premiumize', 'conta-confere', [H('4'), H('5')]);
  persist.savePersistentCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate', 'sem divergência não paga O(n)');
  assert.equal(magnetdb.status().sizeAlive, 2);
});
