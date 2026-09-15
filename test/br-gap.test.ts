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
import * as harvesterLive from '../src/utils/harvester-live.js';
import * as metrics from '../src/utils/metrics.js';
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

// --- Fase 5: promoção de motivo na fila do colhedor -------------------------

function filaPersistida(): any[] {
  return (cache.get(`${prefix('harvest')}q`) || []) as any[];
}

test('Fase 5: promoção br-gap sobrescreve miss da mesma obra sem duplicar', () => {
  harvestQueue.clearQueue();
  const obra = 'tt9020001';
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'miss' });
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
  const deObra = filaPersistida().filter((e: any) => e.imdbId === obra);
  assert.equal(deObra.length, 1, 'promoção não cria segunda entrada');
  assert.equal(deObra[0].reason, 'br-gap', 'o motivo inferior vira br-gap');
  harvestQueue.clearQueue();
});

test('Fase 5: promoção nunca rebaixa next-episode para br-gap', () => {
  harvestQueue.clearQueue();
  const obra = 'tt9020002';
  harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 2, reason: 'next-episode' });
  harvestQueue.enqueue({ imdbId: obra, type: 'series', season: 1, episode: 2, reason: 'br-gap' });
  const deObra = filaPersistida().filter((e: any) => e.imdbId === obra);
  assert.equal(deObra.length, 1, 'sem duplicata');
  assert.equal(deObra[0].reason, 'next-episode', 'next-episode é o topo da precedência');
  harvestQueue.clearQueue();
});

test('Fase 5: promoção grava o dedupe; chamada repetida não repromove', () => {
  harvestQueue.clearQueue();
  const obra = 'tt9020003';
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'miss' });
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
  const promovidasAntes = metrics.snapshot().counters['harvest.queue.promoted'] || 0;
  // Já é br-gap: a chamada seguinte não promove de novo nem conta enqueue novo.
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
  const promovidasDepois = metrics.snapshot().counters['harvest.queue.promoted'] || 0;
  assert.equal(promovidasDepois - promovidasAntes, 0, 'promoção repetida não conta');
  assert.equal(filaPersistida().filter((e: any) => e.imdbId === obra).length, 1, 'sem duplicata');
  // O dedupe ficou gravado: consumida a fila, o mesmo br-gap não volta em 12h.
  harvestQueue.clearQueue();
  harvestQueue.enqueue({ imdbId: obra, type: 'movie', season: null, episode: null, reason: 'br-gap' });
  assert.equal(filaPersistida().length, 0, 'o dedupe da promoção segura o re-enqueue por 12h');
  harvestQueue.clearQueue();
});

// --- Fase 5: prioridade própria do br-gap recente (independe do toggle) -----

test('Fase 5: br-gap recente fura o starved >6h, que não o passa pela espera', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 6 * 3600 * 1000 });
  const now = Date.now();
  const starved = { imdbId: 'tt3100001', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now - 7 * 3600 * 1000 };
  const brGap = { imdbId: 'tt3100002', type: 'movie', reason: 'br-gap', season: null, episode: null, enqueuedAt: now - 5 * 60 * 1000 };
  const out = harvestQueue.prioritizeQueue([starved, brGap] as any);
  assert.deepEqual(out.map((e: any) => e.imdbId), ['tt3100002', 'tt3100001'], 'br-gap recente acima do anti-fome');
  harvesterLive.reset();
});

test('Fase 5: flag off mantém next-episode > br-gap recente > regulares (FIFO entre regulares)', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: false });
  const now = Date.now();
  const popular = { imdbId: 'tt3100011', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now - 10 * 60 * 1000 };
  const brGap = { imdbId: 'tt3100012', type: 'movie', reason: 'br-gap', season: null, episode: null, enqueuedAt: now - 2 * 60 * 1000 };
  const next = { imdbId: 'tt3100013', type: 'series', reason: 'next-episode', season: 1, episode: 1, enqueuedAt: now - 60_000 };
  // Com a flag OFF a ordem ainda é next-episode > br-gap recente > regular,
  // independentemente do enqueuedAt (FIFO puro daria popular primeiro).
  assert.deepEqual(
    harvestQueue.prioritizeQueue([popular, brGap, next] as any).map((e: any) => e.imdbId),
    ['tt3100013', 'tt3100012', 'tt3100011'],
    'urgências incondicionais acima do tier regular',
  );
  // Entre regulares, FIFO por enqueuedAt.
  const regNova = { imdbId: 'tt3100015', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now };
  const regAntiga = { imdbId: 'tt3100016', type: 'movie', reason: 'miss', season: null, episode: null, enqueuedAt: now - 5 * 60 * 1000 };
  assert.deepEqual(
    harvestQueue.prioritizeQueue([regNova, regAntiga] as any).map((e: any) => e.imdbId),
    ['tt3100016', 'tt3100015'],
    'FIFO entre as regulares',
  );
  harvesterLive.reset();
});

test('Fase 5: next-episode não é rebaixado por um br-gap recente', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 6 * 3600 * 1000 });
  const now = Date.now();
  const next = { imdbId: 'tt3100021', type: 'series', reason: 'next-episode', season: 1, episode: 2, enqueuedAt: now - 2 * 3600 * 1000 };
  const brGap = { imdbId: 'tt3100022', type: 'movie', reason: 'br-gap', season: null, episode: null, enqueuedAt: now - 60_000 };
  assert.deepEqual(
    harvestQueue.prioritizeQueue([brGap, next] as any).map((e: any) => e.imdbId),
    ['tt3100021', 'tt3100022'],
    'next-episode (play real) acima do br-gap recente',
  );
  harvesterLive.reset();
});

test('Fase 5: br-gap fora da janela de 1h volta às regras normais/anti-fome', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 6 * 3600 * 1000 });
  const now = Date.now();
  const starved = { imdbId: 'tt3100031', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now - 7 * 3600 * 1000 };
  const oldBrGap = { imdbId: 'tt3100032', type: 'movie', reason: 'br-gap', season: null, episode: null, enqueuedAt: now - 2 * 3600 * 1000 };
  assert.deepEqual(
    harvestQueue.prioritizeQueue([oldBrGap, starved] as any).map((e: any) => e.imdbId),
    ['tt3100031', 'tt3100032'],
    'passada a janela, o anti-fome volta a decidir',
  );
  harvesterLive.reset();
});

test('Fase 5: miss na cauda (posição 60) promovido a br-gap sobe para a frente', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 0, harvestQueueMax: 100 });
    for (let i = 1; i <= 60; i += 1) {
      harvestQueue.enqueue({ imdbId: `tt33000${String(i).padStart(2, '0')}`, type: 'movie', reason: 'miss' });
    }
    const alvo = 'tt3300099';
    harvestQueue.enqueue({ imdbId: alvo, type: 'movie', reason: 'miss' });
    const antes = filaPersistida();
    assert.equal(antes[antes.length - 1].imdbId, alvo, 'o alvo começa na cauda');
    // A busca seguinte prova a lacuna BR: promoção (miss → br-gap), sem duplicar.
    harvestQueue.enqueue({ imdbId: alvo, type: 'movie', reason: 'br-gap' });
    const depois = filaPersistida();
    assert.equal(depois.length, antes.length, 'promoção não duplica a obra');
    assert.equal(depois[0].imdbId, alvo, 'br-gap recente vai para a frente da fila');
    assert.equal(depois[0].reason, 'br-gap');
  } finally {
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('Fase 5 (C9): promoção preserva enqueuedAt (anti-fome) e a janela do br-gap usa priorityAt', () => {
  harvesterLive.reset();
  try {
    harvestQueue.clearQueue();
    harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 6 * 3600 * 1000, harvestQueueMax: 100 });
    const imdb = 'tt3400001';
    harvestQueue.enqueue({ imdbId: imdb, type: 'movie', season: null, episode: null, reason: 'miss' });
    const antes = filaPersistida().find((e) => e.imdbId === imdb);
    const enqueuedAtAntes = antes.enqueuedAt;
    harvestQueue.enqueue({ imdbId: imdb, type: 'movie', season: null, episode: null, reason: 'br-gap' });
    const depois = filaPersistida().find((e) => e.imdbId === imdb);
    assert.equal(depois.enqueuedAt, enqueuedAtAntes, 'promoção NÃO reseta o enqueuedAt (fome preservada)');
    assert.ok(depois.priorityAt >= enqueuedAtAntes, 'priorityAt marca a janela própria do br-gap');
    assert.equal(depois.reason, 'br-gap');

    // Separação dos relógios: priorityAt recente mantém o tier br-gap...
    const now = Date.now();
    const starved = { imdbId: 'tt3400002', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now - 7 * 3600 * 1000 };
    const promoted = { imdbId: 'tt3400003', type: 'movie', reason: 'br-gap', season: null, episode: null, enqueuedAt: now - 7 * 3600 * 1000, priorityAt: now - 60_000 };
    assert.deepEqual(
      harvestQueue.prioritizeQueue([starved, promoted] as any).map((e: any) => e.imdbId),
      ['tt3400003', 'tt3400002'],
      'janela do br-gap (priorityAt) ainda ativa fura o starved',
    );
    // ...e passada a janela, a fome (enqueuedAt antigo) continua valendo — a
    // promoção não zerou o relógio do pedido original.
    const expired = { ...promoted, priorityAt: now - 2 * 3600 * 1000 };
    const fresh = { imdbId: 'tt3400004', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now };
    assert.deepEqual(
      harvestQueue.prioritizeQueue([fresh, expired, starved] as any).map((e: any) => e.imdbId),
      ['tt3400003', 'tt3400002', 'tt3400004'],
      'expirada a janela, o enqueuedAt antigo segue starved',
    );
  } finally {
    harvesterLive.reset();
    harvestQueue.clearQueue();
  }
});

test('Fase 5: cohort — urgentes recentes precedem o starved; ao envelhecer, o starved sobe', () => {
  harvesterLive.reset();
  harvesterLive.set({ harvestBrFirst: true, harvestBrMaxWaitMs: 6 * 3600 * 1000 });
  const now = Date.now();
  const starved = { imdbId: 'tt3200101', type: 'movie', reason: 'popular', season: null, episode: null, enqueuedAt: now - 7 * 3600 * 1000 };
  const next = { imdbId: 'tt3200102', type: 'series', reason: 'next-episode', season: 1, episode: 1, enqueuedAt: now - 60_000 };
  const brGap = { imdbId: 'tt3200103', type: 'movie', reason: 'br-gap', season: null, episode: null, enqueuedAt: now - 5 * 60 * 1000 };
  // Enquanto os urgentes são recentes, eles precedem o starved (que fica no tier
  // regular, apesar de >6h de espera).
  assert.deepEqual(
    harvestQueue.prioritizeQueue([starved, brGap, next] as any).map((e: any) => e.imdbId),
    ['tt3200102', 'tt3200103', 'tt3200101'],
    'urgências recentes acima do backlog starved',
  );
  // A janela de 1h do br-gap expira: ele cai para o tier regular e o starved
  // volta a subir; o next-episode segue no topo.
  const brGapVelho = { ...brGap, enqueuedAt: now - 2 * 3600 * 1000 };
  assert.deepEqual(
    harvestQueue.prioritizeQueue([brGapVelho, starved, next] as any).map((e: any) => e.imdbId),
    ['tt3200102', 'tt3200101', 'tt3200103'],
    'expirada a janela, o anti-fome volta a decidir',
  );
  harvesterLive.reset();
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
