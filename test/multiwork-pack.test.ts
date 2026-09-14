// Suporte opt-in a packs multiobra BR (BR_MULTIWORK_PACKS). Caso real:
// tt0082971 (Indiana Jones e os Caçadores da Arca Perdida, 1981) — o dublado BR
// às vezes só existe no pack da coleção ("Indiana Jones - A Coleção Completa
// 1981-2008"), que NUNCA casa o filtro estrito de título do filme isolado.
//
// A feature é fechada por padrão; os testes fixam: opt-in off/on, outra
// franquia, faixa sem o ano, sem ano/sem debrid/série, admissão no filtro antes
// do magnet, query de franquia só na tarefa BR (sem fan-out), não-indexação do
// pack e não-P2P (nunca torrent inteiro).
import { test } from 'node:test';
import assert from 'node:assert';

// Persistência desligada ANTES dos imports dinâmicos: o arquivo grava chaves de
// teste no cache e o data/cache.db real do repo não pode ser tocado.
process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const cache = await import('../src/utils/cache.js');
const runtime = await import('../src/runtime.js');
const { collectionRoot, collectionRootTokens, admitsMultiWorkPack, coversYear, packYearSource } =
  await import('../src/utils/multiwork-pack.js');
const { filterRelevantRaw, limitReservingBr, dedupeByHash } = await import('../src/utils/format.js');
const { planJackettQueries } = await import('../src/providers/search-plan.js');
const { playDisposition } = await import('../src/providers/debrid-play-guard.js');
const { resolveMultiWork, startMultiWorkDiscovery } = await import('../src/providers/search-multiwork.js');
const { getCollection } = await import('../src/utils/tmdb.js');
const { prepareCandidateStreams } = await import('../src/providers/stream-builder.js');
const releaseIndex = await import('../src/utils/release-index.js');
const { stubFetch } = await import('./helpers/stub.js');

const IMDB = 'tt0082971';
const HASH = 'a'.repeat(40);
const MOVIE_NAME = 'Indiana Jones e os Caçadores da Arca Perdida';

// Coleção do TMDB (pt-BR): nome com ruído de empacotamento e as quatro partes.
const INDY = { name: 'Indiana Jones - Coleção', root: 'indiana jones', years: [1981, 1984, 1989, 2008] };

const indyPack = () => ({
  title: 'Indiana Jones - A Coleção Completa 1981-2008 Dublado 1080p',
  infoHash: HASH,
  magnet: `magnet:?xt=urn:btih:${HASH}&dn=Indiana.Jones.Collection.1981-2008.DUAL.1080p`,
  isBr: true,
  seeders: 5,
  indexer: 'bludv-cardigann',
});

function withFlags<T>(patch: { multiWorkPacks?: boolean }, fn: () => Promise<T>) {
  return (async () => {
    const original = config.search.multiWorkPacks;
    if (patch.multiWorkPacks !== undefined) config.search.multiWorkPacks = patch.multiWorkPacks;
    try {
      return await fn();
    } finally {
      config.search.multiWorkPacks = original;
    }
  })();
}

test('collectionRoot: nome do TMDB vira raiz contígua sem ruído de empacotamento', () => {
  assert.deepEqual(collectionRootTokens('Indiana Jones - Coleção'), ['indiana', 'jones']);
  assert.deepEqual(collectionRootTokens('Trilogia Indiana Jones'), ['indiana', 'jones']);
  assert.deepEqual(collectionRootTokens('O Senhor dos Anéis: A Coleção'), ['senhor', 'dos', 'aneis']);
  // Uma obra só não vira franquia (menos de 2 tokens).
  assert.equal(collectionRoot('Rocky'), '');
});

test('coversYear: faixa cobre o ano sem folga de borda; ano avulso mantém ±2', () => {
  assert.equal(coversYear('Coleção Completa 1981-2008', 1981), true);
  assert.equal(coversYear('Coleção Completa 1981 a 2008', 1981), true);
  assert.equal(coversYear('Filmes 2000-2008', 1981), false);
  // Borda SEM ±2: 1983-2008 NÃO cobre 1981 (a folga antiga diria que sim).
  assert.equal(coversYear('Coleção 1983-2008', 1981), false);
  assert.equal(coversYear('Apenas 2008', 1981), false);
  // Ano avulso: a tolerância de ±2 é documentada (edição BR escorrega um ano).
  assert.equal(coversYear('Lançamento 1981', 1981), true);
  assert.equal(coversYear('Lançamento 1983', 1981), true);
  // Resolução não é ano.
  assert.equal(coversYear('1920x1080', 1981), false);
});

test('packYearSource: o ano também pode estar no dn= do magnet', () => {
  const item = { title: 'Indiana Jones Coleção', magnet: `magnet:?xt=urn:btih:${HASH}&dn=Indiana.Jones.1981.2008.720p` };
  assert.ok(packYearSource(item).includes('1981'));
  assert.equal(coversYear(packYearSource(item), 1981), true);
});

test('admissão: opt-in desligado (sem multiWork) nega o pack', () => {
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: null, year: 1981, names: [MOVIE_NAME] }), false);
});

test('admissão: pack da franquia com cobertura explícita do ano é admitido', () => {
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: INDY, year: 1981, names: [MOVIE_NAME] }), true);
});

test('admissão: outra franquia é negada (raiz não contígua)', () => {
  const starWars = { name: 'Star Wars', root: 'star wars', years: [1977, 1980] };
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: starWars, year: 1981, names: [MOVIE_NAME] }), false);
});

test('admissão: faixa sem o ano do catálogo é negada', () => {
  const lateOnly = { ...indyPack(), title: 'Indiana Jones - Coleção 2000-2008 Dublado', magnet: '' };
  assert.equal(admitsMultiWorkPack(lateOnly, { multiWork: INDY, year: 1981, names: [MOVIE_NAME] }), false);
});

test('admissão: sem ano, série, sem nomes e título não-coleção são negados', () => {
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: INDY, year: null, names: [MOVIE_NAME] }), false);
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: INDY, year: 1981, isSeries: true, names: [MOVIE_NAME] }), false);
  // H2 — sem nomes não há dica de obra: o /resolve cairia no maior arquivo.
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: INDY, year: 1981, names: [] }), false);
  // Raiz de 1 token nunca é admitida (collectionRoot devolve '' e o gate fecha).
  assert.equal(admitsMultiWorkPack(indyPack(), { multiWork: { name: 'Rocky', root: '', years: [1976] }, year: 1981, names: [MOVIE_NAME] }), false);
  const single = { ...indyPack(), title: 'Indiana Jones e os Caçadores da Arca Perdida 1981 Dublado' };
  assert.equal(admitsMultiWorkPack(single, { multiWork: INDY, year: 1981, names: [MOVIE_NAME] }), false);
});

test('filtro pré-magnet: o pack só passa o filtro com o contexto multiWork', () => {
  const ctx = { names: [MOVIE_NAME], year: 1981, isSeries: false, season: null, episode: null };
  // Sem opt-in o pack é rejeitado pelo título (comportamento antigo).
  assert.deepEqual(filterRelevantRaw([indyPack()], ctx), []);
  // Com o contexto admitido, ele sobrevive ao MESMO filtro usado antes de
  // resolver o magnet — é o que dá ao /resolve a chance de escolher 1981.
  const admitted = filterRelevantRaw([indyPack()], { ...ctx, multiWork: INDY });
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].infoHash, HASH);
});

test('plan: raiz multiobra só na tarefa BR, sem fan-out', () => {
  const plan = planJackettQueries(
    'Indiana Jones e os Caçadores da Arca Perdida 1981',
    'Indiana Jones e os Caçadores da Arca Perdida 1981',
    ['thepiratebay', 'bludv-cardigann'],
    ['bludv-cardigann'],
    [],
    null,
    null,
    'indiana jones',
  );
  // Uma tarefa por indexer (global agrupado + BR isolado): NENHUMA tarefa extra
  // de franquia — o degrau vive DENTRO da tarefa BR, sequencial.
  assert.equal(plan.length, 2);
  const global = plan.find((t) => t.indexers.includes('thepiratebay')) as any;
  const br = plan.find((t) => t.indexers[0] === 'bludv-cardigann') as any;
  assert.equal('multiWork' in global, false);
  assert.equal(br.multiWork, 'indiana jones');
});

test('não-P2P: só o multiobra ADMITIDO nunca vira torrent P2P inteiro', () => {
  const admitted = { name: 'x', infoHash: HASH, _multiWork: true, _multiWorkAdmitted: true } as any;
  const generic = { name: 'g', infoHash: HASH, _multiWork: true } as any;
  const normal = { name: 'y', infoHash: HASH } as any;
  // Cached: sai pelo /resolve.
  assert.equal(playDisposition(admitted, { cached: true, resolveUncached: false }), 'resolve');
  // Fora do cache sem resolveUncached: DROP (nunca P2P inteiro).
  assert.equal(playDisposition(admitted, { cached: false, resolveUncached: false }), 'drop');
  // resolveUncached explícito: /resolve, não P2P.
  assert.equal(playDisposition(admitted, { cached: false, resolveUncached: true }), 'resolve');
  // M1 — `_multiWork` genérico (flag off / não admitido) NÃO é afetado: o
  // comportamento anterior (torrent puro) permanece.
  assert.equal(playDisposition(generic, { cached: false, resolveUncached: false }), 'p2p');
  assert.equal(playDisposition(normal, { cached: false, resolveUncached: false }), 'p2p');
  // Ramo degradado (known:false): tudo pelo /resolve por padrão, mas a coleção
  // admitida fria só resolve com `resolveUncached` — senão é descartada.
  assert.equal(playDisposition(generic, { cached: false, resolveUncached: false, degraded: true }), 'resolve');
  assert.equal(playDisposition(admitted, { cached: false, resolveUncached: false, degraded: true }), 'drop');
  assert.equal(playDisposition(admitted, { cached: false, resolveUncached: true, degraded: true }), 'resolve');
  assert.equal(playDisposition(admitted, { cached: true, resolveUncached: false, degraded: true }), 'resolve');
});

test('resolveMultiWork exige ano conhecido', () => {
  assert.deepEqual(resolveMultiWork(INDY, 1981), { collection: INDY, query: 'indiana jones' });
  assert.deepEqual(resolveMultiWork(INDY, null), { collection: null, query: null });
  assert.deepEqual(resolveMultiWork(INDY, ''), { collection: null, query: null });
  assert.deepEqual(resolveMultiWork(null, 1981), { collection: null, query: null });
});

test('startMultiWorkDiscovery: flag desligada não toca a rede', async () => {
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
  try {
    const result = await withFlags({ multiWorkPacks: false }, () =>
      startMultiWorkDiscovery({ imdbId: IMDB, season: null, isDemo: false, deadlineAt: Date.now() + 5000 }),
    );
    assert.equal(result, null);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('não-indexação: pack admitido não entra no índice público da obra', async () => {
  const pack = indyPack();
  try {
    await runtime.run(
      // debrid ativo é precondição de operador para a admissão existir.
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'k' }, encoded: 'cfg-mw' },
      async () => {
        const pool = prepareCandidateStreams([pack], {
          meta: { name: MOVIE_NAME, year: 1981 },
          titles: null as any,
          imdbId: IMDB,
          season: null,
          episode: null,
          isDemo: false,
          multiWork: INDY,
        });
        // Serve a RESPOSTA...
        assert.equal(pool.streams.length, 1);
        assert.equal(pool.streams[0]._multiWork, true);
        assert.equal((pool.streams[0] as any)._multiWorkAdmitted, true);
        // ...mas o pack NÃO é evidência pública de existência da obra isolada.
        const indexed = releaseIndex.lookup(IMDB);
        assert.equal(indexed.some((release: any) => release.hash === HASH), false);
      },
    );
  } finally {
    cache.clearNamespace('idx');
  }
});

test('H2: sob o opt-in, pack sem nomes não gera URL e não cai no maior arquivo', async () => {
  try {
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'k' }, encoded: 'cfg-h2' },
      async () => {
        const pool = prepareCandidateStreams([indyPack()], {
          meta: { year: 1981 }, // sem name => sem nomes => sem dica de obra
          titles: null as any,
          imdbId: IMDB,
          season: null,
          episode: null,
          isDemo: false,
          multiWork: INDY,
        });
        // Sem dica válida o pack sai do lote: nenhum stream de coleção e,
        // portanto, nenhuma URL /resolve que pudesse escolher o maior arquivo.
        assert.equal(pool.streams.filter((s: any) => s._multiWork).length, 0);
      },
    );
  } finally {
    cache.clearNamespace('idx');
  }
});

test('marcador interno _multiWorkAdmitted sobrevive ao dedupe mas não vaza', () => {
  const winner: any = { name: 'win', infoHash: HASH, url: 'http://x/resolve/1', _quality: '1080p', _seeders: 1 };
  const loser: any = { name: 'lose', infoHash: HASH, _multiWork: true, _multiWorkAdmitted: true, _quality: '1080p', _seeders: 1 };
  const merged = dedupeByHash([winner, loser]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]._multiWorkAdmitted, true, 'o merge preserva a admissão de qualquer lado');
  const out = limitReservingBr(merged, { maxResults: 5, brReservedSlots: 1, brReservedPerQuality: 1 });
  assert.equal('_multiWorkAdmitted' in out[0], false, 'campo interno não pode chegar ao cliente');
  assert.equal('_multiWork' in out[0], false);
});

test('não muta o RawItem (o item pode vir do raw cache L1/L2): clona a marca', async () => {
  const input = indyPack();
  const before = JSON.stringify(input);
  try {
    await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'k' }, encoded: 'cfg-nomutate' },
      async () => {
        const pool = prepareCandidateStreams([input], {
          meta: { name: MOVIE_NAME, year: 1981 },
          titles: null as any,
          imdbId: IMDB,
          season: null,
          episode: null,
          isDemo: false,
          multiWork: INDY,
        });
        assert.equal(pool.streams.length, 1);
        assert.equal((pool.streams[0] as any)._multiWorkAdmitted, true);
      },
    );
  } finally {
    cache.clearNamespace('idx');
  }
  // O objeto de entrada (possivelmente o MESMO do cache bruto) não ganha a marca.
  assert.equal(JSON.stringify(input), before);
  assert.equal('_multiWorkAdmitted' in input, false);
});

test('getCollection: lê belongs_to_collection, monta a raiz e cacheia; falha é fail-open', async () => {
  const originalKey = config.tmdb.apiKey;
  const key = `tmdbc:${IMDB}`;
  config.tmdb.apiKey = 'test-tmdb-key';
  const stub = stubFetch((url) => {
    const body = url.includes('/collection/84')
      ? { name: 'Indiana Jones - Coleção', parts: [
        { release_date: '1981-06-12' }, { release_date: '1984-05-23' },
        { release_date: '1989-05-24' }, { release_date: '2008-05-22' },
      ] }
      : url.includes('/movie/89')
        ? { belongs_to_collection: { id: 84, name: 'Indiana Jones Collection' } }
        : { movie_results: [{ id: 89, title: 'Indiana Jones e os Caçadores da Arca Perdida' }] };
    return { ok: true, status: 200, json: async () => body };
  });
  try {
    const info = await getCollection(IMDB, Date.now() + 5000);
    assert.deepEqual(info, { name: 'Indiana Jones - Coleção', root: 'indiana jones', years: [1981, 1984, 1989, 2008] });
    const callsAfterFirst = stub.calls.length;
    // Cache positivo: a segunda leitura não volta à rede.
    assert.deepEqual(await getCollection(IMDB, Date.now() + 5000), info);
    assert.equal(stub.calls.length, callsAfterFirst);
  } finally {
    stub.restore();
    cache.forget(key);
    config.tmdb.apiKey = originalKey;
  }

  // Falha de rede é fail-open: null, sem derrubar a busca.
  const failing = stubFetch(() => {
    throw new Error('fetch failed');
  });
  config.tmdb.apiKey = 'test-tmdb-key';
  try {
    assert.equal(await getCollection(`${IMDB}x`, Date.now() + 5000), null);
  } finally {
    failing.restore();
    cache.forget(`tmdbc:${IMDB}x`);
    config.tmdb.apiKey = originalKey;
  }
});
