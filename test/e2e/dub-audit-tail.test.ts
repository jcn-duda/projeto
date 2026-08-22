// Fase D da auditoria de áudio: o passe tardio prova os candidatos ⚡ dublados
// ANTES de qualquer play. Mentira provada = mesma evidência do play (mag lie +
// idx.lied) + invalidação da lista corrente, para a próxima busca já nascer sem
// o mentiroso. Caso real (True Detective S02E01): packs "DUBLADO" cujo
// conteúdo era release de cena EN (RARBG/KILLERS/afm72/ToVaR).
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
import * as magnetdb from '../../src/utils/magnetdb.js';
import jackett from '../../src/providers/jackett.js';
import { findStreams } from '../../src/providers/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createTestApp() {
  const manifest = {
    id: config.addonId,
    version: config.version,
    name: 'E2E dub audit',
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

test('passe tardio prova o pack DUBLADO em cache e a busca seguinte nasce sem ele', async () => {
  const server: any = http.createServer(createTestApp());
  await new Promise((resolve: any) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = baseUrl;

  const liarHash = 'a'.repeat(39) + '1'; // pack "DUBLADO" com release RARBG dentro
  const goodHash = 'b'.repeat(39) + '2'; // pack dublado DE VERDADE (path com DUBLADO)
  const userApiKey = 'pm-key-dub-audit';

  // Provider traz dois packs BR "dublados": o mentiroso e o legítimo.
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
      title: 'Serie Audit 2ª Temporada Completa (2025) [1080p DUBLADO 15 GB]',
      name: 'Serie Audit 2ª Temporada Completa (2025) [1080p DUBLADO 15 GB]',
      infoHash: goodHash,
      magnet: `magnet:?xt=urn:btih:${goodHash}`,
      seeders: 1,
      size: 15 * 1024 ** 3,
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
      // O adaptador manda URLSearchParams: o magnet chega percent-encoded,
      // então a leitura do hash tem que decodificar o campo `src`.
      const src = new URLSearchParams(String((init as any)?.body || '')).get('src') || '';
      const isLiar = src.includes(liarHash);
      const content = isLiar
        ? [{ path: 'Serie.Audit.S02E01.1080p.WEBRip.x264.DD5.1-RARBG/Serie.Audit.S02E01.1080p.WEBRip.x264.DD5.1-RARBG.mkv', size: 2 * 1024 ** 3, stream_link: 'https://pm.test/liar.mkv' }]
        : [{ path: 'Serie Audit 2ª Temporada (2025)/S02E01 - Dublado 1080p.mp4', size: 2 * 1024 ** 3, stream_link: 'https://pm.test/good.mp4' }];
      return { ok: true, json: async () => ({ status: 'success', content }) } as any;
    }
    return { ok: false, status: 404, json: async () => ({}) } as any;
  }) as any;

  const segment = runtime.encode({ ds: 'premiumize', dk: userApiKey, p: ['jackett'], ji: ['bludv-cardigann'], b: 2 });

  try {
    // 1) Primeira busca: o mentiroso ainda está na lista (sem evidência ainda).
    const res1 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700001:2:1.json`);
    const data1 = await res1.json();
    const urls1 = JSON.stringify(data1.streams || []);
    assert.ok(urls1.includes(liarHash), 'primeira lista traz o pack DUBLADO (mentira ainda não provada)');
    assert.ok(urls1.includes(goodHash), 'primeira lista traz o pack dublado legítimo');

    // 2) O tail prova os candidatos ⚡ dublados: o RARBG é mentira, o legítimo não.
    const auditDeadline = Date.now() + 5000;
    while (Date.now() < auditDeadline && !magnetdb.isLie('premiumize', userApiKey, liarHash)) {
      await sleep(25);
    }
    assert.ok(magnetdb.isLie('premiumize', userApiKey, liarHash), 'tail gravou a evidência de mentira sem play');
    assert.equal(magnetdb.isLie('premiumize', userApiKey, goodHash), false, 'pack dublado legítimo não é condenado');
    assert.ok((metrics.snapshot().counters['debrid.audit.lie.tail'] || 0) >= 1, 'metrica da auditoria tardia registrada');

    // 3) A lista corrente foi invalidada; a próxima busca nasce sem o mentiroso.
    const res2 = await fetch(`${baseUrl}/${segment}/stream/series/tt7700001:2:1.json`);
    const data2 = await res2.json();
    const urls2 = JSON.stringify(data2.streams || []);
    assert.ok(!urls2.includes(liarHash), 'mentiroso cortado da segunda lista');
    assert.ok(urls2.includes(goodHash), 'legítimo permanece (sem falso negativo)');
  } finally {
    jackett.search = originalSearch;
    cache.clear();
    metrics.reset();
    globalThis.fetch = originalFetch;
    config.debrid.publicUrl = originalPublicUrl;
    await new Promise((resolve: any) => server.close(resolve));
  }
});
