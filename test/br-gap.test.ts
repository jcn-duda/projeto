// BR-gap: lacuna de dublado no índice coberto por pool. O índice guarda
// releases globais que fazem `idxPoolCovered` devolver true e a busca se serve
// do índice (o Jackett vivo não consulta index-only nem o tail os enriquece
// porque já está coberto) — o dublado BR fica inalcançável salvo que o colhedor
// o busque em background. Este arquivo cobre as peças novas: predicado,
// decisão + dedupe do enqueue, exclusão de index-only da busca viva (requisito
// 1) e o invalidador exato de streams por obra (a próxima request reflete o
// índice sem afetar outras obras).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import * as harvestQueue from '../src/providers/harvest-queue.js';
import { liveIndexers } from '../src/providers/search-plan.js';
import { hasBrDubbed, hasBrDubbedAtQuality, hasBrDubbedBelowTarget, shouldBrGap, invalidateStreamsForObra, brTransition, BR_GAP_TARGET_QUALITY } from '../src/utils/br-gap.js';

// --- Predicado: release "BR dublado comprovado" (isBr && dubbed && !lied) ---

test('hasBrDubbed: BR dublado comprovado retorna true', () => {
  assert.equal(hasBrDubbed([{ isBr: true, dubbed: true, lied: false } as any]), true);
});

test('hasBrDubbed: release condenada pela auditoria (_lied) NÃO conta', () => {
  // O post prometia PT mas era EN: não é acervo BR ao qual prometer cobertura.
  assert.equal(hasBrDubbed([{ isBr: true, dubbed: true, lied: true } as any]), false);
});

test('hasBrDubbed: não-BR ou sem dublado não conta', () => {
  assert.equal(hasBrDubbed([{ isBr: false, dubbed: true } as any]), false, 'gringo não é BR');
  assert.equal(hasBrDubbed([{ isBr: true, dubbed: false } as any]), false, 'legendado não cobre dublado');
  assert.equal(hasBrDubbed([]), false);
  assert.equal(hasBrDubbed(null), false);
});

// --- Decisão: só com index-only configurados e sem BR no índice ------------

test('shouldBrGap: cobertura sem BR + index-only configurados → verdadeiro', () => {
  assert.equal(shouldBrGap([{ isBr: false, dubbed: false, seeders: 999 } as any], true), true);
});

test('shouldBrGap: sem index-only configurados → falso (não há onde buscar)', () => {
  assert.equal(shouldBrGap([{ isBr: false, dubbed: false, seeders: 999 } as any], false), false);
});

test('shouldBrGap control: BR dublado presente → falso mesmo com index-only', () => {
  // Control com BR presente: a lacuna não existe, nada se enfileira.
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, lied: false } as any], true), false);
});

// --- Upgrade: BR dublado só em faixa inferior conhecida ---------------------

test('shouldBrGap upgrade: BR 720p + index-only → verdadeiro (caso tt0107953)', () => {
  const indexed = [{ isBr: true, dubbed: true, lied: false, quality: '720p' } as any];
  assert.equal(hasBrDubbedBelowTarget(indexed), true);
  assert.equal(shouldBrGap(indexed, true), true, 'upgrade de faixa abre o gap');
});

test('shouldBrGap upgrade: BR 1080p presente fecha o gap', () => {
  const indexed = [
    { isBr: true, dubbed: true, lied: false, quality: '720p' } as any,
    { isBr: true, dubbed: true, lied: false, quality: BR_GAP_TARGET_QUALITY } as any,
  ];
  assert.equal(hasBrDubbedAtQuality(indexed, BR_GAP_TARGET_QUALITY), true);
  assert.equal(shouldBrGap(indexed, true), false, 'a faixa alvo já está coberta');
});

test('shouldBrGap: BR só sem resolução NÃO abre upgrade (sem crawl eterno)', () => {
  // "sem resolução" é "não sei", não faixa inferior provada.
  const indexed = [
    { isBr: true, dubbed: true, lied: false, quality: 'sem resolução' } as any,
    { isBr: true, dubbed: true, quality: undefined } as any,
  ];
  assert.equal(shouldBrGap(indexed, true), false);
});

test('shouldBrGap: BR 2160p sem 1080p não abre upgrade (faixa superior cobre)', () => {
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: '2160p' } as any], true), false);
  assert.equal(shouldBrGap([
    { isBr: true, dubbed: true, quality: '2160p' } as any,
    { isBr: true, dubbed: true, quality: '720p' } as any,
  ], true), false, 'somar 720p não reabre uma lacuna já coberta por 2160p');
});

test('shouldBrGap: SD/480p BR também são faixa inferior que abre upgrade', () => {
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: 'SD' } as any], true), true);
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: '480p' } as any], true), true);
});

test('shouldBrGap upgrade: sem index-only não abre; lied não conta como faixa', () => {
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, quality: '720p' } as any], false), false);
  assert.equal(shouldBrGap([{ isBr: true, dubbed: true, lied: true, quality: '720p' } as any], true), true,
    'o mentiroso não prova a faixa 720p, mas também não prova a alvo — gap de ausência permanece');
});

test('hasBrDubbedBelowTarget: release do autofetch não prova faixa (mesmo filtro de hasBrDubbed)', () => {
  assert.equal(hasBrDubbedBelowTarget([{ source: 'autofetch', isBr: true, dubbed: true, quality: '720p' } as any]), false);
  assert.equal(hasBrDubbedAtQuality([{ source: 'autofetch', isBr: true, dubbed: true, quality: '1080p' } as any], '1080p'), false);
});

// --- Enqueue + dedupe: reason br-gap usa o dedupe por obra que já existe ----

test('enqueue br-gap deduplica por obra (uma só entrada)', () => {
  harvestQueue.clearQueue();
  const obra = 'tt9010001';
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'gap' });

  const key = `${prefix('harvest')}q`;
  const fila = (cache.get(key) || []) as any[];
  const deObra = fila.filter((e: any) => e.imdbId === obra);
  assert.equal(deObra.length, 1, 'a mesma obra não duplica mesmo com dois br-gap + um gap');
  assert.equal(deObra[0].reason, 'br-gap', 'fica a primeira razão enfileirada');
  harvestQueue.clearQueue();
});

// --- Requisito 1: index-only NÃO entram pela busca viva --------------------

test('liveIndexers deixa os index-only fora do plano ao vivo', () => {
  const plan = liveIndexers(['apachetorrent', 'thepiratebay', 'hdrtorrent'], ['apachetorrent', 'hdrtorrent']);
  assert.deepEqual(plan, ['thepiratebay'], 'só o global sobrevive ao plano vivo');
  assert.equal(liveIndexers(['apachetorrent'], ['apachetorrent']).length, 0, 'todos index-only → nenhum plano vivo');
});

// --- Invalidador exato: só as claves streams de ESA obra -------------------

test('brTransition classifica ganho de BR e upgrade de faixa', () => {
  const br720 = [{ isBr: true, dubbed: true, quality: '720p' } as any];
  const br1080 = [{ isBr: true, dubbed: true, quality: '1080p' } as any];
  assert.equal(brTransition([], br720), 'br', 'sem BR → com BR é transição br');
  assert.equal(brTransition(br720, br1080), 'upgrade', '720p → 1080p é upgrade');
  assert.equal(brTransition(br1080, br1080), 'none', 'alvo já presente não retransiciona');
  assert.equal(brTransition(br720, br720), 'none', 'sem faixa nova não há transição');
  assert.equal(brTransition(br1080, br720), 'none', 'regressão de leitura não transiciona');
});

function seedStreamKey(key: string, value = { streams: [{ name: 'x' }] }) {
  cache.set(`${prefix('streams')}${key}`, value, 3600);
}

test('invalidateStreamsForObra derruba filme, série e temporada; não toca outras obras', () => {
  seedStreamKey('movie:tt9000101:{}:account:a');
  seedStreamKey('series:tt9000101:S2:E5:{}:account:b');
  seedStreamKey('series:tt9000101:S2:{}:account:a');
  seedStreamKey('movie:tt9000102:{}:account:a');
  seedStreamKey('movie:tt9000103:{}:account:b');

  const cleared = invalidateStreamsForObra('tt9000101');
  assert.equal(cleared, 3, 'as três claves de tt9000101 caem (filme + episódio + temporada)');
  assert.equal(cache.get(`${prefix('streams')}movie:tt9000101:{}:account:a`), null);
  assert.equal(cache.get(`${prefix('streams')}series:tt9000101:S2:E5:{}:account:b`), null);
  assert.equal(cache.get(`${prefix('streams')}series:tt9000101:S2:{}:account:a`), null);

  assert.notEqual(cache.get(`${prefix('streams')}movie:tt9000102:{}:account:a`), null, 'outra obra intacta');
  assert.notEqual(cache.get(`${prefix('streams')}movie:tt9000103:{}:account:b`), null, 'outra obra intacta');
});

test('invalidateStreamsForObra não colide com prefixos de imdbId', () => {
  seedStreamKey('movie:tt9000101:{}:account:a');
  // tt90001 NÃO é tt9000101 (fronteira de seção); o `tt\d+` captura a obra inteira.
  assert.equal(invalidateStreamsForObra('tt90001'), 0, 'prefixo curto não toca a obra longa');
  assert.notEqual(cache.get(`${prefix('streams')}movie:tt9000101:{}:account:a`), null);
  cache.forget(`${prefix('streams')}movie:tt9000101:{}:account:a`);
});

test('invalidateStreamsForObra ignora imdbId inválido', () => {
  assert.equal(invalidateStreamsForObra('abc'), 0);
  assert.equal(invalidateStreamsForObra(''), 0);
});
