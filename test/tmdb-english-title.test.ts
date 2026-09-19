// Ramos de cache/prazo da SEGUNDA consulta `/find` em en-US do TMDB, que
// alimenta o título de busca quando o Cinemeta cai e o original não é inglês.
// Substitui os testes fabricados sobre `alternative_titles`, removidos junto
// com o uso de aliases arbitrários.
//
// Persistência desligada ANTES dos imports: chaves efêmeras não podem tocar o
// data/cache.db real. Em ESM os imports estáticos são hoisted (o cache abre o
// banco no load), então os módulos entram por import dinâmico depois desta
// linha.
import { test } from 'node:test';
import assert from 'node:assert';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const { getTitles } = await import('../src/utils/tmdb.js');
const { stubFetch } = await import('./helpers/stub.js');

const tmdbOk = (body: any) => ({ ok: true, status: 200, json: async () => body });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Shape do `/find` pt-BR de obra com original estrangeiro: é o que dispara a
// segunda consulta en-US.
const foreignMoviePtBr = () => tmdbOk({
  movie_results: [
    {
      id: 777,
      title: 'PT Localizado',
      original_title: 'Original Estrangeiro',
      original_language: 'it',
      release_date: '1967-01-01',
    },
  ],
  tv_results: [],
});

test('getTitles (TV): a 2ª consulta /find en-US traz o canônico de tv_results (Adım Farah)', withTmdbKey(async () => {
  // Caso real de série: o `/find` pt-BR devolve pt "Meu Nome é Farah" e
  // original turco "Adım Farah"; o nome que os trackers globais publicam
  // ("My Name Is Farah") só existe na variante en-US, em `tv_results[].name`.
  const imdbId = `tt-farah-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch((url) => {
    if (url.includes('language=en-US')) {
      return tmdbOk({
        movie_results: [],
        tv_results: [
          { id: 54321, name: 'My Name Is Farah', original_name: 'Adım Farah', original_language: 'tr' },
        ],
      });
    }
    return tmdbOk({
      movie_results: [],
      tv_results: [
        {
          id: 54321,
          name: 'Meu Nome é Farah',
          original_name: 'Adım Farah',
          original_language: 'tr',
          first_air_date: '2023-03-01',
        },
      ],
    });
  });
  try {
    const titles = await getTitles(imdbId);
    assert.deepEqual(titles, {
      pt: 'Meu Nome é Farah',
      original: 'Adım Farah',
      en: 'My Name Is Farah',
      year: '2023',
    });
    const enCalls = stub.calls.filter((c) => c.url.includes('language=en-US'));
    assert.equal(enCalls.length, 1, 'a série consulta o /find en-US uma vez');
    assert.ok(enCalls[0].url.includes(`/find/${imdbId}`));
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles: original inglês não abre a 2ª consulta /find en-US', withTmdbKey(async () => {
  const imdbId = `tt-english-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch(() => tmdbOk({
    movie_results: [
      { id: 1, title: 'The Thing', original_title: 'The Thing', original_language: 'en', release_date: '1982-06-25' },
    ],
  }));
  try {
    const titles = await getTitles(imdbId);
    assert.deepEqual(titles, { pt: 'The Thing', original: 'The Thing', en: 'The Thing', year: '1982' });
    assert.equal(stub.calls.length, 1, 'original inglês não paga chamada extra');
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles: ausência autoritativa do canônico inglês é cacheada pelo TTL longo', withTmdbKey(async () => {
  // A API respondeu (ok) e não há grafia en-US: a ausência é real e pode ficar
  // no cache longo. Só degradação é que não.
  const imdbId = `tt-en-empty-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch((url) => {
    if (url.includes('language=en-US')) return tmdbOk({ movie_results: [], tv_results: [] });
    return foreignMoviePtBr();
  });
  try {
    const titles = await getTitles(imdbId);
    assert.equal(titles.en, null);
    assert.equal(titles.pt, 'PT Localizado');
    const remaining = cache.peekRemaining(key);
    assert.ok(remaining !== null && remaining > 3600, `ausência real usa TTL longo (${remaining}s)`);
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles: falha na 2ª consulta en-US NÃO congela a ausência pelo TTL longo', withTmdbKey(async () => {
  // 429 na segunda consulta: a obra é gravada com pt/original e `en:null`, mas
  // com TTL CURTO — repetir a degradação por 7 dias perderia o canônico até o
  // próximo deploy.
  const imdbId = `tt-en-fail-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const stub = stubFetch((url) => {
    if (url.includes('language=en-US')) return { ok: false, status: 429, json: async () => ({}) };
    return foreignMoviePtBr();
  });
  try {
    const titles = await getTitles(imdbId);
    assert.equal(titles.en, null);
    assert.equal(titles.pt, 'PT Localizado');
    assert.equal(titles.original, 'Original Estrangeiro');
    const remaining = cache.peekRemaining(key);
    assert.ok(
      remaining !== null && remaining <= config.tmdb.transientMissTtl,
      `degradação usa TTL curto (${remaining}s)`,
    );
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles: prazo esgotado não abre a 2ª consulta e usa TTL curto', withTmdbKey(async () => {
  const imdbId = `tt-en-deadline-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  const originalTimeout = config.tmdb.timeout;
  config.tmdb.timeout = 20; // prazo minúsculo; o `/find` pt-BR do dublê demora além dele
  let enCalled = false;
  const stub = stubFetch(async (url) => {
    if (url.includes('language=en-US')) {
      enCalled = true;
      return tmdbOk({ movie_results: [], tv_results: [] });
    }
    await sleep(40);
    return foreignMoviePtBr();
  });
  try {
    const titles = await getTitles(imdbId);
    assert.equal(enCalled, false, 'prazo esgotado não pode abrir a 2ª consulta');
    assert.equal(titles.en, null);
    assert.equal(titles.pt, 'PT Localizado');
    const remaining = cache.peekRemaining(key);
    assert.ok(
      remaining !== null && remaining <= config.tmdb.transientMissTtl,
      `degradação por prazo usa TTL curto (${remaining}s)`,
    );
  } finally {
    stub.restore();
    cache.forget(key);
    config.tmdb.timeout = originalTimeout;
  }
}));

test('getTitles: releitura de entrada legada que falha preserva pt/original e descarta alias antigo', withTmdbKey(async () => {
  // Entrada anterior ao campo `en`, com `aliases` fabricado pela versão
  // removida, e rede fora: pt/original NÃO podem ser condenados a miss, o
  // campo arbitrário não pode sobreviver, e a releitura precisa de backoff
  // para não martelar a API a cada busca.
  const imdbId = `tt-legacy-fail-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  cache.set(key, { pt: 'Legado PT', original: 'Legacy Original', aliases: ['Kill', 'Farah'], year: '1998' }, config.tmdb.cacheTtl);
  let fetches = 0;
  const stub = stubFetch(() => {
    fetches += 1;
    throw new Error('fetch failed');
  });
  try {
    const titles = await getTitles(imdbId);
    assert.equal(titles.pt, 'Legado PT');
    assert.equal(titles.original, 'Legacy Original');
    assert.equal(titles.en, null);
    assert.equal(titles.aliases, undefined, 'alias legado não sobrevive à auto-cura');
    assert.equal(fetches, 1);
    const remaining = cache.peekRemaining(key);
    assert.ok(remaining !== null && remaining <= config.tmdb.transientMissTtl, `backoff curto (${remaining}s)`);
    // Dentro do backoff, a próxima busca serve do cache sem tocar a rede.
    const again = await getTitles(imdbId);
    assert.equal(again.pt, 'Legado PT');
    assert.equal(fetches, 1, 'backoff evita nova chamada dentro do TTL curto');
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));

test('getTitles: entrada com `en` mas ainda com `aliases` legado é relida e limpa do cache', withTmdbKey(async () => {
  // A versão anterior gravava `en` E `aliases` no mesmo objeto. Como `en` já
  // existe, a auto-cura sozinha devolveria a entrada sem reler — e o campo
  // arbitrário ficaria no cache. O gate tem que rejeitar esse shape também.
  const imdbId = `tt-stale-alias-${process.pid}-${Date.now()}`;
  const key = `tmdb:${imdbId}`;
  cache.set(
    key,
    { pt: 'PT Antigo', original: 'Original Estrangeiro', en: 'Old English', aliases: ['Kill'], year: '1967' },
    config.tmdb.cacheTtl,
  );
  const stub = stubFetch((url) => {
    if (url.includes('language=en-US')) {
      return tmdbOk({ movie_results: [{ id: 777, title: 'Django Kill... If You Live, Shoot!', original_language: 'it' }] });
    }
    return foreignMoviePtBr();
  });
  try {
    const titles = await getTitles(imdbId);
    assert.equal(titles.en, 'Django Kill... If You Live, Shoot!');
    assert.equal(titles.aliases, undefined);
    assert.equal(stub.calls.length, 2, 'entrada com alias legado é relida uma vez');
    assert.equal((cache.get(key) as any).aliases, undefined, 'campo arbitrário não sobrevive no cache');
  } finally {
    stub.restore();
    cache.forget(key);
  }
}));
