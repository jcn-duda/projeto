// Persistência do MagnetDB extraída (magnetdb-persist.ts) + base da soma de
// TTL restante (`ttlRemainingBasis`). Cobre: reexportação pela fachada pública,
// degradação l1-rebuild → aggregate-estimate na primeira mutação e o valor do
// qualificador exposto pelo status (consumido pelo modelo do /painel).
//
// O AGREGADO (`mag_meta:v1:counts`) passou a ser do núcleo: escrita e leitura
// vão pela ponte (`magnetState().putCounts/counts`), no MESMO handle do acervo
// `mag:v1`. O que este arquivo prova, além das regressões de política:
// (a) a escrita nativa é lida de volta com o MESMO formato que o Node lia;
// (b) boot com agregado presente NÃO rebuild-a;
// (c) boot sem agregado rebuild-a (fail-closed, nunca contagem inventada);
// (d) o Node não grava mais a chave no `cache` (nada de `cache.set`/`peek`).
//
// Payload ILEGÍVEL (versão estranha, `adapters` em array, JSON quebrado) não é
// plantável pela escrita tipada — esses casos vivem no teste Rust
// (`crates/adom-index/src/magnet_meta_tests.rs`), que insere a linha crua.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as magnetdbWrites from './helpers/pipeline-oracle/play/magnetdb-writes.js';
import * as persist from '../src/utils/magnetdb-persist.js';
import * as cache from '../src/utils/cache.js';
import { magMetaCountsKey } from '../src/utils/cache-keys.js';
import { magnetState } from '../src/utils/debrid-state-native.js';
import type { AdapterTotals } from '../src/utils/magnetdb-counts.js';

const H = (c: string) => c.repeat(40);
/** Esvazia o namespace `mag` — as linhas agora são do núcleo, não do `cache`. */
const clearMag = () => magnetState().clear();
/** 7 dias: o piso de TTL que a gravação do agregado usa. */
const AGGREGATE_TTL = 7 * 86400;

/** Planta o agregado pela MESMA via de produção e recarrega a amostra. */
function plantCounts(adapters: Record<string, AdapterTotals>, nowMs = Date.now(), ttlSeconds = AGGREGATE_TTL) {
  magnetState().putCounts(adapters, ttlSeconds, nowMs);
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
}

test('fachada pública: magnetdb reexporta save/load e a base do TTL', () => {
  assert.equal(magnetdb.savePersistentCounts, persist.savePersistentCounts);
  assert.equal(magnetdb.loadPersistentCounts, persist.loadPersistentCounts);
  assert.equal(typeof magnetdb.status().ttlRemainingBasis, 'string');
});

test('mutação normal usa aggregate-estimate e sobrevive ao status()', () => {
  magnetdbWrites.markAlive('premiumize', 'conta-basis-1', [H('a')]);
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'aggregate-estimate');
  assert.ok(magnetdb.status().sizeAlive >= 1);
});

// (a) O valor gravado tem a forma que o Node lia: o `cache.db` herdado continua
// legível e o painel não muda de contrato.
test('agregado: a escrita é nativa e o valor mantém o formato de sempre', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-formato', [H('a'), H('b')]);
  magnetdbWrites.markBad('torbox', 'conta-formato', H('c'));
  const before = Date.now();
  persist.savePersistentCounts();

  const payload = magnetState().counts(Date.now());
  assert.ok(payload, 'a gravação nativa deixa o agregado legível');
  assert.equal(payload.version, 1, 'version 1, como o Node gravava');
  assert.ok(payload.updatedAt >= before, 'updatedAt é o carimbo da gravação');
  assert.deepEqual(Object.keys(payload.adapters).sort(), ['premiumize', 'torbox']);
  const premiumize = payload.adapters.premiumize;
  assert.equal(premiumize.alive, 2);
  assert.equal(premiumize.bad, 0);
  assert.equal(premiumize.lie, 0);
  assert.ok(premiumize.ttlRemainingSums.alive > 0, 'soma de TTL restante preservada');
  assert.equal(payload.adapters.torbox.bad, 1);
  // A leitura de volta pela ponte é o próprio caminho de boot.
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(magnetdb.status().sizeAlive, 2);
  assert.equal(magnetdb.status().sizeBad, 1);
});

// (b) Agregado presente e conferindo com o namespace: restaura, não reconta.
test('boot com agregado presente NÃO rebuild-a: restaura sem pagar O(n)', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-confere', [H('4'), H('5')]);
  persist.savePersistentCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();

  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate', 'sem divergência não paga O(n)');
  assert.equal(magnetdb.status().sizeAlive, 2);
});

// (c) Sem agregado e com namespace cheio: reconta o acervo e marca l1-rebuild.
test('boot sem agregado rebuild-a o L1 e marca l1-rebuild até a primeira mutação', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-basis-2', [H('b')]);
  magnetState().forgetCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();

  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'l1-rebuild');
  // A média reconstruída nasce do restante real: TTL vivo logo após a marca.
  const st = magnetdb.status();
  assert.ok((st.ttlRemainingSeconds.alive || 0) > 0, 'TTL restante veio do L1, não de soma nominal');
  // A primeira mutação degrada para estimativa — a precisão do rebuild já era.
  magnetdbWrites.markBad('premiumize', 'conta-basis-2', H('c'));
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'aggregate-estimate');
});

// (d) A chave não é mais escrita pelo cache do Node: quem grava é o núcleo.
test('o Node não grava mais mag_meta no cache — escrita só pela ponte nativa', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-via', [H('e')]);
  magnetState().forgetCounts();
  cache.forget(magMetaCountsKey());
  persist.savePersistentCounts();

  assert.equal(cache.peek(magMetaCountsKey()), null, 'nada no L1/L2 do Node');
  assert.ok(magnetState().counts(Date.now()), 'mas o agregado existe na via nativa');
});

test('restauração do agregado persistido (payload válido) é aggregate-estimate', () => {
  magnetdbWrites.markAlive('premiumize', 'conta-basis-3', [H('d')]);
  persist.savePersistentCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  assert.ok(magnetdb.status().sizeAlive >= 1, 'contagem restaurada do payload');
});

// O rótulo humano do qualificador ("recontada do L1" × "estimativa incremental
// ou restaurada") vivia no cliente legado de /dashboard; o /painel consome
// `ttlRemainingBasis` pelo modelo puro (view-magnets.ts), coberto em
// painel-views.test.ts. Aqui o contrato do BACKEND continua o que importa: o
// valor viaja estável e tipado pela fachada.
test('painel: o status expõe ttlRemainingBasis consumível pelo modelo do painel', () => {
  const basis = magnetdb.status().ttlRemainingBasis;
  assert.equal(typeof basis, 'string');
  assert.ok(basis.length > 0);
});

test('renewAlive sobre chave existente degrada l1-rebuild para aggregate-estimate', () => {
  magnetdbWrites.markAlive('premiumize', 'conta-basis-4', [H('e')]);
  magnetState().forgetCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  // Chave viva na primeira metade do TTL não seria renovada; para forçar a
  // renovação, plantamos o alive já envelhecido (restante < ttl/2). O `nowMs`
  // de `markAlive` é o relógio da janela: recuá-lo envelhece a marca sem
  // precisar de sono real.
  magnetState().markAlive('premiumize', 'conta-basis-4', [H('f')], 60, Date.now() - 45_000);
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  magnetdbWrites.renewAlive('premiumize', 'conta-basis-4', [H('f')]);
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate', 'renovação sem gravação nova também degrada');
  assert.equal(magnetdb.status().ttlRemainingBasis, 'aggregate-estimate');
});

test('ensureCountsLoaded com L1 vazio reseta a base para aggregate-estimate', () => {
  magnetdbWrites.markAlive('premiumize', 'conta-basis-6', [H('2')]);
  magnetState().forgetCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  // Namespace esvazia de verdade: nenhum `l1-rebuild` órfão pode sobreviver
  // sem registros que o qualifiquem.
  clearMag();
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
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-deriva', [H('1'), H('2')]);
  magnetdbWrites.markBad('alldebrid', 'conta-deriva', H('3'));
  const l1 = magnetdb.status().l1Entries;
  assert.equal(l1, 3, 'três registros físicos no namespace mag');

  // Agregado que ABRE e mente: subconta o premiumize e omite o alldebrid.
  plantCounts({
    premiumize: { alive: 1, bad: 0, lie: 0, ttlRemainingSums: { alive: 10, bad: 0, lie: 0 } },
  });

  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild', 'divergência força a recontagem');
  const st = magnetdb.status();
  assert.equal(st.sizeAlive + st.sizeBad + st.sizeLie, l1, 'soma volta a bater com o namespace');
  assert.equal(st.sizeAlive, 2);
  assert.equal(st.sizeBad, 1);
  assert.ok(st.byAdapter.alldebrid, 'adapter omitido pelo agregado reaparece');
});

// ALCANCE DA SENTINELA, escrito como teste para não virar promessa vaga: ela
// compara TOTAIS, então distribuição torta com soma certa passa. Detectar isso
// exigiria varrer o L1 todo boot ou persistir fingerprint por lado/adapter —
// custo permanente sem evidência de que a deriva aconteça. Este teste existe
// para o dia em que alguém achar que a checagem cobre mais do que cobre.
test('sentinela é de divergência TOTAL: distribuição errada com soma igual passa', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-torta', [H('6'), H('7')]);
  assert.equal(magnetdb.status().l1Entries, 2);

  // Soma bate (2 = 2), lados trocados: 1 alive + 1 bad onde o L1 tem 2 alive.
  plantCounts({
    premiumize: { alive: 1, bad: 1, lie: 0, ttlRemainingSums: { alive: 10, bad: 10, lie: 0 } },
  });

  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate', 'total confere: não paga O(n)');
  const st = magnetdb.status();
  assert.equal(st.sizeAlive, 1, 'distribuição torta sobrevive — limite conhecido e aceito');
  assert.equal(st.sizeBad, 1);
  assert.equal(st.sizeAlive + st.sizeBad + st.sizeLie, st.l1Entries, 'o total, esse, continua honesto');
});

// A soma de TTL restante envelhece pelo `updatedAt` do agregado: é o único campo
// que a restauração usa para não vender como atual uma média de horas atrás.
test('restauração envelhece a soma de TTL pelo updatedAt gravado', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-idade', [H('9')]);
  const umaHoraAtras = Date.now() - 3_600_000;
  plantCounts({
    premiumize: { alive: 1, bad: 0, lie: 0, ttlRemainingSums: { alive: 7_200, bad: 0, lie: 0 } },
  }, umaHoraAtras);

  const st = magnetdb.status();
  assert.equal(persist.ttlRemainingBasis(), 'aggregate-estimate');
  const restante = st.ttlRemainingSeconds.alive || 0;
  assert.ok(restante > 3_000 && restante < 4_000, `7200s menos ~3600s de idade, veio ${restante}`);
});

// Escrita e parse têm de aceitar o mesmo conjunto: hash fora do formato não
// pode virar chave física, senão o rebuild não a conta, a sentinela acusa
// desacordo eterno e todo boot paga a recontagem sem convergir.
test('hash fora do formato não vira chave física nem contador', () => {
  clearMag();
  persist.adapterCounts.clear();
  magnetdbWrites.markAlive('premiumize', 'conta-hash', ['nao-e-hash', 'ABC', H('8')]);
  magnetdbWrites.markBad('premiumize', 'conta-hash', 'tambem-nao');
  magnetdbWrites.markLie('premiumize', 'conta-hash', 'nem-esse');

  const st = magnetdb.status();
  assert.equal(st.l1Entries, 1, 'só o hash de 40-hex virou chave');
  assert.equal(st.sizeAlive, 1);
  assert.equal(st.sizeBad, 0);
  assert.equal(st.sizeLie, 0);
  // E o que foi gravado sobrevive ao ciclo completo de recontagem.
  magnetState().forgetCounts();
  persist.adapterCounts.clear();
  persist.loadPersistentCounts();
  assert.equal(persist.ttlRemainingBasis(), 'l1-rebuild');
  assert.equal(magnetdb.status().sizeAlive, 1, 'rebuild conta a mesma chave que a escrita criou');
});
