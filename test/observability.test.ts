import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from '../src/utils/logger.js';
import * as metrics from '../src/utils/metrics.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { getMeta } from '../src/utils/cinemeta.js';
import { getTitles } from '../src/utils/tmdb.js';
import {
  applyDebrid, buildStreams, firstObserverStep, createFirstObserver,
  firstObserverClaim, promoteFirstObserverEligible,
} from '../src/providers/index.js';
import { stageFirstTiming } from '../src/providers/stream-builder.js';
import { limitReservingBr } from '../src/utils/format.js';

// Os contadores de degradação passam pelo cache de metadados; persistência
// desligada para não tocar o data/cache.db real.
process.env.CACHE_PERSIST = 'false';

const CACHED_H = 'c'.repeat(40);
const UNKNOWN_H = 'u'.repeat(40);
// Mesmo hash de CACHED_H, em caixa MISTA: o helper normaliza o lote de cache
// para lowercase antes de casar com o infoHash (já normalizado do stream).
const CACHED_MIXED = 'C'.repeat(20) + 'c'.repeat(20);

/** Forma do timer no snapshot: p50/p95 da janela podem faltar em silencio. */
type TimerSample = { count: number; avgMs: number; p50Ms: number | null; p95Ms: number | null; maxMs: number };

/** Captura o que o logger escreveria de verdade. */
function capture(fn: any) {
  const lines: { log: string[]; warn: string[]; error: string[] } = { log: [], warn: [], error: [] };
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.log.push(args.join(' '));
  console.warn = (...args) => lines.warn.push(args.join(' '));
  console.error = (...args) => lines.error.push(args.join(' '));
  try {
    fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

test('o nível corta o que está abaixo dele e mantém o resto', () => {
  const original = log.level();
  try {
    log.setLevel('warn');
    const lines = capture(() => {
      log.error('[x] erro');
      log.warn('[x] aviso');
      log.info('[x] info');
      log.debug('[x] debug');
    });

    assert.deepEqual(lines.error, ['[x] erro']);
    assert.deepEqual(lines.warn, ['[x] aviso']);
    assert.deepEqual(lines.log, [], 'info e debug ficam de fora em warn');
  } finally {
    log.setLevel(original);
  }
});

test('debug só sai no nível debug; silent não deixa passar nada', () => {
  const original = log.level();
  try {
    log.setLevel('debug');
    assert.deepEqual(capture(() => log.debug('[x] por requisição')).log, ['[x] por requisição']);

    log.setLevel('silent');
    const mudo = capture(() => {
      log.error('[x] erro');
      log.warn('[x] aviso');
      log.info('[x] info');
    });
    assert.deepEqual([mudo.error, mudo.warn, mudo.log], [[], [], []]);
  } finally {
    log.setLevel(original);
  }
});

test('nível inválido avisa uma vez e cai no info em vez de silenciar tudo', () => {
  const original = log.level();
  try {
    const lines = capture(() => log.setLevel('verboso-demais'));

    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0], /ADDON_LOG_LEVEL desconhecido/);
    // O risco de errar para o lado errado é o operador achar que configurou o
    // log e ficar sem nenhum.
    assert.equal(log.level(), 'info');
  } finally {
    log.setLevel(original);
  }
});

test('contadores somam e aparecem ordenados no snapshot', () => {
  metrics.reset();
  metrics.count('cache.hit');
  metrics.count('cache.hit');
  metrics.count('cache.miss', 3);

  const snap = metrics.snapshot();
  assert.deepEqual(snap.counters, { 'cache.hit': 2, 'cache.miss': 3 });
  assert.equal(typeof snap.uptimeS, 'number');
});

test('percentis vêm da janela, e a janela não cresce com o uso', () => {
  metrics.reset();
  // Mais amostras que o reservatório (256): as primeiras saem da janela, mas
  // count/max continuam sendo da vida inteira do processo.
  for (let i = 1; i <= 400; i += 1) metrics.observe('indexer.teste', i);

  const timer = metrics.snapshot().timers['indexer.teste'];
  assert.equal(timer.count, 400);
  assert.equal(timer.maxMs, 400);
  // A janela guarda 145..400; a mediana dela fica bem acima da mediana total.
  assert.ok(timer.p50Ms > 200, `p50 da janela deveria refletir o final da série, veio ${timer.p50Ms}`);
  assert.ok(timer.p95Ms >= timer.p50Ms);
});

test('medição inválida é ignorada em vez de virar NaN no snapshot', () => {
  metrics.reset();
  metrics.observe('x', Number.NaN);
  metrics.observe('x', undefined);
  metrics.observe('x', 10);

  assert.deepEqual((metrics.snapshot().timers as Record<string, TimerSample>).x, {
    count: 1,
    avgMs: 10,
    p50Ms: 10,
    p95Ms: 10,
    maxMs: 10,
  });
});

test('timed devolve a duração e registra a amostra', () => {
  metrics.reset();
  const done = metrics.timed('trecho');
  const ms = done();

  assert.equal(typeof ms, 'number');
  assert.equal((metrics.snapshot().timers as Record<string, TimerSample>).trecho.count, 1);
});

// Contadores de degradação: são o único jeito de ver no /metrics.json que a
// instância está pagando custo de rede evitável ou rodando às cegas no debrid.

test('miss servido do cache conta meta.cinemeta.miss.served', async () => {
  metrics.reset();
  const imdbId = `tt-obs-cinemeta-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof globalThis.fetch;
  try {
    await getMeta('movie', imdbId); // grava o sentinela
    await getMeta('movie', imdbId); // servido do miss
    await getMeta('movie', imdbId); // de novo
    assert.equal(metrics.snapshot().counters['meta.cinemeta.miss.served'], 2);
  } finally {
    global.fetch = originalFetch;
    cache.forget(key);
  }
});

test('miss servido do cache conta meta.tmdb.miss.served', async () => {
  metrics.reset();
  const originalKey = config.tmdb.apiKey;
  config.tmdb.apiKey = 'test-key';
  const imdbId = `tt-obs-tmdb-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ movie_results: [], tv_results: [] }),
  })) as unknown as typeof globalThis.fetch;
  try {
    await getTitles(imdbId);
    await getTitles(imdbId);
    assert.equal(metrics.snapshot().counters['meta.tmdb.miss.served'], 1);
  } finally {
    global.fetch = originalFetch;
    cache.forget(key);
    config.tmdb.apiKey = originalKey;
  }
});

test('checagem de cache sem resposta confiável conta debrid.check.unknown', async () => {
  metrics.reset();
  // cacheCheck: false é o caso Real-Debrid/Debrid-Link: known vira false e o
  // fluxo inteiro segue às cegas — o contador é o que denuncia isso.
  const fake = {
    id: 'fakeobs',
    label: 'FakeObs',
    short: 'FO',
    cacheCheck: false,
    checkCached: async () => new Set(),
    resolveLink: async () => null,
  };
  debrid.BY_ID.set(fake.id, fake as any);
  const originalSecret = config.debrid.resolveSecret;
  config.debrid.resolveSecret = '';
  try {
    const userOpts = runtime.decode(runtime.encode({ ds: fake.id, dk: 'obs-key' }));
    await runtime.run({ opts: userOpts, encoded: '' }, async () => {
      const streams = [{ infoHash: 'c'.repeat(40), title: 'Filme X', name: 'n', _seeders: 3 }];
      const out = await applyDebrid(streams, {
        season: null,
        episode: null,
        searchKey: 'obs-test',
        deadlineAt: null,
      } as any);
      assert.equal(out.length, 1);
      assert.ok(out[0]?.url?.includes('/resolve/'), 'sem resposta, tudo vai pelo debrid');
    });
    assert.equal(metrics.snapshot().counters['debrid.check.unknown'], 1);
  } finally {
    debrid.BY_ID.delete(fake.id);
    config.debrid.resolveSecret = originalSecret;
  }
});

// I0 — observabilidade da primeira resposta BR (FRIA). O `observeFirstPass`
// explícito marca a passada reclamada; `deadlineAt` sozinho (refresh SWR, que
// passa o prazo mas roda em background) não basta. O `brFound` agora mora no
// funil do buildStreams; no corte do debrid ficam brCached/brHidden (estagiados
// no estado para a finalização coerente) e o aviso do cachedOnly — que vale em
// TODO passe, inclusive nos tardios.
test('applyDebrid estagia brCached/brHidden (hash de cache em caixa mista) e avisa BR oculto; NÃO conta brFound', async () => {
  metrics.reset();
  const originalSecret = config.debrid.resolveSecret;
  const fake = {
    id: 'fakeobs',
    label: 'FakeObs',
    short: 'FO',
    cacheCheck: true,
    checkCached: async () => new Set([CACHED_MIXED]), // hash EM CAIXA MISTA no lote
    resolveLink: async () => null,
  };
  debrid.BY_ID.set(fake.id, fake as any);
  config.debrid.resolveSecret = '';
  const userOpts = runtime.decode(runtime.encode({ ds: fake.id, dk: 'obs-key', dc: true, bu: false }));
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const streams = [
      { infoHash: CACHED_H, title: 'Filme BR Cacheado', name: 'n', _br: true, _seeders: 1 },
      { infoHash: UNKNOWN_H, title: 'Filme BR Frio', name: 'n', _br: true, _seeders: 1 },
    ];
    const state = createFirstObserver(true);
    await runtime.run({ opts: userOpts, encoded: '' }, () =>
      applyDebrid(streams as any, { deadlineAt: Date.now() + 5000, observeFirstPass: true, firstObserver: state } as any),
    );
    const counts = metrics.snapshot().counters;
    // brFound saiu do debrid (funil do buildStreams); não é contado aqui.
    assert.equal(counts['search.first.brFound'], undefined, 'brFound não é contado no debrid');
    // O hash do cache em caixa mista foi normalizado para lowercase: o BR
    // cacheado casa e o frio é ocultado.
    assert.equal(state.pendingBrCached, 1, 'normaliza cache para lowercase e casa o BR cacheado');
    assert.equal(state.pendingBrHidden, 1, 'o BR frio foi ocultado pelo cachedOnly');

    // O aviso aponta o switch — o problema é config, não ausência de acervo.
    const hiddenWarn = warns.find((line) => line.includes('ocultada(s) pelo cachedOnly'));
    assert.ok(hiddenWarn, 'o corte de BR fora do cache loga aviso distinto');
    assert.match(hiddenWarn, /Mostrar BR ainda fora do cache/);
  } finally {
    console.warn = realWarn;
    debrid.BY_ID.delete(fake.id);
    config.debrid.resolveSecret = originalSecret;
    metrics.reset();
  }
});

test('observability: deadlineAt presente SEM observeFirstPass (refresh SWR) NÃO estagia nem conta', async () => {
  metrics.reset();
  const fake = {
    id: 'fakeobs2',
    label: 'FakeObs2',
    short: 'FO2',
    cacheCheck: true,
    checkCached: async () => new Set(),
    resolveLink: async () => null,
  };
  debrid.BY_ID.set(fake.id, fake as any);
  const originalSecret = config.debrid.resolveSecret;
  config.debrid.resolveSecret = '';
  try {
    const userOpts = runtime.decode(runtime.encode({ ds: fake.id, dk: 'obs-late', dc: true, bu: false }));
    const state = createFirstObserver(true);
    await runtime.run({ opts: userOpts, encoded: '' }, async () => {
      // SWR/background passam `deadlineAt` (o refresh usa o orçamento completo)
      // mas NÃO são observáveis: o gate é o `observeFirstPass` da passada
      // reclamada, não o prazo.
      await applyDebrid([{ infoHash: UNKNOWN_H, title: 'Filme BR', _br: true }] as any, {
        deadlineAt: Date.now() + 5000,
        observeFirstPass: false,
        firstObserver: state,
      } as any);
    });
    // A pergunta que o search.first.* responde é a da PRIMEIRA resposta — não
    // pode ser inflada por refresh/recache que só regravam o cache.
    assert.equal(metrics.snapshot().counters['search.first.brFound'], undefined, 'refresh SWR não conta search.first.brFound');
    assert.equal(metrics.snapshot().counters['search.first.responses'], undefined, 'refresh SWR não conta o denominador');
    assert.equal(state.pendingBrHidden, 0, 'sem observeFirstPass nada é estagiado no estado');
  } finally {
    debrid.BY_ID.delete(fake.id);
    config.debrid.resolveSecret = originalSecret;
    metrics.reset();
  }
});

test('limitReservingBr observa os BR selecionados ANTES de limpar os campos internos', () => {
  metrics.reset();
  const brStream = { name: 'Filme BR', infoHash: 'a'.repeat(40), _br: true, _seeders: 1, _quality: '1080p' };
  const global1 = { name: 'G1', infoHash: 'b'.repeat(40) };
  const global2 = { name: 'G2', infoHash: 'c'.repeat(40) };
  let observed: any[] | undefined;
  const out = limitReservingBr([global1, global2, brStream] as any, {
    brReservedSlots: 1,
    maxResults: 3,
    brFirst: true,
    onSelected: (sel) => { observed = sel; },
  });
  // O callback recebe os selecionados AINDA com `_br` — é isso que permite medir
  // quantas fontes BR realmente serão entregues.
  assert.ok(observed, 'callback é chamado com os selecionados');
  assert.ok(observed!.some((s) => s._br === true), 'callback vê o campo interno _br antes da limpeza');
  assert.ok(observed!.some((s) => s.name === 'Filme BR'), 'o BR reservado está entre os observados');
  // E a saída pública não expõe o campo interno (contrato preservado).
  assert.ok(out.some((s: any) => s.name === 'Filme BR'), 'o BR segue na lista final');
  assert.equal((out.find((s: any) => s.name === 'Filme BR') as any)?._br, undefined, 'saída não expõe _br');
});

test('firstObserverStep: passe tardio antes do first não reclama nem conta; Alita dá delta 3; repetição zero', () => {
  const s = createFirstObserver(true);

  // Recache tardio enquanto o first ainda está em voo (primeira não confirmou):
  // não pode reclamar nem contar — flags first/late ambos ausentes no correr.
  let step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: false, brVisible: 3 });
  assert.equal(step.kind, 'none', 'tardio antes do first confirmar não é nada');
  assert.equal(step.delta, 0, 'e não conta delta');
  // Mesmo que um chamador passasse observeLatePass por engano, sem firstCounted
  // não conta (a guarda é o estado, não o flag).
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 3 });
  assert.equal(step.kind, 'none', 'observeLatePass sem firstCounted não conta');

  // Primeira passada reclamada: first (Alita com 1 BR visível).
  step = firstObserverStep(s, { observeFirstPass: true, observeLatePass: false, brVisible: 1 });
  assert.equal(step.kind, 'first', 'passada reclamada e ainda não contada é first');
  assert.equal(step.delta, 1);
  s.firstCounted = true;
  s.maxBrVisible = 1;

  // Recache tardio sobe para 4: delta é 4 - 1 = 3, nunca 4.
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 4 });
  assert.equal(step.kind, 'late');
  assert.equal(step.delta, 3, 'Alita: first=1 e late=4 geram delta 3');
  s.maxBrVisible = 4;

  // Repetição em 4: delta 0 — nunca re-cobra o total.
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 4 });
  assert.equal(step.delta, 0, 'repetição em 4 não conta nada');

  // Queda para 2: delta 0 (máximo já visto era 4).
  step = firstObserverStep(s, { observeFirstPass: false, observeLatePass: true, brVisible: 2 });
  assert.equal(step.delta, 0, 'recache abaixo do máximo não conta nada');
});

test('firstObserverStep ignora execução não elegível (SWR/background) mesmo com flags', () => {
  const s = createFirstObserver(false);
  const step = firstObserverStep(s, { observeFirstPass: true, observeLatePass: false, brVisible: 5 });
  assert.equal(step.kind, 'none');
  assert.equal(step.delta, 0);
});

test('stageFirstTiming seta passos únicos, acumula coletas e ignora valor inválido/recache', () => {
  const state = createFirstObserver(true);
  stageFirstTiming(state, 'metadata', 100);
  stageFirstTiming(state, 'metadata', 80);
  stageFirstTiming(state, 'debrid', 30);
  stageFirstTiming(state, 'debrid', 20);
  stageFirstTiming(state, 'global', 40);
  stageFirstTiming(state, 'global', 10);
  stageFirstTiming(state, 'br', 7);
  stageFirstTiming(state, 'br', 3);

  assert.equal(state.pendingMetadata, 80);
  assert.equal(state.pendingDebrid, 20);
  assert.equal(state.pendingGlobal, 50);
  assert.equal(state.pendingBr, 10);

  stageFirstTiming(state, 'metadata', Number.NaN);
  stageFirstTiming(state, 'global', -1);
  state.firstCounted = true;
  stageFirstTiming(state, 'br', 999);
  assert.equal(state.pendingMetadata, 80, 'NaN não substitui valor válido');
  assert.equal(state.pendingGlobal, 50, 'negativo não entra no acumulado');
  assert.equal(state.pendingBr, 10, 'recache após firstCounted não altera estágio');
});

test('buildStreams finaliza search.first.* da primeira build fria de forma coerente (responses/brFound/brVisible)', async () => {
  metrics.reset();
  const originalSecret = config.debrid.resolveSecret;
  config.debrid.resolveSecret = '';
  const fake = {
    id: 'fakefunnel',
    label: 'FakeFunnel',
    short: 'FF',
    cacheCheck: true,
    checkCached: async () => new Set(),
    resolveLink: async () => null,
  };
  debrid.BY_ID.set(fake.id, fake as any);
  const originalCheck = debrid.checkCached;
  debrid.checkCached = async () => ({ cached: new Set<string>(), known: true }) as any;
  try {
    const raw = [
      // BR (vira _br no toStremioStream) e global — mede o funil e a entrega.
      { title: 'Filme BR', infoHash: 'a'.repeat(40), isBr: true, seeders: 1, dubbed: true },
      { title: 'Global', infoHash: 'b'.repeat(40), isBr: false, seeders: 50 },
    ];
    const state = createFirstObserver(true);
    state.timingStartedAt = Date.now() - 500;
    stageFirstTiming(state, 'metadata', 7);
    stageFirstTiming(state, 'global', 100);
    stageFirstTiming(state, 'global', 200);
    stageFirstTiming(state, 'br', 40);
    stageFirstTiming(state, 'br', 10);
    const userOpts = runtime.decode(runtime.encode({ ds: fake.id, dk: 'obs-funnel', dc: false }));
    await runtime.run({ opts: userOpts, encoded: '' }, () =>
      buildStreams(raw as any, {
        imdbId: 'tt0000001',
        searchKey: 'obs-funnel-key',
        deadlineAt: Date.now() + 8000,
        observeFirstPass: true,
        observeLatePass: false,
        firstObserver: state,
      } as any),
    );
    const counts = metrics.snapshot().counters;
    assert.equal(counts['search.first.responses'], 1, 'uma primeira build fria concluída dentro do prazo');
    assert.equal(counts['search.first.brFound'], 1, 'brFound conta a fonte BR que entrou no funil (pré-debrid)');
    assert.equal(counts['search.first.brVisible'], 1, 'brVisible conta a fonte BR entregue na abertura');
    assert.equal(state.firstCounted, true, 'a build finaliza como primeira resposta contada');
    const timers = metrics.snapshot().timers;
    assert.equal(timers['search.first.metadata']?.count, 1);
    assert.equal(timers['search.first.metadata']?.maxMs, 7);
    assert.equal(timers['search.first.collect.global']?.maxMs, 300);
    assert.equal(timers['search.first.collect.br']?.maxMs, 50);
    assert.equal(timers['search.first.debrid']?.count, 1);
    assert.equal(timers['search.first.total']?.count, 1);
    assert.ok((timers['search.first.total']?.maxMs ?? -1) >= 500);
  } finally {
    debrid.BY_ID.delete(fake.id);
    debrid.checkCached = originalCheck;
    config.debrid.resolveSecret = originalSecret;
    metrics.reset();
  }
});

test('firstObserverClaim: só a primeira tentativa com deadline reclama; late antes do first não observa', () => {
  const s = createFirstObserver(true);

  // Primeiro finish com deadline: reclama first.
  let r = firstObserverClaim(s, true);
  assert.equal(r.observeFirstPass, true, 'primeira passada com deadline reclama o first');
  assert.equal(r.observeLatePass, false);
  assert.equal(s.firstClaimed, true, 'o claim é mutado sync');

  // Segundo finish também com deadline (recache com prazo): NÃO reclama de novo.
  r = firstObserverClaim(s, true);
  assert.equal(r.observeFirstPass, false, 'segunda passada com deadline não re-reclama');
  assert.equal(r.observeLatePass, false, 'e ainda não é late (first não confirmou)');

  // Recache sem deadline enquanto o first está em voo: não observa nada.
  r = firstObserverClaim(s, false);
  assert.equal(r.observeFirstPass, false);
  assert.equal(r.observeLatePass, false, 'late antes de firstCounted não observa');
});

test('firstObserverClaim: após firstCounted, sem deadline vira late', () => {
  const s = createFirstObserver(true);
  firstObserverClaim(s, true); // reclama o first
  s.firstCounted = true;       // first CONCLUIU

  const r = firstObserverClaim(s, false);
  assert.equal(r.observeFirstPass, false);
  assert.equal(r.observeLatePass, true, 'recache tardio após firstConfirmado observa');
});

test('promoteFirstObserverEligible: foreground promove false→true sem mexer em firstClaimed/contadores', () => {
  metrics.reset();
  const s = createFirstObserver(false);
  s.firstClaimed = true; // já reclamado por outro caminho — não pode mudar
  const snapshotBefore = metrics.snapshot().counters['stream.coalesced'];

  promoteFirstObserverEligible(s, true); // prefetch→foreground (busca real assumindo)
  assert.equal(s.eligible, true, 'foreground promove elegibilidade');
  assert.equal(s.firstClaimed, true, 'não mexe no firstClaimed');

  // Foreground→background (no-op): não rebaixa quem já foi promovido.
  promoteFirstObserverEligible(s, false);
  assert.equal(s.eligible, true, 'background não desce elegibilidade já promovida');

  assert.equal(metrics.snapshot().counters['stream.coalesced'], snapshotBefore, 'helper não toca contadores');
});

test('buildStreams com deadline já expirado: NÃO conta search.first.* e firstCounted segue false', async () => {
  metrics.reset();
  const originalSecret = config.debrid.resolveSecret;
  config.debrid.resolveSecret = '';
  const fake = {
    id: 'fakeexp',
    label: 'FakeExp',
    short: 'FE',
    cacheCheck: true,
    checkCached: async () => new Set(),
    resolveLink: async () => null,
  };
  debrid.BY_ID.set(fake.id, fake as any);
  const originalCheck = debrid.checkCached;
  debrid.checkCached = async () => ({ cached: new Set<string>(), known: true }) as any;
  try {
    const raw = [
      { title: 'Filme BR', infoHash: 'a'.repeat(40), isBr: true, seeders: 1, dubbed: true },
    ];
    const state = createFirstObserver(true);
    stageFirstTiming(state, 'metadata', 150);
    stageFirstTiming(state, 'global', 250);
    stageFirstTiming(state, 'br', 60);
    stageFirstTiming(state, 'debrid', 25);
    const userOpts = runtime.decode(runtime.encode({ ds: fake.id, dk: 'obs-exp', dc: false }));
    await runtime.run({ opts: userOpts, encoded: '' }, () =>
      buildStreams(raw as any, {
        imdbId: 'tt0000001',
        searchKey: 'obs-exp-key',
        // deadline já no passado: a build concluiu FORA do prazo — o cliente já
        // recebeu o corte do raceWithDeadline e `search.deadline` mede o caso.
        deadlineAt: Date.now() - 5000,
        observeFirstPass: true,
        observeLatePass: false,
        firstObserver: state,
      } as any),
    );
    const counts = metrics.snapshot().counters;
    assert.equal(counts['search.first.responses'], undefined, 'build expirada não conta o denominador');
    assert.equal(counts['search.first.brFound'], undefined, 'build expirada não conta brFound');
    assert.equal(counts['search.first.brVisible'], undefined, 'build expirada não conta brVisible');
    assert.equal(state.firstCounted, false, 'firstCounted fica false (nada foi contado)');
    const timers = metrics.snapshot().timers;
    for (const name of [
      'search.first.metadata',
      'search.first.collect.global',
      'search.first.collect.br',
      'search.first.debrid',
      'search.first.total',
    ]) {
      assert.equal(timers[name], undefined, `${name} não pode existir após deadline expirado`);
    }
  } finally {
    debrid.BY_ID.delete(fake.id);
    debrid.checkCached = originalCheck;
    config.debrid.resolveSecret = originalSecret;
    metrics.reset();
  }
});


// ---------------------------------------------------------------------------
// Fase 3.1 � gauge (estado atual): sobrescreve, pode cair, snapshot ordenado e
// reset limpa. Isso � a base das m�tricas `f3.br.*` do baseline de cobertura.
// ---------------------------------------------------------------------------

test('gauge publica NIVEL, sobrescreve (pode cair) e o snapshot � ordenado', () => {
  metrics.reset();
  metrics.gauge('f3.br.popular.cached', 5);
  metrics.gauge('f3.br.popular.cached', 2); // n�vel cai: pode voltar a baixo
  assert.equal(metrics.snapshot().gauges['f3.br.popular.cached'], 2, 'gauge � estado atual, sobrescreve');

  metrics.gauge('c2', 1);
  metrics.gauge('a1', 2);
  metrics.gauge('ignorado', Number.NaN);
  // O snapshot entrega os gauges SEMPRE ordenados para o painel n�o depender
  // da ordem de escrita.
  assert.deepEqual(Object.keys(metrics.snapshot().gauges), ['a1', 'c2', 'f3.br.popular.cached']);
});

test('gauge n�o participa dos contadores nem dos timers (espa�o separado)', () => {
  metrics.reset();
  metrics.gauge('soco', 1);
  metrics.count('soco'); // mesmo nome em outro espa�o n�o se confunde
  metrics.observe('soco', 12);
  const snap = metrics.snapshot();
  assert.equal(snap.counters['soco'], 1);
  assert.equal(snap.gauges['soco'], 1);
  assert.equal(snap.timers['soco']?.count, 1);
});

test('metrics.reset limpa contadores, gauges e timers', () => {
  metrics.reset();
  metrics.count('a', 3);
  metrics.gauge('b', 2);
  metrics.observe('c', 5);
  metrics.reset();
  const snap = metrics.snapshot();
  assert.deepEqual(snap.counters, {});
  assert.deepEqual(snap.gauges, {});
  assert.deepEqual(snap.timers, {});
});
