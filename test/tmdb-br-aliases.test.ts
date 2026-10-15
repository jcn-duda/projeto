// Aliases BR do TMDB (`alternative_titles`, só país BR): o título que os sites
// brasileiros publicam quando o pt-BR do TMDB é outro. Caso medido: Lioness —
// TMDB pt-BR "Lioness", todo post BR "Operação Lioness" (Paramount+ Brasil); a
// regra de prefixo do filtro BR cortava os dublados que o BR Dublado achava.
import { test } from 'node:test';
import assert from 'node:assert';

// Persistência desligada ANTES dos imports (mesma razão de test/tmdb.test.ts).
process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const { getTitles } = await import('../src/utils/tmdb.js');
const { filterBrAliases } = await import('../src/utils/tmdb-br-aliases.js');
const { resolveSearchNames, filterRelevantRaw } = await import('../src/utils/format.js');
const { stubFetch } = await import('./helpers/stub.js');

const tmdbOk = (body: any) => ({ ok: true, status: 200, json: async () => body });

test('filterBrAliases: alias precisa conter um nome canônico inteiro', () => {
  assert.deepEqual(filterBrAliases(['Operação: Lioness'], ['Lioness', 'Lioness', 'Lioness']), ['Operação: Lioness']);
  // Alias solto é o que o b223ffd removeu: "Kill" divide uma palavra com o
  // canônico inglês do Django, mas não o contém — abriria outra obra.
  assert.deepEqual(
    filterBrAliases(['Kill'], ['Django Vem Para Matar', 'Se sei vivo spara', 'Django Kill... If You Live, Shoot!']),
    [],
  );
  assert.deepEqual(filterBrAliases(['Farah'], ['Meu Nome é Farah', 'Adım Farah', 'My Name Is Farah']), []);
  assert.deepEqual(filterBrAliases(['The Crown'], ['The Office']), []);
  // Igual a um canônico (após normalização) não acrescenta nada.
  assert.deepEqual(filterBrAliases(['LIONESS', 'Lioness!'], ['Lioness']), []);
  // Teto de 2, como o provider BR Dublado.
  assert.deepEqual(
    filterBrAliases(['Operação Lioness', 'Lioness: Operação Especial', 'Missão Lioness'], ['Lioness']),
    ['Operação Lioness', 'Lioness: Operação Especial'],
  );
});

test('getTitles grava só aliases BR filtrados e resolveSearchNames os usa', async () => {
  const saved = config.tmdb.apiKey;
  config.tmdb.apiKey = 'test-tmdb-key';
  const imdbId = `tt-br-alias-${process.pid}-${Date.now()}`;
  const stub = stubFetch((url: string) => {
    if (url.includes('/alternative_titles')) {
      return tmdbOk({
        results: [
          { iso_3166_1: 'BR', title: 'Operação: Lioness' },
          { iso_3166_1: 'US', title: 'Special Ops: Lioness' },
        ],
      });
    }
    return tmdbOk({
      movie_results: [],
      tv_results: [{ id: 113962, name: 'Lioness', original_name: 'Lioness', original_language: 'en', first_air_date: '2023-07-23' }],
    });
  });
  try {
    const titles = await getTitles(imdbId);
    assert.deepEqual(titles.br, ['Operação: Lioness'], 'só o país BR entra');
    assert.ok(stub.calls.some((c: any) => c.url.includes('/tv/113962/alternative_titles')), 'série usa o endpoint /tv');
    const { names } = resolveSearchNames({ meta: { name: 'Lioness' }, titles, imdbId });
    assert.ok(names.includes('Operação: Lioness'));
    assert.ok(!names.includes('Special Ops: Lioness'));

    // Ponta a ponta no filtro BR: o post dublado real passa com o alias e
    // morre sem ele (regra de prefixo).
    const post = { title: 'Operação Lioness - 2ª Temporada [1080p WEB-DL DUAL]', seeders: 1, isBr: true };
    const opts = { year: '2023', isSeries: true, season: 2, episode: 1 };
    assert.equal(filterRelevantRaw([post], { names, ...opts }).length, 1);
    assert.equal(filterRelevantRaw([post], { names: ['Lioness'], ...opts }).length, 0);
  } finally {
    stub.restore();
    cache.forget(`tmdb:${imdbId}`);
    config.tmdb.apiKey = saved;
  }
});

test('getTitles: falha no alternative_titles não derruba pt/original e encurta o TTL', async () => {
  const saved = { key: config.tmdb.apiKey, ttl: config.tmdb.cacheTtl, tr: config.tmdb.transientMissTtl };
  config.tmdb.apiKey = 'test-tmdb-key';
  config.tmdb.cacheTtl = 3600;
  config.tmdb.transientMissTtl = 30;
  const imdbId = `tt-br-alias-fail-${process.pid}-${Date.now()}`;
  const stub = stubFetch((url: string) => {
    if (url.includes('/alternative_titles')) return { ok: false, status: 503, json: async () => ({}) };
    return tmdbOk({ movie_results: [{ id: 475557, title: 'Coringa', original_title: 'Joker', original_language: 'en', release_date: '2019-10-04' }] });
  });
  try {
    const titles = await getTitles(imdbId);
    assert.equal(titles.pt, 'Coringa');
    assert.deepEqual(titles.br, []);
    // Degradação usa enRetryTtl (min(cacheTtl, transientMissTtl) = 30s), não
    // o TTL longo — a próxima busca tenta os aliases de novo.
    const remaining = cache.peekRemaining(`tmdb:${imdbId}`);
    assert.ok(remaining != null && remaining <= 30, `TTL curto na degradação (restante ${remaining})`);
  } finally {
    stub.restore();
    cache.forget(`tmdb:${imdbId}`);
    config.tmdb.apiKey = saved.key;
    config.tmdb.cacheTtl = saved.ttl;
    config.tmdb.transientMissTtl = saved.tr;
  }
});
