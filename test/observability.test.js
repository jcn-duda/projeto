const { test } = require('node:test');
const assert = require('node:assert/strict');

const log = require('../src/utils/logger');
const metrics = require('../src/utils/metrics');

/** Captura o que o logger escreveria de verdade. */
function capture(fn) {
  const lines = { log: [], warn: [], error: [] };
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

  assert.deepEqual(metrics.snapshot().timers.x, {
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
  assert.equal(metrics.snapshot().timers.trecho.count, 1);
});
