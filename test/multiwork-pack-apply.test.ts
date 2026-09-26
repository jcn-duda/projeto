// Integração de `applyDebrid` para o pack BR multiobra nativo (BR_MULTIWORK_PACKS,
// achados M4 e H1): cachedOnly/showUncachedBr/resolveUncached, sem adapter, adapter
// unusable e o warmer RD. O pack ADMITIDO (`_multiWorkAdmitted`) nunca vira
// torrent P2P inteiro, nunca é oferecido sem dica de obra e nunca entra no
// warmer/autofetch; `_multiWork` genérico (não admitido) mantém o comportamento
// anterior.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { applyDebrid } from '../src/providers/index.js';
import { prepareCandidateStreams } from '../src/providers/stream-builder.js';
import { pickFile } from '../src/debrid/file-selector.js';
import * as cache from '../src/utils/cache.js';
import rdWarmer from '../src/providers/rd-warmer.js';
import type { Stream } from '../types/domain.js';

const MOVIE_NAME = 'Indiana Jones e os Caçadores da Arca Perdida';
const WORK_HINT = { n: [MOVIE_NAME], y: 1981 };
const HASH = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

const admitted = (h: string): Stream => ({
  name: '[AD] Indiana Jones - A Coleção Completa',
  title: 'Indiana Jones - A Coleção Completa 1981-2008 Dublado 1080p',
  infoHash: h,
  _br: true,
  _dubbed: true,
  _quality: '1080p',
  _seeders: 5,
  _multiWork: true,
  _multiWorkAdmitted: true,
} as Stream);

const normal = (h: string): Stream => ({
  name: 'Coringa Dublado',
  title: 'Coringa 2019 Dublado 1080p',
  infoHash: h,
  _br: true,
  _dubbed: true,
  _quality: '1080p',
  _seeders: 50,
} as Stream);

function run<T>(opts: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return runtime.run({ opts: { ...runtime.defaults(), ...opts }, encoded: 'cfg-mw' }, fn) as Promise<T>;
}

function withHarness(
  { checkCached, publicUrl = 'http://addon.test', resolveUncached = false, originalUrl = config.debrid.publicUrl }:
  { checkCached: any; publicUrl?: string; resolveUncached?: boolean; originalUrl?: string },
  fn: () => Promise<void>,
) {
  const originalCheck = debrid.checkCached;
  const originalEnqueue = debrid.enqueue;
  const originalWarmEnqueue = rdWarmer.enqueue;
  const originalResolveUncached = config.debrid.resolveUncached;
  const warmCalls: string[] = [];
  const enqueueCalls: string[] = [];
  debrid.checkCached = checkCached;
  debrid.enqueue = (async (_h: string) => { enqueueCalls.push(_h); return true; }) as any;
  (rdWarmer as any).enqueue = (hashes: string[]) => { warmCalls.push(...hashes); };
  config.debrid.publicUrl = publicUrl;
  config.debrid.resolveUncached = resolveUncached;
  return fn()
    .finally(() => {
      debrid.checkCached = originalCheck;
      debrid.enqueue = originalEnqueue;
      (rdWarmer as any).enqueue = originalWarmEnqueue;
      config.debrid.resolveUncached = originalResolveUncached;
      config.debrid.publicUrl = originalUrl;
    })
    .then(() => ({ warmCalls, enqueueCalls }));
}

test('applyDebrid sem adapter: pack admitido sai, genérico permanece', async () => {
  const out = await run({ debridService: 'alldebrid', debridApiKey: '' }, () =>
    applyDebrid([admitted(HASH), normal(OTHER)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
  ) as Stream[];
  assert.equal(out.some((s) => s.infoHash === HASH), false, 'multiobra admitido não pode ir P2P sem debrid');
  assert.equal(out.some((s) => s.infoHash === OTHER), true);
});

test('applyDebrid adapter unusable: pack admitido sai, o resto volta P2P', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: false, unusable: { reason: 'auth' } }) },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k' }, () =>
        applyDebrid([admitted(HASH), normal(OTHER)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      assert.equal(out.some((s) => s.infoHash === HASH), false);
      assert.equal(out.some((s) => s.infoHash === OTHER), true);
    },
  );
});

test('applyDebrid cached: pack admitido vira URL /resolve com dica (p:1) e ⚡', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set([HASH]), known: true }) },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: true, showUncachedBr: false }, () =>
        applyDebrid([admitted(HASH)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      assert.equal(out.length, 1);
      const [first] = out;
      assert.ok(first);
      assert.equal(first.infoHash, undefined, 'nunca P2P inteiro');
      assert.ok(String(first.name).includes('⚡'));
      assert.ok(first.url?.includes('/resolve/'));
      const w = decodeURIComponent(new URL(String(first.url), 'http://x').searchParams.get('w') || '');
      assert.ok(w.includes('"p":1'), 'dica assinada marca pack multiobra');
      assert.ok(w.includes(MOVIE_NAME));
    },
  );
});

test('applyDebrid uncached sem resolveUncached: pack admitido é descartado (nem P2P nem URL)', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: true }), resolveUncached: false },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: false, showUncachedBr: false }, () =>
        applyDebrid([admitted(HASH), normal(OTHER)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      assert.equal(out.some((s) => s.infoHash === HASH || s.url?.includes(HASH)), false, 'multiobra uncached não é oferecido');
      assert.equal(out.some((s) => s.infoHash === OTHER), true);
    },
  );
});

test('applyDebrid uncached com resolveUncached: pack admitido sai por /resolve [download]', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: true }), resolveUncached: true },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: false, showUncachedBr: false }, () =>
        applyDebrid([admitted(HASH)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      assert.equal(out.length, 1);
      const [first] = out;
      assert.ok(first);
      assert.ok(first.url?.includes(`/resolve/${HASH}`));
      assert.ok(String(first.name).includes('download'));
      assert.equal(first.infoHash, undefined);
    },
  );
});

test('applyDebrid cachedOnly + showUncachedBr=false: pack admitido uncached não vaza como P2P', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: true }) },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: true, showUncachedBr: false }, () =>
        applyDebrid([admitted(HASH)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      assert.equal(out.length, 0);
    },
  );
});

test('p:1 legado: multiobra genérico (sem admissão) mantém a dica de pack', async () => {
  // `p:1` é comportamento PRÉ-EXISTENTE e independente do BR_MULTIWORK_PACKS:
  // nasce do `_multiWork` (heurística de título) e nunca foi feature-scoped.
  const generic = { ...admitted(HASH), _multiWorkAdmitted: false } as Stream;
  await withHarness(
    { checkCached: async () => ({ cached: new Set([HASH]), known: true }) },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: true, showUncachedBr: false }, () =>
        applyDebrid([generic], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      const [first] = out;
      assert.ok(first);
      const w = decodeURIComponent(new URL(String(first.url), 'http://x').searchParams.get('w') || '');
      assert.ok(w.includes('"p":1'), 'p:1 pré-existente, fora do flag');
    },
  );
});

test('known:false degradado: coleção admitida fria não resolve sem resolveUncached', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: false }) },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: false, showUncachedBr: false }, () =>
        applyDebrid([admitted(HASH)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      assert.equal(out.length, 0, 'coleção fria descartada no ramo degradado');
    },
  );
});

test('known:false degradado com resolveUncached: coleção admitida sai por /resolve', async () => {
  await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: false }), resolveUncached: true },
    async () => {
      const out = await run({ debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: false, showUncachedBr: false }, () =>
        applyDebrid([admitted(HASH)], { workHint: WORK_HINT, imdbId: 'tt0082971' } as any),
      ) as Stream[];
      const [first] = out;
      assert.ok(first);
      assert.ok(String(first.url).includes(`/resolve/${HASH}`));
    },
  );
});

test('H1: warmer RD não recebe pack admitido — nenhum probe/addMagnet', async () => {
  const spies = await withHarness(
    { checkCached: async () => ({ cached: new Set(), known: true }) },
    async () => {
      const out = await run(
        {
          debridService: 'realdebrid', debridApiKey: 'k', debridCachedOnly: false, showUncachedBr: false,
          autoFetchBr: true,
        },
        () => applyDebrid([admitted(HASH)], { workHint: WORK_HINT, imdbId: 'tt0082971', searchKey: 'mw-h1' } as any),
      ) as Stream[];
      assert.equal(out.length, 0, 'sem resolveUncached o admitido sai da lista');
    },
  );
  // Nem o warmer (probe/addMagnet) nem o autofetch receberam o pack admitido.
  assert.equal(spies.warmCalls.length, 0);
  assert.equal(spies.enqueueCalls.length, 0);
});

// G1 — admissão SÓ pela evidência do `dn=` (título do filme isolado): o item tem
// de chegar ao play como pack. `toStremioStream` derivava `_multiWork` do título
// e o admitido ficava `_multiWorkAdmitted:true` mas `_multiWork:false` — o
// `viaDebrid` omitia `p:1` e o `pickFile` caía no maior arquivo (filme errado).
test('G1: admitido só pelo dn= vira pack no play (p:1) e escolhe o filme certo', async () => {
  const HASH_G1 = 'd'.repeat(40);
  const INDY = { name: 'Indiana Jones - Coleção', root: 'indiana jones', years: [1981, 1984, 1989, 2008] };
  // Título do filme isolado (sem palavra/faixa de coleção) + magnet cujo `dn=`
  // é quem declara a coleção.
  const dnOnly = {
    title: `${MOVIE_NAME} 1981 Dublado 1080p`,
    infoHash: HASH_G1,
    magnet: `magnet:?xt=urn:btih:${HASH_G1}&dn=Indiana.Jones.Collection.1981-2008.DUAL.1080p`,
    isBr: true,
    seeders: 3,
    indexer: 'bludv-cardigann',
  };
  const savedUrl = config.debrid.publicUrl;
  const originalCheck = debrid.checkCached;
  config.debrid.publicUrl = 'http://addon.test';
  debrid.checkCached = (async () => ({ cached: new Set([HASH_G1]), known: true })) as any;
  try {
    const { url } = await run(
      {
        debridService: 'alldebrid', debridApiKey: 'k', debridCachedOnly: true,
        showUncachedBr: false, autoFetchBr: false,
      },
      async () => {
        // 1) Pipeline real: a admissão tem de virar `_multiWork` (o blocker G1).
        const pool = prepareCandidateStreams([dnOnly], {
          meta: { name: MOVIE_NAME, year: 1981 },
          titles: null,
          imdbId: 'tt0082971',
          season: null,
          episode: null,
          isDemo: false,
          multiWork: INDY,
        });
        assert.equal(pool.streams.length, 1, 'o pack admitido pelo dn= entra na lista');
        const admittedStream = pool.streams[0] as any;
        assert.equal(admittedStream._multiWorkAdmitted, true);
        assert.equal(admittedStream._multiWork, true, 'admitido pelo dn= também é pack');
        // 2) O play assina a dica de pack.
        const out = await applyDebrid(pool.streams, { workHint: pool.workHint, imdbId: 'tt0082971' } as any) as Stream[];
        return { url: String(out[0]?.url || '') };
      },
    );
    const w = JSON.parse(decodeURIComponent(new URL(url, 'http://x').searchParams.get('w') || ''));
    assert.equal(w.p, 1, 'dica assinada marca pack (p:1)');

    // 3) Com a dica decodificada, o pickFile escolhe a Arca Perdida — não o
    //    maior arquivo (o outro filme nem entra no pool por cobertura < 0.7).
    const files = [
      { path: 'Indiana Jones e os Caçadores da Arca Perdida/Indiana.Jones.E.OS.Cacadores.Da.Arca.Perdida.1080p.mkv', size: 4 * 1024 ** 3 },
      { path: 'Indiana Jones e o Templo da Perdição/Indiana.Jones.Templo.Da.Perdicao.1080p.mkv', size: 9 * 1024 ** 3 },
    ];
    const picked = pickFile(files, { work: { names: w.n, year: w.y, pack: w.p === 1 } });
    assert.ok(picked && String(picked.path || '').includes('Arca Perdida'), 'tem de escolher o filme da obra, não o maior');
    assert.ok(Number(picked?.size || 0) < 9 * 1024 ** 3, 'não pode ser o maior arquivo');
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = savedUrl;
    cache.clearNamespace('idx');
  }
});
