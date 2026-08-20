import { test } from 'node:test';
import assert from 'node:assert/strict';

// Persistência desligada ANTES dos imports: as chaves deste arquivo são
// efêmeras e o data/cache.db real do repo não pode ser tocado. Em ESM os
// imports estáticos são hoisted; o cache (que abre o banco no load) entra
// por import dinâmico, depois desta linha.
process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const { getMeta } = await import('../src/utils/cinemeta.js');
const { getTitles } = await import('../src/utils/tmdb.js');

// Conta quantas vezes cada API externa foi consultada. É o cerne desta suíte:
// cache negativo e coalescing existem para essas contagens ficarem em 1.
function stubFetch(handler) {
  const calls = { cinemeta: 0, tmdb: 0, other: 0 };
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const urlStr = String(url);
    if (urlStr.includes('v3-cinemeta.strem.io')) calls.cinemeta += 1;
    else if (urlStr.includes('api.themoviedb.org')) calls.tmdb += 1;
    else calls.other += 1;
    return handler(urlStr, options);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('miss cacheado: buscas repetidas do mesmo id desconhecido disparam UM fetch por API', async () => {
  const originalKey = config.tmdb.apiKey;
  const originalMissCinemeta = config.cinemeta.missTtl;
  const originalMissTmdb = config.tmdb.missTtl;
  const imdbId = `tt-desconhecido-${process.pid}-${Date.now()}`;
  const keys = [`meta:movie:${imdbId}`, `tmdb:${imdbId}`];

  config.tmdb.apiKey = 'test-key';
  config.cinemeta.missTtl = 300;
  config.tmdb.missTtl = 300;

  // Ambas as APIs respondem "não conheço" (404 no Cinemeta, listas vazias no TMDB).
  const stub = stubFetch((url) => {
    if (url.includes('v3-cinemeta.strem.io')) return { ok: false, status: 404, json: async () => ({}) };
    return okJson({ movie_results: [], tv_results: [] });
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await getMeta('movie', imdbId), null);
      assert.equal(await getTitles(imdbId), null);
    }
    assert.equal(stub.calls.cinemeta, 1, 'só a primeira busca vai ao Cinemeta');
    assert.equal(stub.calls.tmdb, 1, 'só a primeira busca vai ao TMDB');
  } finally {
    stub.restore();
    keys.forEach((key) => cache.forget(key));
    config.tmdb.apiKey = originalKey;
    config.cinemeta.missTtl = originalMissCinemeta;
    config.tmdb.missTtl = originalMissTmdb;
  }
});

test('coalescing: getMeta concorrentes do mesmo id compartilham a mesma promise', async () => {
  const imdbId = `tt-coalesce-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;

  // O fetch só resolve no próximo tick: sem coalescing, as 5 chamadas
  // disparadas no mesmo instante criariam 5 requisições.
  const stub = stubFetch(() =>
    new Promise((resolve) => {
      setImmediate(() =>
        resolve(okJson({ meta: { name: 'Concorrente', year: '2025', type: 'movie' } })),
      );
    }),
  );
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getMeta('movie', imdbId)),
    );
    for (const meta of results) {
      assert.deepEqual(meta, { name: 'Concorrente', year: '2025', type: 'movie' });
    }
    assert.equal(stub.calls.cinemeta, 1, 'as 5 buscas concorrentes viram 1 fetch');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});

test('coalescing cobre também o TMDB e libera a chave depois de resolver', async () => {
  const originalKey = config.tmdb.apiKey;
  config.tmdb.apiKey = 'test-key';
  const imdbId = `tt-coalesce-tmdb-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;

  const stub = stubFetch(() =>
    new Promise((resolve) => {
      setImmediate(() =>
        resolve(okJson({ movie_results: [{ title: 'T', original_title: 'T', release_date: '2025-01-01' }], tv_results: [] })),
      );
    }),
  );
  try {
    const [a, b] = await Promise.all([getTitles(imdbId), getTitles(imdbId)]);
    assert.deepEqual(a, b);
    assert.equal(stub.calls.tmdb, 1);

    // A chave sai do inFlight no finally: com o cache positivo já gravado,
    // uma nova chamada não recria a promise nem volta à rede.
    const again = await getTitles(imdbId);
    assert.deepEqual(again, a);
    assert.equal(stub.calls.tmdb, 1);
  } finally {
    stub.restore();
    cache.forget(key);
    config.tmdb.apiKey = originalKey;
  }
});

test('miss expirado volta a perguntar (forget simula o fim do TTL)', async () => {
  const imdbId = `tt-expira-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;
  const stub = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  try {
    assert.equal(await getMeta('movie', imdbId), null);
    assert.deepEqual(cache.get(key), { miss: true });
    assert.equal(await getMeta('movie', imdbId), null);
    assert.equal(stub.calls.cinemeta, 1, 'dentro do TTL o miss segura a rede');

    // O TTL venceu (aqui simulado pelo forget que o cache faria sozinho).
    cache.forget(key);
    assert.equal(await getMeta('movie', imdbId), null);
    assert.equal(stub.calls.cinemeta, 2, 'miss expirado volta à API');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});

test('falha transitória degrada sem derrubar e se resolve quando o miss expira', async () => {
  const imdbId = `tt-transitoria-${process.pid}-${Date.now()}`;
  const key = `meta:movie:${imdbId}`;

  // Primeiro acesso: rede morta. Depois que o miss expira, a API responde.
  let attempt = 0;
  const stub = stubFetch(() => {
    attempt += 1;
    if (attempt === 1) throw new Error('ECONNRESET');
    return okJson({ meta: { name: 'Recuperado', year: '2026', type: 'movie' } });
  });
  try {
    // Degrada para null — quem chama segue a busca sem metadados.
    assert.equal(await getMeta('movie', imdbId), null);

    cache.forget(key); // TTL do miss venceu
    const meta = await getMeta('movie', imdbId);
    assert.deepEqual(meta, { name: 'Recuperado', year: '2026', type: 'movie' });

    // O sucesso substituiu o sentinela: próxima chamada vem do cache positivo.
    assert.deepEqual(await getMeta('movie', imdbId), meta);
    assert.equal(stub.calls.cinemeta, 2);
  } finally {
    stub.restore();
    cache.forget(key);
  }
});