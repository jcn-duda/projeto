// Tail de auditoria de episódio: o passe tardio prova os candidatos ⚡ em cache
// cujo título NÃO nomeia o episódio pedido. Caso real (True Detective S03E02):
// o pack "2ª Temporada [1080p DUBLADO]" continha só o arquivo S02E07 — o
// usuário pedia o E01 e o fallback tocava outro episódio em silêncio. O tail
// prova ANTES do play, grava a prova fina no índice (miss: só ESTE episódio)
// e a próxima busca já nasce sem o mentiroso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import sdk from 'stremio-addon-sdk';
const { addonBuilder, getRouter } = sdk;

process.env.CACHE_PERSIST = 'false';

import config from '../../src/config.js';
import * as runtime from '../../src/runtime.js';
import debrid from '../../src/debrid/index.js';
import * as cache from '../../src/utils/cache.js';
import * as metrics from '../../src/utils/metrics.js';
import * as releaseIndex from '../../src/utils/release-index.js';
import jackett from '../../src/providers/jackett.js';
import { findStreams } from '../../src/providers/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestApp() {
  const manifest = {
    id: config.addonId,
    version: config.version,
    name: 'E2E episode audit',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { adult: false, configurable: true, configurationRequired: false },
  };
  const builder = new addonBuilder(manifest);
  builder.defineStreamHandler(async (args) => {
    try {
      const { streams, partial } = await findStreams({ type: args.type, id: args.id });
      if (!streams.length || partial) return { streams, cacheMaxAge: 0 };
      return { streams, cacheMaxAge: config.cacheTtl, staleRevalidate: config.cacheTtl * 4, staleError: 86400 };
    } catch {
      return { streams: [], cacheMaxAge: 0 };
    }
  });
  const app = express();
  app.use(getRouter(builder.getInterface()));
  app.use('/:userConfig', (req: any, res: any, next: any) => {
    const parsed = runtime.decode(req.params.userConfig);
    if (!parsed) return res.status(404).send('configuração inválida');
    runtime.run({ opts: parsed, encoded: req.params.userConfig }, () => next());
  });
  app.use('/:userConfig', getRouter(builder.getInterface()));
  return app;
}

test('tail prova que o pack de temporada contém OUTRO episódio e a busca seguinte nasce sem ele', async () => {
  const server: any = http.createServer(createTestApp());
  await new Promise((resolve: any) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = baseUrl;

  const liarHash = 'a'.repeat(39) + '3'; // pack de temporada cujo ÚNICO vídeo é o S02E07
  const goodHash = 'b'.repeat(39) + '4'; // release legítimo do episódio pedido
  const userApiKey = 'pm-key-ep-audit';

  // Provider traz o pack que declara só a temporada e o release legítimo.
  const originalSearch = jackett.search;
  jackett.search = async () => [
    {
      title: 'Serie Audit 2ª Temporada (2025) [1080p DUBLADO 20 GB]',
      name: 'Serie Audit 2ª Temporada (2025) [1080p DUBLADO 20 GB]',
      infoHash: liarHash,
      magnet: `magnet:?xt=urn:btih:${liarHash}`,
      seeders: 1,
      size: 20 * 1024 ** 3,
      isBr: true,
      tracker: 'bludv-cardigann',
    },
    {
      title: 'Serie Audit S02E01 Dublado (2025) 1080p WEB',
      name: 'Serie Audit S02E01 Dublado (2025) 1080p WEB',
      infoHash: goodHash,
      magnet: `magnet:?xt=urn:btih:${goodHash}`,
      seeders: 1,
      size: 2 * 1024 ** 3,
      isBr: true,
      tracker: 'bludv-cardigann',
    },
  ];

  // Premiumize: cache confirma os dois; o directdl entrega a VERDADE por hash.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : String((input as any)?.url || input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    if (url.includes('cinemeta.strem.io')) {
      return { ok: true, json: async () => ({ meta: { name: 'Serie Audit', year: '2025–' } }) } as any;
    }
    if (url.includes('themoviedb.org')) {
      return { ok: true, json: async () => ({ tv_results: [{ name: 'Serie Audit', original_name: 'Serie Audit', first_air_date: '2025-01-01' }] }) } as any;
    }
    if (url.includes('premiumize.me/api/cache/check')) {
      return { ok: true, json: async () => ({ status: 'success', response: [true, true] }) } as any;
    }
    if (url.includes('premiumize.me/api/transfer/directdl')) {
      const src = new URLSearchParams(String((init as any)?.body || '')).get('src') || '';
      const isLiar = src.includes(liarHash);
      const content = isLiar
        // O pack promete a temporada 2 mas contém UM vídeo: o episódio 7.
        ? [{ path: 'Serie.Audit.S02E07.1080p.WEB-DL.mkv', size: 2 * 1024 ** 3, stream_link: 'https://pm.test/liar.mkv' }]
        : [{ path: 'Serie Audit S02E01 Dublado 1080p/S02E01 - Dublado 1080p.mp4', size: 2 * 1024 ** 3, stream_link: 'https://pm.test/good.mp4' }];
      return { ok: true, json: async () => ({ status: 'success', content }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;

  const segment = runtime.encode({ ds: 'premiumize', dk: userApiKey, p: ['jackett'], ji: ['bludv-cardigann'], b: 2 });

  try {
    // 1) Primeira busca: o pack ainda está na lista (sem evidência ainda).
    const res1 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700002:2:1.json`);
    const data1 = await res1.json();
    const urls1 = JSON.stringify(data1.streams || []);
    assert.ok(urls1.includes(liarHash), 'primeira lista traz o pack de temporada (prova ainda não feita)');
    assert.ok(urls1.includes(goodHash), 'primeira lista traz o release legítimo do episódio');

    // 2) O tail prova o candidato: o único vídeo declara S02E07, não o E01.
    const auditDeadline = Date.now() + 5000;
    while (Date.now() < auditDeadline && !releaseIndex.isMissing('tt7700002', { season: 2, episode: 1 }, liarHash)) {
      await sleep(25);
    }
    assert.ok(
      releaseIndex.isMissing('tt7700002', { season: 2, episode: 1 }, liarHash),
      'tail gravou a prova fina (miss) sem play',
    );
    // A prova é por episódio: o mesmo pack continua valendo para o E07.
    assert.equal(
      releaseIndex.isMissing('tt7700002', { season: 2, episode: 7 }, liarHash),
      false,
      'o miss não condena os outros episódios do pack',
    );
    assert.ok((metrics.snapshot().counters['debrid.audit.episode'] || 0) >= 1, 'metrica da auditoria de episódio registrada');

    // 3) A lista corrente foi invalidada; a próxima busca nasce sem o pack.
    const res2 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700002:2:1.json`);
    const data2 = await res2.json();
    const urls2 = JSON.stringify(data2.streams || []);
    assert.ok(!urls2.includes(liarHash), 'pack com episódio errado cortado da segunda lista');
    assert.ok(urls2.includes(goodHash), 'release legítimo permanece (sem falso negativo)');
  } finally {
    jackett.search = originalSearch;
    cache.clear();
    metrics.reset();
    globalThis.fetch = originalFetch;
    config.debrid.publicUrl = originalPublicUrl;
    await new Promise((resolve: any) => server.close(resolve));
  }
});

test('tail prova que o pack multi-arquivo é de OUTRA temporada e corta a temporada inteira', async () => {
  const server: any = http.createServer(createTestApp());
  await new Promise((resolve: any) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = baseUrl;

  const wrongSeasonPackHash = 'c'.repeat(39) + '1'; // pack que diz ser da temporada 3 mas arquivos são da T01
  const goodHash = 'd'.repeat(39) + '2'; // release legítimo da temporada 3
  const userApiKey = 'pm-key-ep-audit-2';

  const originalSearch = jackett.search;
  jackett.search = async () => [
    {
      title: 'Serie Audit - 3ª Temporada Completa [720p DUAL]',
      name: 'Serie Audit - 3ª Temporada Completa [720p DUAL]',
      infoHash: wrongSeasonPackHash,
      magnet: `magnet:?xt=urn:btih:${wrongSeasonPackHash}`,
      seeders: 2,
      size: 15 * 1024 ** 3,
      isBr: true,
      tracker: 'bludv-cardigann',
    },
    {
      title: 'Serie Audit S03E01 Dublado (2025) 1080p WEB',
      name: 'Serie Audit S03E01 Dublado (2025) 1080p WEB',
      infoHash: goodHash,
      magnet: `magnet:?xt=urn:btih:${goodHash}`,
      seeders: 1,
      size: 2 * 1024 ** 3,
      isBr: true,
      tracker: 'bludv-cardigann',
    },
  ];

  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : String((input as any)?.url || input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    if (url.includes('cinemeta.strem.io')) {
      return { ok: true, json: async () => ({ meta: { name: 'Serie Audit', year: '2025–' } }) } as any;
    }
    if (url.includes('themoviedb.org')) {
      return { ok: true, json: async () => ({ tv_results: [{ name: 'Serie Audit', original_name: 'Serie Audit', first_air_date: '2025-01-01' }] }) } as any;
    }
    if (url.includes('premiumize.me/api/cache/check')) {
      return { ok: true, json: async () => ({ status: 'success', response: [true, true] }) } as any;
    }
    if (url.includes('premiumize.me/api/transfer/directdl')) {
      const src = new URLSearchParams(String((init as any)?.body || '')).get('src') || '';
      const isLiar = src.includes(wrongSeasonPackHash);
      const content = isLiar
        ? [
            { path: 'Serie Audit 1 Temporada/Serie Audit - T01E01 - Pilot.mkv', size: 1.5 * 1024 ** 3, stream_link: 'https://pm.test/t01e01.mkv' },
            { path: 'Serie Audit 1 Temporada/Serie Audit - T01E02 - Part 2.mkv', size: 1.5 * 1024 ** 3, stream_link: 'https://pm.test/t01e02.mkv' },
            { path: 'Serie Audit 1 Temporada/Serie Audit - T01E03 - Part 3.mkv', size: 1.5 * 1024 ** 3, stream_link: 'https://pm.test/t01e03.mkv' },
          ]
        : [{ path: 'Serie Audit S03E01 Dublado 1080p/S03E01 - Dublado 1080p.mp4', size: 2 * 1024 ** 3, stream_link: 'https://pm.test/good3.mp4' }];
      return { ok: true, json: async () => ({ status: 'success', content }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;

  const segment = runtime.encode({ ds: 'premiumize', dk: userApiKey, p: ['jackett'], ji: ['bludv-cardigann'], b: 2 });

  try {
    // 1) Primeira busca para S03E01: ambos aparecem
    const res1 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700003:3:1.json`);
    const data1 = await res1.json();
    const urls1 = JSON.stringify(data1.streams || []);
    assert.ok(urls1.includes(wrongSeasonPackHash), 'primeira busca traz o pack');
    assert.ok(urls1.includes(goodHash), 'primeira busca traz o release legítimo');

    // 2) Aguarda tail provar temporada errada
    const auditDeadline = Date.now() + 5000;
    while (Date.now() < auditDeadline && !releaseIndex.isMissing('tt7700003', { season: 3, episode: 1 }, wrongSeasonPackHash)) {
      await sleep(25);
    }
    assert.ok(
      releaseIndex.isMissing('tt7700003', { season: 3, episode: 1 }, wrongSeasonPackHash),
      'tail gravou miss em S03E01',
    );
    // Também deve ter gravado missSeason em S3: E02 e E03 de S3 também dão missing!
    assert.ok(
      releaseIndex.isMissing('tt7700003', { season: 3, episode: 2 }, wrongSeasonPackHash),
      'missSeason cobre S03E02 sem precisar de novo play/audit',
    );
    assert.ok(
      releaseIndex.isMissing('tt7700003', { season: 3, episode: 3 }, wrongSeasonPackHash),
      'missSeason cobre S03E03',
    );
    // E NÃO condena a temporada 1
    assert.equal(
      releaseIndex.isMissing('tt7700003', { season: 1, episode: 1 }, wrongSeasonPackHash),
      false,
      'não condena S1',
    );
    assert.ok((metrics.snapshot().counters['debrid.audit.episode'] || 0) >= 1, 'métrica de auditoria de episódio registrada');

    // 3) Segunda busca para S03E01: nasce sem o pack
    const res2 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700003:3:1.json`);
    const data2 = await res2.json();
    const urls2 = JSON.stringify(data2.streams || []);
    assert.ok(!urls2.includes(wrongSeasonPackHash), 'pack da temporada errada sumiu de S03E01');
    assert.ok(urls2.includes(goodHash), 'release legítimo permanece');

    // 4) Busca para S03E02: também nasce sem o pack graças ao missSeason
    const res3 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700003:3:2.json`);
    const data3 = await res3.json();
    const urls3 = JSON.stringify(data3.streams || []);
    assert.ok(!urls3.includes(wrongSeasonPackHash), 'pack da temporada errada também sumiu de S03E02 pelo missSeason');
  } finally {
    jackett.search = originalSearch;
    cache.clear();
    metrics.reset();
    globalThis.fetch = originalFetch;
    config.debrid.publicUrl = originalPublicUrl;
    await new Promise((resolve: any) => server.close(resolve));
  }
});

