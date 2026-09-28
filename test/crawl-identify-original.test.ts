// Título ORIGINAL da página como segundo nome da identificação (NerdFilmes).
// Medido em 2026-09-28 na raspagem ao vivo: 11 de 74 páginas saíram "sem obra",
// e 6 delas traziam o original certo sob o `<h1>` — o site titula em inglês
// ("7 Dogs" = "7 كلاب") ou num pt-BR que o TMDB não tem ("A Armadilha do
// Coelho" = "Rabbit Trap"). A régua continua ESTRITA: o original é mais um
// nome, nunca um casamento mais frouxo, e o desempate de homônimo só vale
// quando exatamente um candidato tem o original declarado.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const { identifyWork, selectCandidate } = await import('../src/providers/crawl-identify.js');
const { parseOriginalTitle } = await import('../src/providers/crawl-sites/shared.js');
const { stubFetch } = await import('./helpers/stub.js');
const { normalizeTitle } = await import('../src/utils/title-normalization.js');
const { MOVIE, fixture, pageRoutes, site, withStub } = await import('./helpers/crawl-nerdfilmes-fixtures.js');

function withTmdbKey(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const originalKey = config.tmdb.apiKey;
    config.tmdb.apiKey = 'test-tmdb-key';
    try { await fn(); } finally { config.tmdb.apiKey = originalKey; }
  };
}

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const searchResp = (results: any[]) => ok({ page: 1, results, total_results: results.length });
const movieHit = (id: number, title: string, original_title: string, release_date: string) => ({
  id, title, original_title, release_date, popularity: 10,
});
const queryOf = (url: string) => new URL(url).searchParams.get('query') ?? '';

/** Higiene do L1: a chave de busca não leva ano (ver crawl-identify.test.ts). */
function forget(titles: string[], ids: number[] = []): void {
  for (const t of titles) cache.forget(`tmdb:search:movie:${normalizeTitle(t)}`);
  for (const id of ids) cache.forget(`tmdb:ext:movie:${id}`);
}

describe('parseOriginalTitle: o span do NerdFilmes', () => {
  test('extrai o original sem o rótulo, com entidade decodificada', () => {
    const html = '<h1 class="movie-title">7 Dogs (2026)</h1><span class="movie-original"> Título original: 7 كلاب </span>';
    assert.equal(parseOriginalTitle(html), '7 كلاب');
    assert.equal(
      parseOriginalTitle('<span class="movie-original">T&iacute;tulo original: Mike &#038; Nick</span>'),
      'Mike & Nick',
    );
  });

  test('ficha do WordPress BR (Comando/TorrentDosFilmes): com e sem acento, `:` dentro ou fora do negrito', () => {
    // Recortes reais (2026-09-28).
    assert.equal(parseOriginalTitle('<b>Titulo Original:</b> Sick of Myself<br /> <strong>IMDb</strong>'), 'Sick of Myself');
    assert.equal(parseOriginalTitle('<b>Título Original</b>: Colors of Love<br /> <strong>IMDb</strong>'), 'Colors of Love');
    assert.equal(parseOriginalTitle('<strong>Título Original</strong>: Antibirth<br />'), 'Antibirth');
    assert.equal(parseOriginalTitle('<b>Titulo Original:</b> Dr. No<br /> <b>3D:</b> SIM'), 'Dr. No');
    // Dois nomes: o primeiro é o original, o resto é tradução/romanização.
    assert.equal(parseOriginalTitle('<b>Titulo Original:</b> Paradox / Sha po lang: taam long<br />'), 'Paradox');
    assert.equal(parseOriginalTitle('<b>T&iacute;tulo Original:</b> Nakitai Watashi wa Neko wo Kaburu<br />'),
      'Nakitai Watashi wa Neko wo Kaburu');
  });

  test('o span do NerdFilmes vence a ficha quando os dois existem', () => {
    const html = '<span class="movie-original">Título original: 7 كلاب</span><b>Título Original:</b> Outro<br>';
    assert.equal(parseOriginalTitle(html), '7 كلاب');
  });

  test('ausente, vazio ou comentado é null (o Vaca não publica)', () => {
    assert.equal(parseOriginalTitle('<h1>Garota Exemplar (2014)</h1>'), null);
    assert.equal(parseOriginalTitle('<span class="movie-original">Título original: </span>'), null);
    assert.equal(parseOriginalTitle('<!-- <span class="movie-original">Título original: X</span> -->'), null);
  });

  test('o adaptador do NerdFilmes devolve o original no `done`', () => withStub(pageRoutes({
    [MOVIE]: () => fixture('post-movie.html').replace(
      /<\/h1>/i,
      '</h1><span class="movie-original"> Título original: Bancários </span>',
    ),
  }), async () => {
    const result = await site().fetchWork(MOVIE);
    assert.equal(result.status, 'done');
    assert.equal(result.originalTitle, 'Bancários');
  }));
});

describe('selectCandidate: desempate pelo original declarado', () => {
  const besta = movieHit(601, 'A Besta', 'La bête', '2024-02-07');
  const homonimo = movieHit(602, 'A BESTA', 'A BESTA', '2024-05-01');
  const hits = [besta, homonimo].map((h) => ({
    tmdbId: h.id, title: h.title, originalTitle: h.original_title, year: 2024, popularity: 10,
  }));

  test('dois homônimos + original que só um tem = único', () => {
    const sel = selectCandidate(hits, 'A Besta', 'La bête');
    assert.equal(sel.kind, 'unique');
    assert.equal(sel.kind === 'unique' && sel.hit.tmdbId, 601);
  });

  test('sem original, ou original que os dois têm, continua ambíguo', () => {
    assert.equal(selectCandidate(hits, 'A Besta').kind, 'ambiguous');
    const same = hits.map((h) => ({ ...h, originalTitle: 'Beauty and the Beast' }));
    assert.equal(selectCandidate(same, 'A Besta', 'Beauty and the Beast').kind, 'ambiguous',
      'o original não desempata quando não distingue');
  });
});

describe('identifyWork com o título original da página', () => {
  test('título em inglês que o TMDB não tem: casa pelo original, sem 2ª busca', withTmdbKey(async () => {
    const title = `7 Dogs ${process.pid}`;
    const original = `7 كلاب ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([movieHit(701, original, original, '2026-01-01')]);
      if (url.includes('/movie/701/external_ids')) return ok({ imdb_id: 'tt7000001' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2026, originalTitle: original });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt7000001');
      assert.equal(result.reason, 'casamento-titulo-original', 'o painel separa o que o original recuperou');
      assert.equal(stub.calls.filter((c) => c.url.includes('/search/movie')).length, 1);
    } finally {
      stub.restore();
      forget([title, original], [701]);
    }
  }));

  test('pt-BR que o TMDB não conhece: 2ª busca pelo original', withTmdbKey(async () => {
    const title = `A Armadilha do Coelho ${process.pid}`;
    const original = `Rabbit Trap ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) {
        return queryOf(url) === original ? searchResp([movieHit(702, 'Rabbit Trap', original, '2025-01-24')]) : searchResp([]);
      }
      if (url.includes('/movie/702/external_ids')) return ok({ imdb_id: 'tt7000002' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2025, originalTitle: original });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt7000002');
      assert.deepEqual(stub.calls.filter((c) => c.url.includes('/search/movie')).map((c) => queryOf(c.url)), [title, original]);
    } finally {
      stub.restore();
      forget([title, original], [702]);
    }
  }));

  test('homônimo do mesmo ano desempatado pelo original', withTmdbKey(async () => {
    const title = `A Besta ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) {
        return searchResp([movieHit(703, title, 'La bête', '2024-02-07'), movieHit(704, title, title, '2024-05-01')]);
      }
      if (url.includes('/movie/703/external_ids')) return ok({ imdb_id: 'tt7000003' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2024, originalTitle: 'La bête' });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt7000003');
    } finally {
      stub.restore();
      forget([title], [703]);
    }
  }));

  test('original que não casa ninguém continua sem obra (a régua não afrouxa)', withTmdbKey(async () => {
    const title = `63 Horas de Pânico ${process.pid}`;
    const original = `Dead Mans Wire X ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([movieHit(705, 'Refém Por um Fio', "Dead Man's Wire", '2026-01-01')]);
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2026, originalTitle: original });
      assert.equal(result.outcome, 'unidentified');
      assert.equal(result.reason, 'nome-sem-casamento');
    } finally {
      stub.restore();
      forget([title, original]);
    }
  }));

  test('2ª busca que falha é UNAVAILABLE (retentável), nunca veredito', withTmdbKey(async () => {
    const title = `Sem Nome ${process.pid}`;
    const original = `No Name ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return queryOf(url) === original ? { ok: false, status: 500 } : searchResp([]);
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2025, originalTitle: original });
      assert.equal(result.outcome, 'unavailable');
    } finally {
      stub.restore();
      forget([title, original]);
    }
  }));

  test('original igual ao h1 não gasta 2ª busca', withTmdbKey(async () => {
    const title = `21 Mão Na Cabeça ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([]);
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2019, originalTitle: title.toUpperCase() });
      assert.equal(result.reason, 'tmdb-sem-resultado');
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore();
      forget([title]);
    }
  }));
});
