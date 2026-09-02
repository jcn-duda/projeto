// Rodada 2: checagem ligada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as torbox from '../src/debrid/torbox.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import * as cache from '../src/utils/cache.js';
import { filterRelevantRaw as relevantRaw, filterInventoryRelevant } from '../src/utils/format.js';
import { buildStreams } from '../src/providers/index.js';
import * as account from '../src/providers/account.js';
import type { InventoryItem, RawItem, Stream } from '../types/domain.js';

process.env.CACHE_PERSIST = 'false';

// A conta do debrid como fonte de streams: o que o usuário JÁ tem pronto entra na
// busca com ⚡, sem depender de indexer. Contratos: o adaptador filtra não-prontos
// e filename===hash; o registry memoiza por serviço+conta sem vazar entre scopes;
// falha não fica cacheada; o teto de itens é respeitado; item de inventário é
// preexistente (dropReady não o apaga); a relevância aceita pack de franquia da
// MESMA obra (caso real: FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS p/ Star Trek
// TMP) e rejeita o que o caminho estrito dos indexers rejeita.

const KEY_A = 'chave-conta-a';
const KEY_B = 'chave-conta-b';
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);
const H5 = '5'.repeat(40);

/** Magnet do /magnet/status da AllDebrid — o que o inventário lê. */
interface AllDebridMagnet {
  id: number;
  hash?: string;
  status: string;
  filename: string;
  ready: boolean;
  size?: number;
}

/** Linha do /torrents/mylist do TorBox. */
interface TorBoxRow {
  hash?: string;
  name: string;
  size: number;
  download_finished: boolean;
  download_present?: boolean;
}

// Dublê base: troca fetch/AbortSignal.timeout e restaura no fim.
function mockFetch(handler: (url: URL) => unknown) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: any) => handler(new URL(String(input)))) as unknown as typeof globalThis.fetch;
  return {
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

/** Dublê da API da AllDebrid para o inventário (v4.1 responde {status, data}). */
function mockAllDebridStatus({ magnetsOf = () => [], failOf = () => false }: { magnetsOf?: () => AllDebridMagnet[]; failOf?: () => boolean } = {}) {
  const calls: (string | null)[] = [];
  const api = mockFetch((url: URL) => {
    if (!url.pathname.endsWith('/magnet/status')) throw new Error(`URL inesperada no teste: ${url.pathname}`);
    calls.push(url.searchParams.get('id') || null);
    if (failOf()) throw new Error('serviço fora do ar');
    return { ok: true, async json() { return { status: 'success', data: { magnets: magnetsOf() } }; } };
  });
  return { calls, restore: api.restore };
}

/** Dublê da API do TorBox: /torrents/mylist sem id devolve a conta inteira. */
function mockTorBoxList({ rows = [] }: { rows?: TorBoxRow[] } = {}) {
  const api = mockFetch((url: URL) => {
    if (!url.pathname.endsWith('/torrents/mylist')) throw new Error(`URL inesperada no teste: ${url.pathname}`);
    return { ok: true, async json() { return { data: rows }; } };
  });
  return { restore: api.restore };
}

// O json() do common usa AbortSignal.timeout; com o fetch dublado não sobra
// handle vivo e o event loop esvazia antes do fim do arquivo.
let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

// Roda dentro da config do usuário; runtime.run devolve unknown, o helper fixa o tipo.
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

const inventoryOf = (apiKey: string, service = 'alldebrid'): Promise<InventoryItem[]> =>
  runtime.run(
    { opts: { ...runtime.defaults(), debridService: service, debridApiKey: apiKey }, encoded: 'seginv' },
    () => debrid.inventory(),
  ) as Promise<InventoryItem[]>;

test('adaptador AllDebrid: só item pronto e com filename de verdade', async () => {
  const api = mockAllDebridStatus({
    magnetsOf: () => [
      { id: 1, hash: H1, status: 'Ready', filename: 'Star Trek Collection 1979-2016', ready: true, size: 22_450_000_000 },
      { id: 2, hash: H2, status: 'Downloading', filename: 'Ainda baixando.mkv', ready: false },
      { id: 3, hash: H3, status: 'Ready', filename: H3.toUpperCase(), ready: true }, // filename===hash: metadado não resolvido
      { id: 4, status: 'Ready', filename: 'Sem hash.mkv', ready: true },
    ],
  });
  try {
    const items = await alldebrid.inventory(KEY_A);
    assert.deepEqual(items, [{ title: 'Star Trek Collection 1979-2016', infoHash: H1, size: 22_450_000_000 }]);
  } finally {
    api.restore();
  }
});

test('adaptador TorBox: download_finished ou download_present, com nome', async () => {
  const api = mockTorBoxList({
    rows: [
      { hash: H1, name: 'Lost Girl S01 720p', size: 100, download_finished: true, download_present: false },
      { hash: H2, name: 'Filme baixando', size: 100, download_finished: false, download_present: true },
      { hash: H3, name: 'Ainda na fila', size: 100, download_finished: false, download_present: false },
      { hash: H4, name: H4, size: 100, download_finished: true },
      { name: 'Sem hash', size: 100, download_finished: true },
    ],
  });
  try {
    const items = await torbox.inventory(KEY_A);
    assert.deepEqual(items.map((i) => i.infoHash), [H1, H2]);
  } finally {
    api.restore();
  }
});

test('registry memoiza por conta e não vaza entre accountScopes', async () => {
  cache.clear();
  let magnets = [{ id: 1, hash: H1, status: 'Ready', filename: 'Da conta A', ready: true }];
  const api = mockAllDebridStatus({ magnetsOf: () => magnets });
  try {
    const first = await inventoryOf(KEY_A);
    assert.equal(first.length, 1);

    const memoHit = await inventoryOf(KEY_A);
    assert.equal(memoHit.length, 1);
    assert.equal(api.calls.length, 1, 'segunda leitura da MESMA conta vem do memo');

    magnets = [{ id: 2, hash: H2, status: 'Ready', filename: 'Da conta B', ready: true }];
    const other = await inventoryOf(KEY_B);
    assert.equal(api.calls.length, 2, 'conta diferente paga a própria leitura');
    assert.deepEqual(other.map((i) => i.title), ['Da conta B'], 'memo de A não serve para B');
  } finally {
    api.restore();
    cache.clear();
  }
});

test('falha do inventário não fica cacheada: a próxima busca tenta de novo', async () => {
  cache.clear();
  let fail = true;
  const api = mockAllDebridStatus({
    magnetsOf: () => [{ id: 1, hash: H1, status: 'Ready', filename: 'Pronto', ready: true }],
    failOf: () => fail,
  });
  try {
    await assert.rejects(inventoryOf(KEY_B), /serviço fora do ar/);
    fail = false; // Sem memo da falha: serviço voltou, segunda chamada refaz a leitura.
    const items = await inventoryOf(KEY_B);
    assert.equal(items.length, 1);
    assert.equal(api.calls.length, 2);
  } finally {
    api.restore();
    cache.clear();
  }
});

test('teto de itens: conta degenerada não entra inteira no memo', async () => {
  cache.clear();
  const original = config.debrid.inventoryMax;
  config.debrid.inventoryMax = 3;
  const api = mockAllDebridStatus({
    magnetsOf: () => [H1, H2, H3, H4, H5].map((hash, i) => ({
      id: i, hash, status: 'Ready', filename: `Item ${i}`, ready: true,
    })),
  });
  try {
    const items = await inventoryOf(KEY_A);
    assert.equal(items.length, 3);
  } finally {
    config.debrid.inventoryMax = original;
    api.restore();
    cache.clear();
  }
});

test('item do inventário é preexistente: o dropReady não o apaga da conta', async () => {
  cache.clear();
  const DO_USUARIO = H1;
  const DA_CHECAGEM = H2;
  const IDS = { [DO_USUARIO]: 1000, [DA_CHECAGEM]: 2000 };
  const deleted: number[] = [];
  const api = mockFetch((url: URL) => {
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) {
      return body({ magnets: [{ id: IDS[DO_USUARIO], hash: DO_USUARIO, status: 'Ready', filename: 'Acervo do usuário' }] });
    }
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      return body({ magnets: hashes.map((hash) => ({ hash, ready: true, id: IDS[hash] ?? 999 })) });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deleted.push(Number(url.searchParams.get('id')));
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  });

  try {
    // Primeira checagem carrega o inventário (fail-safe: não remove prontos);
    // a segunda é a que prova a proteção.
    await alldebrid.checkCached(KEY_B, [DO_USUARIO, DA_CHECAGEM]);
    await new Promise((resolve) => setImmediate(resolve));
    await alldebrid.checkCached(KEY_B, [DO_USUARIO, DA_CHECAGEM]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(deleted, [IDS[DA_CHECAGEM]], 'só o que a checagem subiu é removido; o acervo fica');
  } finally {
    api.restore();
    cache.clear();
  }
});

// Contexto real de tt0079945 (Star Trek: The Motion Picture): nomes do catálogo,
// com o título pt localizado que gera a raiz da franquia.
const TREK = {
  names: ['Star Trek: The Motion Picture', 'Jornada nas Estrelas: O Filme'],
  year: 1979,
  isSeries: false,
};
const FILMOGRAFIA = 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR';

test('relevância: pack de franquia é aceito do inventário e rejeitado de indexer', () => {
  const item = { title: FILMOGRAFIA, infoHash: H1, seeders: 1 };
  // Indexers: a regra de prefixo ("filmografia" ≠ "star"/"jornada") rejeita — é
  // por isso que o título nunca apareceu vindo de tracker. Inventário: estar na
  // conta é sinal forte; a raiz da franquia ("jornada nas estrelas"/"star trek")
  // casa com o título do pack.
  assert.deepEqual(relevantRaw([item], TREK), []);
  assert.deepEqual(filterInventoryRelevant([item], TREK), [item]);
});

test('relevância: pack de OUTRA franquia não é aceito nem do inventário', () => {
  const items = [
    { title: 'COLEÇÃO COMPLETA STAR WARS DUBLADO', infoHash: H1, seeders: 1 },
    { title: 'Star Wars Collection 1977-2019', infoHash: H2, seeders: 1 },
  ];
  assert.deepEqual(filterInventoryRelevant(items, TREK), []);
});

test('relevância: nome não-latino (CJK) no inventário não aprova nada (fail-closed)', () => {
  const item = { title: 'Suzume (2022) 1080p DUBLADO', infoHash: H1, seeders: 1 };
  // Alias CJK não gera token: nega o caminho estrito e a raiz de franquia fica
  // vazia — nada do inventário passa (vazamento da conta inteira na obra só-CJK).
  assert.deepEqual(filterInventoryRelevant([item], { names: ['すずめの戸締まり'], year: 2022, isSeries: false }), []);
  // Contraprova: com o nome latino real na lista, o mesmo item volta a entrar.
  assert.deepEqual(filterInventoryRelevant([item], { names: ['Suzume', 'すずめの戸締まり'], year: 2022, isSeries: false }), [item]);
});

test('relevância: Lost Girl S01-S05 continua passando pelo caminho normal', () => {
  const ctx = { names: ['Lost Girl'], year: 2010, isSeries: true, season: 1, episode: 2 };
  const items = [
    { title: 'Lost Girl (2010) S01-S05 DUBLADO 720p', infoHash: H1, seeders: 5 },
    { title: 'Lost.Girl.S01.720p.x265-ZMNT', infoHash: H2, seeders: 6 },
  ];
  assert.equal(relevantRaw(items, ctx).length, 2);
  assert.equal(filterInventoryRelevant(items, ctx).length, 2);
});

test('relevância: pack de franquia de série já passa pelo caminho normal', () => {
  // O caminho estrito de série não tem regra de prefixo (a identidade é pelo
  // marcador de episódio): a coleção da própria obra entra direto; a exceção fica
  // só no filme, onde a regra de prefixo do matchesTitleStructure mata o pack.
  const ctx = { names: ['Lost Girl'], year: 2010, isSeries: true, season: 1, episode: 2 };
  const item = { title: 'FILMOGRAFIA COMPLETA LOST GIRL', infoHash: H1, seeders: 1 };
  assert.equal(relevantRaw([item], ctx).length, 1);
  assert.equal(filterInventoryRelevant([item], ctx).length, 1);
});

test('relevância: pack real "Dual Áudio ... By-LuaHarper" passa no inventário', () => {
  // Fixture do caso REAL de produção (2026-08-31): o pack declara só "Dual Áudio"
  // (sem "Dublado") e traz o watermark "By-LuaHarper". Precisão 4/6 = 0.667 contra
  // o piso 0.65 de filme — dois tokens de ruído a mais reprovariam o pack inteiro
  // por título. Travado aqui para a margem não se fechar silenciosamente.
  const ctx = { names: ['The Hangover', 'Se Beber, Não Case'], year: 2009, isSeries: false };
  const item = {
    title: 'Trilogia - Se Beber, Não Case! (2009-2013) 5.1 BluRay Dual Áudio 1080p By-LuaHarper',
    infoHash: H1,
    seeders: 1,
  };
  assert.deepEqual(filterInventoryRelevant([item], ctx), [item]);
});

test('buildStreams preserva o pack de franquia da conta e o entrega via /resolve', async () => {
  const HASH_FILM = 'f'.repeat(40);
  const raw = [{
    title: FILMOGRAFIA, infoHash: HASH_FILM, seeders: 1, size: 22_450_000_000,
    indexer: 'debrid', isBr: false, fromAccount: true,
  }];
  const originalCheck = debrid.checkCached;
  debrid.checkCached = async () => ({ cached: new Set([HASH_FILM]), known: true });
  try {
    const streams = await runWith<Stream[]>(
      {
        opts: {
          ...runtime.defaults(),
          debridService: 'alldebrid',
          debridApiKey: KEY_A,
          debridCachedOnly: true,
          autoFetchBr: false,
        },
        encoded: 'seginv',
      },
      () => buildStreams(raw, {
        meta: { name: 'Star Trek: The Motion Picture', year: '1979' },
        titles: null,
        season: null,
        episode: null,
        isDemo: false,
        searchKey: `inv-${Math.random()}`,
      } as any),
    );
    assert.equal(streams.length, 1);
    assert.match(streams[0].title as string, /FILMOGRAFIA/i);
    assert.ok(streams[0].url, 'item pronto da conta sai pelo /resolve (com ⚡)');
  } finally {
    debrid.checkCached = originalCheck;
  }
});

test('account.search avalia itens pt-BR com matchesBrTitle (invariante 5)', async () => {
  cache.clear();
  const api = mockAllDebridStatus({
    magnetsOf: () => [
      { id: 1, hash: H1, status: 'Ready', filename: 'Coringa (2019) 1080p Dublado', ready: true }, // obra correta dublada
      { id: 2, hash: H2, status: 'Ready', filename: 'Coringa: Delírio a Dois (2024) 1080p Dublado', ready: true }, // sequência cortada por ano/prefixo
    ],
  });
  try {
    const ctx = { names: ['Joker', 'Coringa'], year: 2019, isSeries: false };
    const items = await runWith<RawItem[]>(
      {
        opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: KEY_A },
        encoded: 'seginv2',
      },
      () => account.search(ctx),
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].infoHash as string, H1);
    assert.equal(items[0].isBr, true);
  } finally {
    api.restore();
    cache.clear();
  }
});
