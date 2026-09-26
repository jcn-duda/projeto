// Fase 2 da raspagem — identificação TMDB de página sem IMDb (tmdb-search +
// crawl-identify). Dublê de fetch (sem rede), padrão dos irmãos do tmdb:
// persistência desligada ANTES dos imports, título único por teste (a chave de
// cache do search não leva ano — o filtro é local) e chave de API armada por
// teste. HIGIENE: todo caso que toca o cache limpa as próprias chaves no
// `finally` (`forgetKeys`) — o L1 do processo não pode vazar entre casos.
//
// Cenários exigidos pelo plano: homônimo com ano diferente, casamento PT x EN
// (nos dois sentidos) e ambíguo → null. A preferência de segurança é o tema:
// obra errada é pior que obra nenhuma.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const { identifyWork, strictNameMatches, selectCandidate } =
  await import('../src/providers/crawl-identify.js');
const { searchByTitle } = await import('../src/utils/tmdb.js');
const { stubFetch } = await import('./helpers/stub.js');
const { normalizeTitle } = await import('../src/utils/title-normalization.js');
import type { FetchStub } from './helpers/stub.js';

function withTmdbKey(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const originalKey = config.tmdb.apiKey;
    config.tmdb.apiKey = 'test-tmdb-key';
    try {
      await fn();
    } finally {
      config.tmdb.apiKey = originalKey;
    }
  };
}

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const searchResp = (results: any[]) => ok({ page: 1, results, total_results: results.length });

/** Query da chamada de busca capturada pelo dublê (`?query=` decodificado). */
function searchQuery(url: string): string {
  return new URL(url).searchParams.get('query') ?? '';
}

/** Filme TMDB no formato cru da API /search/movie. */
const movieHit = (id: number, title: string, original_title: string, release_date: string) => ({
  id, title, original_title, release_date, popularity: 10,
});

/** Série TMDB no formato cru da API /search/tv. */
const tvHit = (id: number, name: string, original_name: string, first_air_date: string) => ({
  id, name, original_name, first_air_date, popularity: 10,
});

/** Higiene: a chave que o caso criou sai do L1. A chave de busca não leva ano,
 * então o MESMO título normalizado serviria qualquer chamada do processo. */
function forgetKeys(type: 'movie' | 'series', title: string, tmdbIds: number[] = []): void {
  cache.forget(`tmdb:search:${type}:${normalizeTitle(title)}`);
  for (const id of tmdbIds) cache.forget(`tmdb:ext:${type}:${id}`);
}

describe('tmdb.searchByTitle: rede, cache e filtro de ano ±1', () => {
  test('consulta /search/movie em pt-BR SEM ano na query e filtra ±1 localmente', withTmdbKey(async () => {
    const stub = stubFetch((url) => {
      assert.ok(url.includes('/search/movie'), 'filme consulta o path de filme');
      return searchResp([
        movieHit(101, 'Os Incríveis', 'The Incredibles', '2004-11-05'),
        movieHit(102, 'Os Incríveis 2', 'Incredibles 2', '2018-06-15'),
      ]);
    });
    const title = `Probe Filter ${process.pid}`;
    try {
      // Ano da página 2014: só o hit de 2004 está fora (±1); 2018 idem — nenhum casa ano.
      const near = await searchByTitle('movie', title, 2005);
      assert.equal(near.ok, true);
      assert.deepEqual(near.hits.map((h) => h.tmdbId), [101], 'só 2004 sobrevive ao ±1 de 2005');

      const first = new URL(stub.calls[0].url);
      assert.equal(first.searchParams.get('api_key'), 'test-tmdb-key');
      assert.equal(first.searchParams.get('language'), 'pt-BR');
      assert.equal(first.searchParams.get('include_adult'), 'false');
      assert.equal(first.searchParams.get('query'), title);
      assert.equal(first.searchParams.get('year'), null, 'o ano NÃO vai na query: ±1 é filtro local');

      // Segunda chamada vem do cache (a busca não leva ano — entradas são
      // compartilhadas entre chamadas com anos diferentes e o filtro é pós-cache).
      await searchByTitle('movie', title, 2005);
      assert.equal(stub.calls.length, 1, 'a segunda busca não bate na API');
    } finally {
      stub.restore();
      forgetKeys('movie', title);
    }
  }));

  test('hit sem ano legível é descartado com ano na página e aceito sem ano', withTmdbKey(async () => {
    const title = `Probe Sem Ano ${process.pid}`;
    const stub = stubFetch(() => searchResp([
      movieHit(201, 'Obra Sem Data', 'No Date Work', ''),
    ]));
    try {
      const withYear = await searchByTitle('movie', title, 2013);
      assert.deepEqual(withYear.hits, [], 'sem ano no candidato não há com que conferir: fora');
      const noYear = await searchByTitle('movie', title, null);
      assert.equal(noYear.hits.length, 1, 'sem ano na página o candidato vale');
      assert.equal(stub.calls.length, 1, 'mesma entrada de cache serve os dois anos');
    } finally {
      stub.restore();
      forgetKeys('movie', title);
    }
  }));
});

describe('identifyWork: segurança do casamento', () => {
  test('página SEM ano não identifica: pagina-sem-ano, sem consultar homônimo', withTmdbKey(async () => {
    const stub = stubFetch(() => { throw new Error('página sem ano não pode buscar'); });
    try {
      for (const year of [null, undefined, 0]) {
        const result = await identifyWork({ type: 'movie', title: `Homônimo Solo ${process.pid}`, year });
        assert.equal(result.outcome, 'unidentified');
        assert.equal(result.imdb, null);
        assert.equal(result.reason, 'pagina-sem-ano');
      }
      assert.equal(stub.calls.length, 0, 'sem ano não há consulta nem aceitação de homônimo');
    } finally {
      stub.restore();
    }
  }));

  test('HOMÔNIMO com ano diferente não identifica (Hercules 1997/2014, página 2005)', withTmdbKey(async () => {
    const title = `Hercules ${process.pid}`;
    const stub = stubFetch((url) => {
      const q = searchQuery(url);
      if (url.includes('/search/movie')) {
        assert.ok(q === title);
        return searchResp([
          movieHit(301, 'Hércules', 'Hercules', '1997-06-27'),
          movieHit(302, 'Hercules', 'Hercules', '2014-07-25'),
        ]);
      }
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2005 });
      // Nenhum homônimo dentro de ±1 de 2005: obra nenhuma é o desfecho certo.
      assert.equal(result.outcome, 'unidentified');
      assert.equal(result.imdb, null);
      assert.equal(result.reason, 'tmdb-sem-resultado');
      assert.equal(stub.calls.filter((c) => c.url.includes('external_ids')).length, 0,
        'sem candidato não há external_ids');
    } finally {
      stub.restore();
      forgetKeys('movie', title);
    }
  }));

  test('AMBIGUO (dois homônimos dentro de ±1) devolve null, nunca o mais popular', withTmdbKey(async () => {
    const title = `Gêmeos ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) {
        return searchResp([
          movieHit(401, title, title, '2013-01-01'), // popularidade alta
          movieHit(402, title, title, '2014-05-05'), // popularidade baixa, mas dentro de ±1
        ]);
      }
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2013 });
      assert.equal(result.outcome, 'ambiguous');
      assert.equal(result.imdb, null, 'ambíguo é null: o mais famoso não é o certo');
      assert.equal(result.reason, 'homonimo-ambiguo');
    } finally {
      stub.restore();
      forgetKeys('movie', title);
    }
  }));

  test('PT x EN: página em português casa o título localizado do TMDB', withTmdbKey(async () => {
    // O sufixo (pid) está no título DA PÁGINA e no candidato igualmente: a
    // igualdade estrita é exata, então a página "Expresso do Amanhã (ano)"
    // do site real casa o pt-BR do TMDB letra a letra (pós-normalização).
    const title = `Expresso do Amanhã ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([
        movieHit(501, title, 'Snowpiercer', '2013-08-01'),
      ]);
      if (url.includes('/movie/501/external_ids')) return ok({ imdb_id: 'tt1706620' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2013 });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt1706620');
      assert.equal(result.tmdbId, 501);
      assert.ok(stub.calls.some((c) => c.url.includes('/movie/501/external_ids')),
        'o IMDb vem do external_ids da obra única');
    } finally {
      stub.restore();
      forgetKeys('movie', title, [501]);
    }
  }));

  test('EN x PT: página no título ORIGINAL casa quando o TMDB localizou para pt', withTmdbKey(async () => {
    // Página BR que publicou o título em inglês; o casamento usa o par
    // (localizado, original) do MESMO candidato.
    const title = `Snowpiercer ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([
        movieHit(501, `Expresso do Amanhã ${process.pid}`, title, '2013-08-01'),
      ]);
      if (url.includes('/movie/501/external_ids')) return ok({ imdb_id: 'tt1706620' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2013 });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt1706620');
    } finally {
      stub.restore();
      forgetKeys('movie', title, [501]);
    }
  }));

  test('série consulta /search/tv (name/first_air_date) e resolve IMDb por external_ids', withTmdbKey(async () => {
    const title = `Round 6 ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/tv')) {
        assert.ok(!url.includes('/search/movie'));
        return searchResp([tvHit(601, title, 'Squid Game', '2021-09-17')]);
      }
      if (url.includes('/tv/601/external_ids')) return ok({ imdb_id: 'tt10919420' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'series', title, year: 2021 });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt10919420');
    } finally {
      stub.restore();
      forgetKeys('series', title, [601]);
    }
  }));

  test('nome parecido NÃO casa (igualdade estrita, sem substring)', withTmdbKey(async () => {
    const title = `Fallout ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([
        movieHit(701, `${title} 4`, `${title} 4`, '2024-01-01'),
        movieHit(702, `A Queda: ${title}`, `${title}: The Fall`, '2024-01-01'),
      ]);
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2024 });
      assert.equal(result.outcome, 'unidentified');
      assert.equal(result.imdb, null);
      assert.equal(result.reason, 'nome-sem-casamento');
    } finally {
      stub.restore();
      forgetKeys('movie', title);
    }
  }));

  test('obra única sem IMDb no TMDB é unidentified de estado próprio (não retentável)', withTmdbKey(async () => {
    const title = `Sem IMDb ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([movieHit(801, title, title, '2020-01-01')]);
      if (url.includes('/movie/801/external_ids')) return ok({ imdb_id: null });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2020 });
      assert.equal(result.outcome, 'unidentified');
      assert.equal(result.reason, 'obra-sem-imdb');
    } finally {
      stub.restore();
      forgetKeys('movie', title, [801]);
    }
  }));

  test('busca vazia autoritativa é unidentified; falha HTTP é UNAVAILABLE (retentável)', withTmdbKey(async () => {
    const empty = `Vazio ${process.pid}`;
    const emptyStub = stubFetch(() => searchResp([]));
    try {
      const result = await identifyWork({ type: 'movie', title: empty, year: 2020 });
      assert.equal(result.outcome, 'unidentified');
      assert.equal(result.reason, 'tmdb-sem-resultado');
    } finally {
      emptyStub.restore();
      forgetKeys('movie', empty);
    }

    const fail = `Falha ${process.pid}`;
    const failStub = stubFetch(() => ({ ok: false, status: 500 }));
    try {
      const result = await identifyWork({ type: 'movie', title: fail, year: 2020 });
      // 500 NÃO é veredicto: o motor precisa distinguir para poder retentar.
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.reason, 'tmdb-indisponivel');
    } finally {
      failStub.restore();
      forgetKeys('movie', fail);
    }
  }));

  test('external_ids indisponível vira unavailable com o tmdbId da obra única', withTmdbKey(async () => {
    const title = `Ext Falha ${process.pid}`;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) return searchResp([movieHit(901, title, title, '2020-01-01')]);
      if (url.includes('/movie/901/external_ids')) return { ok: false, status: 503 };
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: 2020 });
      assert.equal(result.outcome, 'unavailable');
      assert.equal(result.reason, 'tmdb-external-indisponivel');
      assert.equal(result.tmdbId, 901);
    } finally {
      stub.restore();
      forgetKeys('movie', title, [901]);
    }
  }));

  test('sem chave de API é unavailable e não toca a rede; título vazio idem', withTmdbKey(async () => {
    config.tmdb.apiKey = '';
    const stub = stubFetch(() => { throw new Error('não deveria haver rede'); });
    try {
      const noKey = await identifyWork({ type: 'movie', title: 'Qualquer', year: 2020 });
      assert.equal(noKey.outcome, 'unavailable');
      const noTitle = await identifyWork({ type: 'movie', title: '   ', year: 2020 });
      assert.equal(noTitle.outcome, 'unidentified');
      assert.equal(stub.calls.length, 0, 'nem chave ausente nem título vazio buscam');
    } finally {
      stub.restore();
    }
  }));
});

describe('entrada da identificação: título da página do Vaca', () => {
  test('parseTitleYear decodifica entidade HTML do h1 e a query do TMDB encontra a obra', withTmdbKey(async () => {
    // Medido ao vivo (sonda da Fase 2): "A Gangster&#8217;s Life" e
    // "Mike &#038; Nick" voltavam 0 no TMDB com a entidade crua na query.
    const { parseTitleYear } = await import('../src/providers/crawl-sites/vaca.js');
    const parsed = parseTitleYear(
      '<h1>A Gangster&#8217;s Life (2026)</h1>'
      + '<div>Avaliação da IMDb: <a href="https://www.imdb.com/title/tt0000000/">IMDb</a></div>',
    );
    assert.equal(parsed.title, 'A Gangster’s Life');
    assert.equal(parsed.year, 2026);

    // Integração: o título DECODIFICADO é o que vai para a busca (a obra no
    // TMDB se chama com o apóstrofo tipográfico real, não com a entidade).
    const title = parsed.title;
    const stub = stubFetch((url) => {
      if (url.includes('/search/movie')) {
        assert.equal(new URL(url).searchParams.get('query'), 'A Gangster’s Life');
        return searchResp([movieHit(111, title, title, '2026-01-15')]);
      }
      if (url.includes('/movie/111/external_ids')) return ok({ imdb_id: 'tt33372326' });
      throw new Error(`fetch fora do mapa: ${url}`);
    });
    try {
      const result = await identifyWork({ type: 'movie', title, year: parsed.year });
      assert.equal(result.outcome, 'identified');
      assert.equal(result.imdb, 'tt33372326');
    } finally {
      stub.restore();
      forgetKeys('movie', title, [111]);
    }
  }));
});

describe('helpers puros do casamento', () => {
  test('strictNameMatches normaliza acento, caixa e pontuação; não casa substring', async () => {
    assert.equal(normalizeTitle('Expresso do Amanhã'), normalizeTitle('expresso do amanha'));
    assert.equal(strictNameMatches('Expresso do Amanhã!', ['EXPRESSO DO AMANHA']), true);
    assert.equal(strictNameMatches('Expresso do Amanhã', ['Expresso do Amanhã: Legado']), false);
    assert.equal(strictNameMatches('', ['qualquer']), false, 'título vazio não casa nada');
    assert.equal(strictNameMatches('Filme', [null, undefined]), false);
  });

  test('selectCandidate separa única/ambígua/nenhuma por id TMDB distinto', async () => {
    const hitA = { tmdbId: 1, title: 'X', originalTitle: 'X', year: 2013 };
    const hitB = { tmdbId: 2, title: 'X', originalTitle: 'X', year: 2014 };
    const unique = selectCandidate([hitA], 'x');
    assert.equal(unique.kind, 'unique');
    const ambiguous = selectCandidate([hitA, hitB], 'X');
    assert.equal(ambiguous.kind, 'ambiguous');
    const none = selectCandidate([hitA], 'Y');
    assert.equal(none.kind, 'none');
  });
});
