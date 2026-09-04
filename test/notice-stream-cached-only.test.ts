import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStreams, applyNoticeOrigin, createFirstObserver } from '../src/providers/index.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as magnetdb from '../src/utils/magnetdb.js';

// Anti Dual sem BR: BR real sumiu no cachedOnly e sobrou Dual/gringo — o aviso
// aponta reabertura (não empurra `bu`). Com bu=true o BR volta P2P.
const BR_H = 'b'.repeat(40);
const GLOBAL_H = 'c'.repeat(40);

test('cachedOnly+bu=false: BR oculto anexa aviso de reabertura; Dual/gringo permanece', async () => {
  const originalResolve = config.debrid.resolveUncached;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.resolveUncached = false;
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.checkCached = async () => ({ cached: new Set([GLOBAL_H]), known: true });
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: true,
    showUncachedBr: false,
    autoFetchBr: false,
  };
  const firstObserver = createFirstObserver(true);
  try {
    const streams = await runtime.run({ opts: userOpts, encoded: 'segcfg' }, async () => {
      const built = await buildStreams(
        [
          { title: 'Filme BR 1080p Dublado', infoHash: BR_H, seeders: 1, indexer: 'comandotorrents', isBr: true },
          { title: 'Movie 2019 1080p Dual Audio', infoHash: GLOBAL_H, seeders: 50, indexer: 'yts' },
        ] as any,
        {
          meta: null,
          titles: null,
          season: null,
          episode: null,
          isDemo: false,
          searchKey: `aviso-brh-${Math.random()}`,
          observeFirstPass: true,
          firstObserver,
          deadlineAt: Date.now() + 5000,
        } as any,
      );
      return applyNoticeOrigin(built);
    });
    const notice = streams.find((s) => s.externalUrl);
    const playable = streams.filter((s) => s.url || s.infoHash);
    assert.ok(notice, 'aviso anexado quando BR sumiu e sobrou gringo');
    assert.match(notice!.name as string, /fora do cache.*reabra/i);
    assert.doesNotMatch(notice!.name as string, /Mostrar BR ainda fora do cache/);
    assert.equal(playable.length, 1, 'só o global cacheado permanece tocável');
    assert.doesNotMatch(String(playable[0].name || ''), /DUAL/, 'Dual global sem PT sem chip DUAL');
    assert.ok(
      logs.some((line) => /brHidden=\d+ ocultos pelo cachedOnly/.test(line)),
      'log da entrada do corte cita brHidden',
    );
  } finally {
    console.log = realLog;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolve;
  }
});

test('cachedOnly+bu=true: BR uncached volta como P2P e sem aviso de reabertura por cachedOnly', async () => {
  const originalResolve = config.debrid.resolveUncached;
  config.debrid.resolveUncached = false;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.checkCached = async () => ({ cached: new Set([GLOBAL_H]), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: true,
    showUncachedBr: true,
    autoFetchBr: false,
  };
  try {
    const streams = await runtime.run({ opts: userOpts, encoded: 'segcfg' }, async () => {
      const built = await buildStreams(
        [
          { title: 'Filme BR 1080p Dublado', infoHash: BR_H, seeders: 1, indexer: 'comandotorrents', isBr: true },
          { title: 'Movie 2019 1080p Dual Audio', infoHash: GLOBAL_H, seeders: 50, indexer: 'yts' },
        ] as any,
        {
          meta: null,
          titles: null,
          season: null,
          episode: null,
          isDemo: false,
          searchKey: `aviso-bu-${Math.random()}`,
        } as any,
      );
      return applyNoticeOrigin(built);
    });
    const br = streams.find((s) => s.infoHash === BR_H);
    assert.ok(br, 'BR uncached preservado como P2P com bu=true');
    assert.equal(br!.url, undefined);
    assert.equal(
      streams.some((s) => /fora do cache.*reabra|Mostrar BR ainda fora do cache/i.test(String(s.name || ''))),
      false,
      'sem aviso de BR oculto quando o BR já está visível',
    );
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolve;
  }
});

test('filtro de título loga (M BR) — M=0 não culpa o matching pelo zero BR', async () => {
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.checkCached = async () => ({ cached: new Set([BR_H]), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: true,
    autoFetchBr: false,
  };
  try {
    await runtime.run({ opts: userOpts, encoded: 'segcfg' }, () =>
      buildStreams(
        [
          { title: 'Lost Girl S01E01 1080p Dublado', infoHash: BR_H, seeders: 1, indexer: 'comando', isBr: true },
          { title: 'Completely Unrelated Movie 1999', infoHash: GLOBAL_H, seeders: 10, indexer: 'yts' },
        ] as any,
        {
          meta: { name: 'Lost Girl', year: '2010' },
          titles: { original: 'Lost Girl', pt: 'Lost Girl', year: '2010' },
          season: 1,
          episode: 1,
          isDemo: false,
          searchKey: `aviso-mbr-${Math.random()}`,
        } as any,
      ),
    );
    assert.ok(
      logs.some((line) => /\(\d+ BR\)/.test(line) && /fora do título/.test(line)),
      'log de título cita (M BR)',
    );
  } finally {
    console.log = realLog;
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
});

// Math.max(pending, bruto−brIn) misturava trust drop com cachedOnly: BR em bad
// + Dual cacheado anexava "reabra" — reabrir não tira hash da blacklist.
test('BR dropado por bad + Dual cacheado: sem notice de reabertura (pendingBrHidden=0)', async () => {
  const originalResolve = config.debrid.resolveUncached;
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const key = 'chave-fake';
  config.debrid.resolveUncached = false;
  config.debrid.publicUrl = 'https://addon.teste';
  debrid.checkCached = async () => ({ cached: new Set([GLOBAL_H]), known: true });
  magnetdb.markBad('premiumize', key, BR_H);
  const firstObserver = createFirstObserver(true);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: key,
    debridCachedOnly: true,
    showUncachedBr: false,
    autoFetchBr: false,
  };
  try {
    const streams = await runtime.run({ opts: userOpts, encoded: 'segcfg' }, async () => {
      const built = await buildStreams(
        [
          { title: 'Filme BR 1080p Dublado', infoHash: BR_H, seeders: 1, indexer: 'comandotorrents', isBr: true },
          { title: 'Movie 2019 1080p Dual Audio', infoHash: GLOBAL_H, seeders: 50, indexer: 'yts' },
        ] as any,
        {
          meta: null,
          titles: null,
          season: null,
          episode: null,
          isDemo: false,
          searchKey: `aviso-bad-${Math.random()}`,
          observeFirstPass: true,
          firstObserver,
          deadlineAt: Date.now() + 5000,
        } as any,
      );
      return applyNoticeOrigin(built);
    });
    const playable = streams.filter((s) => s.url || s.infoHash);
    assert.equal(playable.length, 1, 'só o global cacheado permanece tocável');
    assert.ok(
      playable[0].infoHash === GLOBAL_H || String(playable[0].url || '').includes(GLOBAL_H),
      'o tocável é o Dual/gringo, não o BR bad',
    );
    assert.equal(firstObserver.pendingBrHidden, 0, 'trust prune não conta como cachedOnly');
    assert.equal(
      streams.some((s) => /fora do cache.*reabra/i.test(String(s.name || ''))),
      false,
      'não promete reabertura quando o BR morreu por histórico ruim',
    );
    assert.equal(
      streams.some((s) => /histórico ruim/i.test(String(s.name || ''))),
      false,
      'lista não vazia: sem notice de trust (Dual ainda toca)',
    );
  } finally {
    magnetdb.forgetBad('premiumize', key, BR_H);
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.resolveUncached = originalResolve;
  }
});
