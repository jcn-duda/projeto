// Rodada 2: checagem ligada; os dublês usam test/helpers/stub.ts.
import { test } from 'node:test';
import assert from 'node:assert';

// Persistência desligada ANTES dos imports: este arquivo grava chaves de
// teste no cache e o data/cache.db real do repo não pode ser tocado. Em ESM
// os imports estáticos são hoisted (o cache abre o banco no load), então os
// módulos entram por import dinâmico depois desta linha.
process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const { getTitles } = await import('../src/utils/tmdb.js');
const { stubFetch } = await import('./helpers/stub.js');

// O .env pode não ter TMDB_API_KEY (aí getTitles devolve null sem rede), então
// cada teste arma a própria chave e restaura no final.
function withTmdbKey(fn: any) {
  return async () => {
    const originalKey = config.tmdb.apiKey;
    const originalMissTtl = config.tmdb.missTtl;
    const originalTransient = config.tmdb.transientMissTtl;
    config.tmdb.apiKey = 'test-tmdb-key';
    config.tmdb.missTtl = 300;
    config.tmdb.transientMissTtl = 300;
    try {
      await fn();
    } finally {
      config.tmdb.apiKey = originalKey;
      config.tmdb.missTtl = originalMissTtl;
      config.tmdb.transientMissTtl = originalTransient;
    }
  };
}

// O getTitles só consome ok/status/json do fetch; o objeto parcial é o
// contrato do dublê (helpers/stub.ts).
const tmdbOk = (body: any) => ({ ok: true, status: 200, json: async () => body });

test('getTitles resolve pt/original/year para filme e grava no cache', withTmdbKey(async () => {
  const imdbId = `tt-movie-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() =>
    tmdbOk({
      movie_results: [
        { title: 'Coringa', original_title: 'Joker', release_date: '2019-10-04' },
      ],
      tv_results: [],
    }),
  );
  try {
    const titles = await getTitles(imdbId);
    assert.deepEqual(titles, { pt: 'Coringa', original: 'Joker', year: '2019' });

    // A query precisa viajar em pt-BR e com o imdb id certo, senão o título
    // português nunca vem.
    assert.ok(stub.calls[0].url.includes(`api.themoviedb.org/3/find/${imdbId}`));
    assert.ok(stub.calls[0].url.includes('api_key=test-tmdb-key'));
    assert.ok(stub.calls[0].url.includes('external_source=imdb_id'));
    assert.ok(stub.calls[0].url.includes('language=pt-BR'));

    // Segunda chamada vem do cache positivo: a rede não é repetida.
    const again = await getTitles(imdbId);
    assert.deepEqual(again, titles);
    assert.equal(stub.calls.length, 1, 'o segundo getTitles não pode bater na API');
    assert.deepEqual(cache.get(key), titles);
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles usa tv_results (name/original_name/first_air_date) para série', withTmdbKey(async () => {
  const imdbId = `tt-series-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() =>
    tmdbOk({
      movie_results: [],
      tv_results: [
        { name: 'Fallout', original_name: 'Fallout', first_air_date: '2024-04-10' },
      ],
    }),
  );
  try {
    const titles = await getTitles(imdbId);
    assert.deepEqual(titles, { pt: 'Fallout', original: 'Fallout', year: '2024' });
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles sem resultado cacheia o miss e não repete a busca', withTmdbKey(async () => {
  const imdbId = `tt-miss-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() => tmdbOk({ movie_results: [], tv_results: [] }));
  try {
    assert.equal(await getTitles(imdbId), null);
    // O sentinela de miss é o que impede pagar os 5s de timeout a cada busca.
    assert.deepEqual(cache.get(key), { miss: true });

    assert.equal(await getTitles(imdbId), null);
    assert.equal(stub.calls.length, 1, 'o miss cacheado evita a segunda chamada');
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles com HTTP de erro degrada para null e cacheia miss transitório', withTmdbKey(async () => {
  const imdbId = `tt-http-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
  try {
    assert.equal(await getTitles(imdbId), null);
    assert.deepEqual(cache.get(key), { miss: true });
    assert.equal(await getTitles(imdbId), null);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles com falha de rede degrada para null sem derrubar quem chama', withTmdbKey(async () => {
  const imdbId = `tt-net-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() => {
    throw new Error('fetch failed');
  });
  try {
    assert.equal(await getTitles(imdbId), null);
    // Miss transitório entra no cache negativo — sem isso o mesmo id morto
    // seria reconsultado em todas as buscas até o erro passar.
    assert.deepEqual(cache.get(key), { miss: true });
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('falha transitória expira no transientMissTtl e a busca seguinte consulta novamente', withTmdbKey(async () => {
  // A regressão real do br: UM `[tmdb] fetch failed` isolado congelava o
  // título pt-BR por missTtl (300s) inteiro — nessa janela os indexadores BR
  // eram consultados em inglês e devolviam 0 post. O miss transitório
  // expira rápido e a próxima busca consulta novamente a API.
  const imdbId = `tt-transient-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  let fetches = 0;
  const stub = stubFetch(() => {
    fetches += 1;
    throw new Error('fetch failed');
  });
  config.tmdb.transientMissTtl = 1; // 1s é o mínimo prático do cache (segundos)
  try {
    assert.equal(await getTitles(imdbId), null);
    assert.equal(fetches, 1);
    // Dorme além do TTL transitório: o sentinela saiu, a rede volta a ser
    // perguntada na próxima busca.
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(await getTitles(imdbId), null);
    assert.equal(fetches, 2, 'miss transitório expirado consulta novamente a API');
  } finally {
    stub.restore();
    cache.forget(key);
    config.tmdb.transientMissTtl = 300;
  }
}));

test('miss autoritativo (200 sem resultado) sobrevive ao TTL transitório', withTmdbKey(async () => {
  // Contraste com o teste acima: "id não conhece" é decisão ESTÁVEL da API —
  // 300s de missTtl, mesmo com o transientMissTtl apertado. É o que impede
  // título desconhecido de pagar 5s de timeout a cada busca.
  const imdbId = `tt-auth-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  let fetches = 0;
  const stub = stubFetch(() => {
    fetches += 1;
    return tmdbOk({ movie_results: [], tv_results: [] });
  });
  config.tmdb.transientMissTtl = 1;
  config.tmdb.missTtl = 300;
  try {
    assert.equal(await getTitles(imdbId), null);
    assert.equal(fetches, 1);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(await getTitles(imdbId), null);
    assert.equal(fetches, 1, 'miss autoritativo não consulta novamente dentro do missTtl');
  } finally {
    stub.restore();
    cache.forget(key);
    config.tmdb.transientMissTtl = 300;
  }
}));

test('getTitles com missTtl 0 desliga o cache negativo', withTmdbKey(async () => {
  config.tmdb.missTtl = 0;
  const imdbId = `tt-nomiss-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() => tmdbOk({ movie_results: [], tv_results: [] }));
  try {
    assert.equal(await getTitles(imdbId), null);
    assert.equal(cache.get(key), null, 'missTtl 0 não grava sentinela');
    assert.equal(await getTitles(imdbId), null);
    assert.equal(stub.calls.length, 2, 'sem sentinela, cada busca volta à API');
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles sem API key devolve null sem tocar na rede', async () => {
  const originalKey = config.tmdb.apiKey;
  const stub = stubFetch(() => tmdbOk({}));
  try {
    config.tmdb.apiKey = '';
    assert.equal(await getTitles('tt-sem-chave'), null);
    assert.equal(stub.calls.length, 0, 'sem chave não há o que perguntar');
    // Sem id também não vai à rede.
    config.tmdb.apiKey = 'qualquer';
    assert.equal(await getTitles(''), null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
    config.tmdb.apiKey = originalKey;
  }
});
