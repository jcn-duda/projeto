// Pack da temporada no passe tardio de TODA busca de série.
//
// Medido em Goliath S03E01 (2026-09-12): a query do episódio trazia release de
// 43 seeders, mas nenhuma estava em cache na AllDebrid, e os packs "Goliath S03"
// (GalaxyTV com 222 seeders) nunca eram consultados — o gatilho antigo só
// buscava pack com o episódio "fraco" (ninguém com 3+ seeders), e tracker
// titula pack sem SxxEyy, então a query do episódio jamais o encontra. Estes
// testes fixam que o pack é consultado mesmo com episódio saudável e que o
// kill-switch continua desligando a busca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import { findStreams } from '../src/providers/index.js';
import jackett from '../src/providers/jackett.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (seed: string) => crypto.createHash('sha1').update(seed).digest('hex');

const EPISODE_HASH = hash('goliath-s03e01-amzn-ntb');
const PACK_HASH = hash('goliath-s03-complete-galaxytv');
const PACK_QUERY = 'Goliath S03';

function release(title: string, infoHash: string, seeders: number) {
  return {
    title,
    name: title,
    infoHash,
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`,
    seeders,
    size: 2 * 1024 * 1024 * 1024,
    tracker: 'thepiratebay',
    indexer: 'thepiratebay',
    isBr: false,
  };
}

interface Found { streams: Array<{ infoHash?: string }>; partial?: boolean }

// Sem debrid de propósito: a lista sai P2P (infoHash visível) e o autofetch não
// entra no caminho — o que se mede aqui é só quais queries a busca dispara.
function searchAs(id: string): Promise<Found> {
  const opts = {
    ...runtime.defaults(),
    providers: ['jackett'],
    jackettIndexers: ['thepiratebay'],
    debridService: '',
    debridApiKey: '',
    dubbedOnly: false,
  };
  return runtime.run({ opts, encoded: `pack-tail-${id}` }, () => findStreams({ type: 'series', id })) as Promise<Found>;
}

async function withGoliathStubs(run: (queries: string[]) => Promise<void>) {
  const queries: string[] = [];
  const originalSearch = jackett.search;
  const originalFetch = global.fetch;
  const originalBludv = config.bludv.enabled;
  const originalIndex = config.releaseIndex.enabled;
  // Colhedor e scraper direto semeiam buscas em segundo plano que sobreviveriam
  // ao teste e tocariam a rede depois de restaurar os stubs.
  config.bludv.enabled = false;
  config.releaseIndex.enabled = false;
  global.fetch = (async (url: unknown) => {
    if (String(url).includes('cinemeta')) {
      return { ok: true, status: 200, json: async () => ({ meta: { name: 'Goliath', year: '2016–2021' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof global.fetch;
  jackett.search = async (query: string) => {
    queries.push(query);
    if (/S03E01/i.test(query)) {
      return [release('Goliath S03E01 The Subsidence Adventure 1080p AMZN WEB-DL DDP5 1 H 264-NTb', EPISODE_HASH, 43)];
    }
    if (query === PACK_QUERY) {
      return [release('Goliath.S03.COMPLETE.720p.AMZN.WEBRip.x264-GalaxyTV', PACK_HASH, 222)];
    }
    return [];
  };
  try {
    await run(queries);
  } finally {
    jackett.search = originalSearch;
    global.fetch = originalFetch;
    config.bludv.enabled = originalBludv;
    config.releaseIndex.enabled = originalIndex;
  }
}

const hasHash = (found: Found, h: string) => found.streams.some((s) => s?.infoHash === h);

test('episódio saudável ainda dispara o pack da temporada e o pack entra na lista', async () => {
  await withGoliathStubs(async (queries) => {
    const id = 'tt91000001:3:1';
    const first = await searchAs(id);
    assert.ok(hasHash(first, EPISODE_HASH), 'a resposta traz o episódio saudável');

    // O pack roda no tail: espera a consulta e a reescrita do cache.
    let latest = first;
    for (let i = 0; i < 60 && !hasHash(latest, PACK_HASH); i += 1) {
      await sleep(50);
      if (queries.includes(PACK_QUERY)) latest = await searchAs(id);
    }
    assert.ok(queries.includes(PACK_QUERY), `pack consultado mesmo com episódio de 43 seeders (queries: ${queries.join(' | ')})`);
    assert.ok(hasHash(latest, PACK_HASH), 'o pack da temporada entra na lista reescrita');
    assert.ok(hasHash(latest, EPISODE_HASH), 'mesclar preserva a release do episódio');
  });
});

test('SEARCH_PACK_TAIL=false não consulta o pack', async () => {
  const originalTail = config.search.packTail;
  config.search.packTail = false;
  try {
    await withGoliathStubs(async (queries) => {
      const id = 'tt91000002:3:1';
      const first = await searchAs(id);
      assert.ok(hasHash(first, EPISODE_HASH));
      await sleep(300);
      assert.equal(queries.includes(PACK_QUERY), false, `kill-switch desliga a busca do pack (queries: ${queries.join(' | ')})`);
      assert.equal(hasHash(await searchAs(id), PACK_HASH), false);
    });
  } finally {
    config.search.packTail = originalTail;
  }
});
