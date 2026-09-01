import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import * as cache from '../src/utils/cache.js';
import { buildStreams } from '../src/providers/index.js';
import * as account from '../src/providers/account.js';
import { toStremioStream } from '../src/utils/format.js';
import type { RawItem, Stream } from '../types/domain.js';

process.env.CACHE_PERSIST = 'false';

/**
 * Caso Zombieland medido em produção (2026-08-31): a conta AllDebrid tem Ready
 * "Zumbilândia 2009 [1080p] WWW.BLUDV.COM" e "Zumbilândia (2009) Bluray 1080p
 * Filmes M.H.G", mas nenhum declara Dublado/Dual/PT-BR. `looksPtBr` não marca,
 * `isBr` fica false e com q1=2 os 1080p globais de swarm alto (YTS/Kickass)
 * tomam as vagas e os candidatos da conta somem.
 *
 * Contrato seguro: SÓ o caminho do inventário da conta (`fromAccount`) —
 * origem BR forte via `brOriginMark(title)` marca `isBr`/`_br` para a vaga
 * reservada e NUNCA `_dubbed` (`_dubbed` segue looksPtBr/explicitPtAudio);
 * não promove com `hasExplicitForeignAudio` nem com LEGENDADA/LEG explícito.
 * Indexers/busca/autofetch/limpeza ficam intactos: item de conta continua
 * sem entrar no índice (`release-index` pula `fromAccount`) nem no autofetch
 * (item pronto é pulado pelo `cached.has` e a conta Ready nunca chega a
 * enfileirar nada).
 */

const KEY = 'chave-br-origin';
const H_BLUDV = 'a'.repeat(40);
const H_MHG = 'b'.repeat(40);
const H_LEG = 'c'.repeat(40);
const H_EN = 'd'.repeat(40);
const H_EN2 = 'f'.repeat(40);
const H_DUB = 'e'.repeat(40);

const T_BLUDV = 'Zumbilândia 2009 [1080p] WWW.BLUDV.COM';
const T_MHG = 'Zumbilândia (2009) Bluray 1080p Filmes M.H.G';
const T_LEG = 'Zumbilândia 2009 [1080p] LEGENDADA WWW.BLUDV.COM';
const T_EN = 'Zombieland (2009) 1080p BluRay x264-YIFY';
const T_DUB = 'Zumbilândia (2009) 1080p DUBLADO';

interface AllDebridMagnet {
  id: number;
  hash?: string;
  status: string;
  filename: string;
  ready: boolean;
  size?: number;
}

/** Dublê da API da AllDebrid para o inventário (mesmo formato do debrid-inventory.test.ts). */
function mockAllDebridStatus({ magnetsOf = () => [] }: { magnetsOf?: () => AllDebridMagnet[] } = {}) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/magnet/status')) {
      return { ok: true, async json() { return { status: 'success', data: { magnets: magnetsOf() } }; } };
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

// O json() do common usa AbortSignal.timeout; com o fetch dublado não sobra
// handle vivo e o event loop esvazia antes do fim do arquivo.
let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

/** Roda account.search como a busca faria: dentro da config do usuário. */
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

test('account.search marca origem BR forte (brOriginMark) nos filenames reais do caso Zombieland', async () => {
  cache.clear();
  const api = mockAllDebridStatus({
    magnetsOf: () => [
      { id: 1, hash: H_BLUDV, status: 'Ready', filename: T_BLUDV, ready: true },
      { id: 2, hash: H_MHG, status: 'Ready', filename: T_MHG, ready: true },
      { id: 3, hash: H_LEG, status: 'Ready', filename: T_LEG, ready: true },
      { id: 4, hash: H_EN, status: 'Ready', filename: T_EN, ready: true },
      { id: 5, hash: H_DUB, status: 'Ready', filename: T_DUB, ready: true },
    ],
  });
  try {
    const ctx = { names: ['Zombieland', 'Zumbilândia'], year: 2009, isSeries: false };
    const items = await runWith<RawItem[]>(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: KEY }, encoded: 'seg-br-origin' },
      () => account.search(ctx),
    );
    const porHash = new Map(items.map((i) => [String(i.infoHash), i]));

    // Os dois filenames reais: _br via origem-forte, sem prova de áudio.
    for (const [hash, titulo] of [[H_BLUDV, T_BLUDV], [H_MHG, T_MHG]] as const) {
      const item = porHash.get(hash);
      assert.ok(item, `esperava o item da conta: ${titulo}`);
      assert.equal(item.isBr, true, `isBr (origem BR forte): ${titulo}`);
      assert.equal(item.brOriginOnly, true, `brOriginOnly: ${titulo}`);
    }

    // Contra-caso: BLUDV LEGENDADA não recebe reserva (áudio legendado é prova
    // de que não é dublado, mesmo com origem BR nomeada no título).
    const leg = porHash.get(H_LEG);
    assert.ok(leg, 'esperava o item LEGENDADA');
    assert.equal(leg.isBr, false, 'LEGENDADA não ganha isBr');
    assert.equal(leg.brOriginOnly, false, 'LEGENDADA não ganha reserva');

    // Contra-caso: título EN comum não recebe.
    const en = porHash.get(H_EN);
    assert.ok(en, 'esperava o item EN');
    assert.equal(en.isBr, false, 'título EN não ganha isBr');
    assert.equal(en.brOriginOnly, false, 'título EN não ganha reserva');

    // Regresso: Dublado explícito segue o caminho de sempre (looksPtBr), sem
    // precisar da origem-forte.
    const dub = porHash.get(H_DUB);
    assert.ok(dub, 'esperava o item DUBLADO');
    assert.equal(dub.isBr, true, 'Dublado explícito segue isBr por looksPtBr');
    assert.equal(dub.brOriginOnly, false, 'Dublado explícito não é origem-só');
  } finally {
    api.restore();
    cache.clear();
  }
});

test('toStremioStream: origem BR forte dá _br sem _dubbed e o rótulo não promete DUB', () => {
  for (const titulo of [T_BLUDV, T_MHG]) {
    const stream = toStremioStream({
      title: titulo,
      infoHash: H_BLUDV,
      isBr: true,
      brOriginOnly: true,
      seeders: 1,
      indexer: 'debrid',
      tracker: 'AllDebrid',
    });
    assert.ok(stream, `item com infoHash vira stream: ${titulo}`);
    assert.equal((stream as any)._br, true, `_br marcado: ${titulo}`);
    assert.equal((stream as any)._dubbed, false, `_dubbed NÃO promovido por origem: ${titulo}`);
    assert.match(String(stream.name), /BR/, `rótulo exibe a origem BR: ${String(stream.name)}`);
    assert.doesNotMatch(String(stream.name), /DUB/, `rótulo não promete dublagem: ${String(stream.name)}`);
  }
});

test('toStremioStream: Dual na origem-só não promove; provider/looksPtBr seguem como sempre', () => {
  // Origem-só com "Dual" no título: brOriginMark deu _br, e _dubbed segue a
  // prova explícita (invariante 8.12 — DUAL sem PT não vira dublado por origem).
  const origemDual = toStremioStream({
    title: 'Zumbilândia (2009) Dual Áudio 1080p Filmes M.H.G',
    infoHash: H_MHG,
    isBr: true,
    brOriginOnly: true,
    seeders: 1,
    indexer: 'debrid',
  });
  assert.equal((origemDual as any)._br, true);
  assert.equal((origemDual as any)._dubbed, false);

  // Flag de provider (isBr sem brOriginOnly) com Dual: comportamento de sempre
  // (Dual Áudio reconhecido na origem BR declarada pelo provider).
  const providerDual = toStremioStream({
    title: 'Filme X Dual 1080p',
    infoHash: H_DUB,
    isBr: true,
    seeders: 1,
    indexer: 'comandotorrents',
  });
  assert.equal((providerDual as any)._dubbed, true);

  // looksPtBr (Dublado no título): _dubbed de sempre.
  const dublado = toStremioStream({
    title: T_DUB,
    infoHash: H_DUB,
    isBr: true,
    seeders: 1,
    indexer: 'debrid',
  });
  assert.equal((dublado as any)._dubbed, true);
});

// --- Sobrevivência ao corte final (q1=2) -------------------------------------
//
// Real-Debrid com oráculo desligado = cacheCheck false → known:false sem rede;
// inventário NÃO semeado → sem boost de instant: a sobrevivência só pode vir
// da vaga reservada (`_br`). Com dc=0 o corte que decide é a cota de qualidade
// em limitReservingBr, não o cachedOnly.

function optsZombieland(extra: Record<string, unknown> = {}) {
  return {
    ...runtime.defaults(),
    debridService: 'realdebrid',
    debridApiKey: 'chave-zombieland',
    debridCachedOnly: false,
    autoFetchBr: false,
    max1080p: 2,
    maxResults: 40,
    qualities: ['2160p', '1080p', '720p'],
    minSeeders: 1,
    brReservedSlots: 2,
    brFirst: true,
    preferDubbed: true,
    ...extra,
  };
}

const META = { name: 'Zombieland', year: '2009' };
const TITLES = { original: 'Zombieland', pt: 'Zumbilândia', year: '2009' };

/** Itens como o account.search os emite: comReserva=true é o estado novo; false é o de produção anterior. */
function rawZombieland({ comReserva }: { comReserva: boolean }): RawItem[] {
  return [
    {
      title: T_BLUDV,
      infoHash: H_BLUDV,
      seeders: 1,
      size: 8_000_000_000,
      indexer: 'debrid',
      tracker: 'AllDebrid',
      isBr: comReserva,
      ...(comReserva ? { brOriginOnly: true } : {}),
      fromAccount: true,
    },
    {
      title: T_MHG,
      infoHash: H_MHG,
      seeders: 1,
      size: 8_000_000_000,
      indexer: 'debrid',
      tracker: 'AllDebrid',
      isBr: comReserva,
      ...(comReserva ? { brOriginOnly: true } : {}),
      fromAccount: true,
    },
    {
      title: T_EN,
      infoHash: H_EN,
      seeders: 500,
      indexer: 'yts',
      tracker: 'YTS',
    },
    {
      title: 'Zombieland.2009.1080p.BluRay.x264-KICKASS',
      infoHash: H_EN2,
      seeders: 300,
      indexer: 'kickasstorrents',
      tracker: 'Kickass',
    },
  ];
}

const busca = (raw: RawItem[], extra: Record<string, unknown> = {}) =>
  runWith<Stream[]>(
    { opts: optsZombieland(extra), encoded: `seg-${Math.random()}` },
    () => buildStreams(raw, {
      meta: META,
      titles: TITLES,
      season: null,
      episode: null,
      isDemo: false,
      searchKey: `zombieland-${Math.random()}`,
    } as any),
  );

const ORACLE_SNAPSHOT = { ...config.debrid.rdOracle };
test.afterEach(() => {
  config.debrid.rdOracle.enabled = ORACLE_SNAPSHOT.enabled;
});

test('q1=2: os dois filenames reais da conta sobrevivem contra dois 1080p estrangeiros de seed alto', async () => {
  cache.clear();
  config.debrid.rdOracle.enabled = false;
  const streams = await busca(rawZombieland({ comReserva: true }));
  const nomes = streams.map((s) => String(s.name || '').split('\n')[0]);
  const titulos = streams.map((s) => String(s.title || ''));
  assert.ok(
    titulos.some((t) => t.includes(T_BLUDV)),
    `esperava o BLUDV na lista; saiu: ${JSON.stringify(nomes)}`,
  );
  assert.ok(
    titulos.some((t) => t.includes(T_MHG)),
    `esperava o M.H.G na lista; saiu: ${JSON.stringify(nomes)}`,
  );
  // A reserva fura a cota, não expulsa os outros: os globais continuam.
  assert.ok(titulos.some((t) => t.includes('YTS')), 'YTS continua na lista');
  assert.ok(titulos.some((t) => t.includes('KICKASS')), 'Kickass continua na lista');
  // Rótulo mostra a origem e não promete dublagem.
  const linhaBr = streams.find((s) => String(s.title || '').includes('BLUDV'));
  assert.ok(linhaBr, 'item BLUDV presente');
  assert.match(String(linhaBr.name), /BR/);
  assert.doesNotMatch(String(linhaBr.name), /DUB/);
});

test('contra-prova: sem a origem BR (estado de produção anterior) o q1=2 corta os dois', async () => {
  cache.clear();
  config.debrid.rdOracle.enabled = false;
  const streams = await busca(rawZombieland({ comReserva: false }));
  const titulos = streams.map((s) => String(s.title || ''));
  assert.ok(
    !titulos.some((t) => t.includes('Zumbilândia')),
    `sem reserva, os itens da conta são cortados pelo balde 1080p; saiu: ${JSON.stringify(titulos)}`,
  );
  assert.ok(titulos.some((t) => t.includes('YTS')), 'YTS ocupa as vagas');
});
