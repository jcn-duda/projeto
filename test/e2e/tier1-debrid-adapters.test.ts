// Rodada 2: checagem ligada; tier 1 (cobertura de features) tipado.
// remover arquivo a arquivo na rodada 2.
// A suíte precisa ser idêntica no Node 18 e no Node 22, sem criar SQLite local.
process.env.CACHE_PERSIST = 'false';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import {
  fakeResponse,
  makeTorznabXml,
  makeCinemetaMeta,
  makeTmdbFind,
  createMockFetch,
  withMockFetch,
  createTestApp,
  createTestServer,
  encodeConfig,
  decodeConfig,
  signResolve,
  verifyResolve,
} from './e2e-harness.js';

import config from '../../src/config.js';
import * as runtime from '../../src/runtime.js';
import * as format from '../../src/utils/format.js';
import * as cache from '../../src/utils/cache.js';
import * as brResolvers from '../../src/br-resolvers.js';
import * as jackettCatalog from '../../src/providers/jackett-catalog.js';
import prowlarr from '../../src/providers/prowlarr.js';
import debrid from '../../src/debrid/index.js';
import * as protectedHashes from '../../src/debrid/protected.js';
import * as searchPlan from '../../src/providers/search-plan.js';
import { createLatestWriter } from '../../src/utils/latest-writer.js';
import type { Stream } from '../../types/domain.js';

const TEST_HASH_1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TEST_HASH_2 = '11223344556677889900aabbccddeeff00112233';
const TEST_HASH_3 = '99887766554433221100ffeeddccbbaa99887766';

// ════════════════════════════════════════════════════════════════════════════════
describe('Feature 10: Debrid Adapter Mock & Error Coverage', () => {
  it('10.1: Premiumize adapter: checkCached e resolveLink', async () => {
    const pmAdapter = debrid.BY_ID.get('premiumize');
    assert.ok(pmAdapter);
    assert.equal(pmAdapter.cacheCheck, true);

    await withMockFetch(
      [
        {
          match: 'premiumize.me/api/cache/check',
          handler: () => fakeResponse({ status: 'success', response: [true, false] }),
        },
        {
          match: 'premiumize.me/api/transfer/directdl',
          handler: () =>
            fakeResponse({
              status: 'success',
              content: [{ path: 'Movie.mp4', link: 'https://pm.test/dl/Movie.mp4', size: 1000 }],
            }),
        },
      ],
      async () => {
        const res = await pmAdapter.checkCached('pm-key', [TEST_HASH_1, TEST_HASH_2]) as { cached: Set<string>; complete?: boolean };
        assert.ok(res.cached.has(TEST_HASH_1));
        assert.equal(res.cached.has(TEST_HASH_2), false);

        const link = await pmAdapter.resolveLink('pm-key', TEST_HASH_1, {});
        assert.equal(link, 'https://pm.test/dl/Movie.mp4');
      }
    );
  });

  it('10.2: Real-Debrid adapter: checkCached e resolveLink operam fluxo completo', async () => {
    const rdAdapter = debrid.BY_ID.get('realdebrid');
    assert.ok(rdAdapter);
    assert.equal(rdAdapter.cacheCheck, false);

    await withMockFetch(
      [
        {
          match: 'api.real-debrid.com/rest/1.0/torrents/addMagnet',
          handler: () => fakeResponse({ id: 'rd-torrent-123' }),
        },
        {
          match: 'api.real-debrid.com/rest/1.0/torrents/info/rd-torrent-123',
          handler: () =>
            fakeResponse({
              id: 'rd-torrent-123',
              status: 'downloaded',
              files: [{ id: 1, path: '/Movie.mp4', bytes: 1024 * 1024 * 500, selected: 1 }],
              links: ['https://real-debrid.com/d/LINK123'],
            }),
        },
        {
          match: 'api.real-debrid.com/rest/1.0/torrents/selectFiles/rd-torrent-123',
          handler: () => fakeResponse({}, { status: 204 }),
        },
        {
          match: 'api.real-debrid.com/rest/1.0/unrestrict/link',
          handler: () => fakeResponse({ download: 'https://download.real-debrid.com/file.mp4' }),
        },
      ],
      async () => {
        const rawCached = await rdAdapter.checkCached('rd-key', [TEST_HASH_1]) as { cached: Set<string>; complete?: boolean };
        assert.equal(rawCached.cached.size, 0); assert.equal(rawCached.complete, false);

        await runtime.run({ opts: { debridService: 'realdebrid', debridApiKey: 'rd-key' } }, async () => {
          const res = await debrid.checkCached([TEST_HASH_1]);
          assert.equal(res.known, false);
          assert.equal(res.cached.size, 0);
        });

        const link = await rdAdapter.resolveLink('rd-key', TEST_HASH_1, {});
        assert.equal(link, 'https://download.real-debrid.com/file.mp4');
      }
    );
  });

  it('10.3: AllDebrid adapter: resolveLink desbloqueia link direto', async () => {
    const adAdapter = debrid.BY_ID.get('alldebrid');
    assert.ok(adAdapter);

    await withMockFetch(
      [
        {
          match: 'api.alldebrid.com/v4.1/magnet/upload',
          handler: () =>
            fakeResponse({
              status: 'success',
              data: {
                magnets: [
                  {
                    id: 'ad-mag-1',
                    status: 'Ready',
                  },
                ],
              },
            }),
        },
        {
          match: 'api.alldebrid.com/v4.1/magnet/status',
          handler: () =>
            fakeResponse({
              status: 'success',
              data: {
                magnets: {
                  id: 'ad-mag-1',
                  status: 'Ready',
                  files: [
                    { n: 'Movie.mp4', s: 1024 * 1024 * 500, l: 'https://alldebrid.com/dl/123' },
                  ],
                },
              },
            }),
        },
        {
          match: 'api.alldebrid.com/v4.1/link/unlock',
          handler: () =>
            fakeResponse({
              status: 'success',
              data: { link: 'https://stream.alldebrid.com/direct.mp4' },
            }),
        },
      ],
      async () => {
        const link = await adAdapter.resolveLink('ad-key', TEST_HASH_1, {});
        assert.equal(link, 'https://stream.alldebrid.com/direct.mp4');
      }
    );
  });

  it('10.4: TorBox adapter: checkCached e resolveLink', async () => {
    const tbAdapter = debrid.BY_ID.get('torbox');
    assert.ok(tbAdapter);
    assert.equal(tbAdapter.cacheCheck, true);

    await withMockFetch(
      [
        {
          match: 'api.torbox.app/v1/api/torrents/checkcached',
          handler: () =>
            fakeResponse({
              success: true,
              data: { [TEST_HASH_1]: { name: 'Movie' } },
            }),
        },
        {
          match: 'api.torbox.app/v1/api/torrents/createtorrent',
          handler: () => fakeResponse({ success: true, data: { torrent_id: 999 } }),
        },
        {
          match: 'api.torbox.app/v1/api/torrents/mylist',
          handler: () =>
            fakeResponse({
              success: true,
              data: [
                {
                  id: 999,
                  download_finished: true,
                  files: [{ id: 1, name: 'Movie.mp4', size: 1024 * 1024 * 500 }],
                },
              ],
            }),
        },
        {
          match: 'api.torbox.app/v1/api/torrents/requestdl',
          handler: () => fakeResponse({ success: true, data: 'https://dl.torbox.app/direct.mp4' }),
        },
      ],
      async () => {
        const cachedRes = await tbAdapter.checkCached('tb-key', [TEST_HASH_1]) as { cached: Set<string>; complete?: boolean };
        assert.ok(cachedRes.cached.has(TEST_HASH_1));

        const link = await tbAdapter.resolveLink('tb-key', TEST_HASH_1, {});
        assert.equal(link, 'https://dl.torbox.app/direct.mp4');
      }
    );
  });

  it('10.5: Debrid-Link adapter: falha de API no resolveLink lança erro tratado defensivamente', async () => {
    const dlAdapter = debrid.BY_ID.get('debridlink');
    assert.ok(dlAdapter);

    await withMockFetch(
      {
        match: 'debrid-link.com/api/v2/seedbox/add',
        handler: () => fakeResponse({ success: false, error: 'bad_token' }, { status: 401 }),
      },
      async () => {
        await assert.rejects(
          async () => dlAdapter.resolveLink('bad-key', TEST_HASH_1, {}),
          /HTTP 401/
        );
      }
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE 11: Torznab XML CDATA Resilience
// ════════════════════════════════════════════════════════════════════════════════
