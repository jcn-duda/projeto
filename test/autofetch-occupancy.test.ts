import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as autofetch from '../src/providers/autofetch.js';
import debrid from '../src/debrid/index.js';
import * as torbox from '../src/debrid/torbox.js';
import type { AccountStatus, DebridAdapter } from '../types/domain.js';

const originalPauseAt = config.debrid.autoFetchPauseAt;
const originalRefreshMs = config.debrid.autoFetchPauseRefreshMs;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function adapter(
  id: string,
  status: () => Promise<AccountStatus>,
  occupancy?: (value: AccountStatus) => { used: number; max: number } | null,
): DebridAdapter {
  return {
    id,
    label: id,
    short: id.slice(0, 2),
    cacheCheck: true,
    keyUrl: '',
    checkCached: async () => ({ cached: new Set(), complete: true }),
    resolveLink: async () => null,
    accountStatus: status,
    ...(occupancy ? { occupancy } : {}),
  };
}

beforeEach(() => {
  config.debrid.autoFetchPauseAt = 800;
  config.debrid.autoFetchPauseRefreshMs = 900_000;
  autofetch.resetAccountGate();
});

after(() => {
  config.debrid.autoFetchPauseAt = originalPauseAt;
  config.debrid.autoFetchPauseRefreshMs = originalRefreshMs;
  autofetch.resetAccountGate();
});

test('gate legado sem occupancy preserva magnets >= pauseAt', async () => {
  const full = adapter('alldebrid-legacy-full', async () => ({ magnets: 900 }));
  assert.equal(autofetch.accountGateBlocked(full, 'legacy-full'), false, 'memo frio é fail-open');
  await sleep(20);
  assert.equal(autofetch.accountGateBlocked(full, 'legacy-full'), true, '900 >= 800 bloqueia');
  const measured = autofetch.accountGateSnapshot().accounts[0];
  assert.deepEqual(
    { count: measured.count, max: measured.max, source: measured.source, blocked: measured.blocked },
    { count: 900, max: 800, source: 'accountStatus', blocked: true },
  );

  autofetch.resetAccountGate();
  const calm = adapter('alldebrid-legacy-calm', async () => ({ magnets: 799 }));
  assert.equal(autofetch.accountGateBlocked(calm, 'legacy-calm'), false);
  await sleep(20);
  assert.equal(autofetch.accountGateBlocked(calm, 'legacy-calm'), false, '799 < 800 segue aberto');
});

test('TorBox com 900 itens e 2 ativos NÃO bloqueia', async () => {
  const tb = adapter(
    'torbox-occupancy-calm',
    async () => ({ magnets: 900, ready: 898, active: 2 }),
    torbox.occupancy,
  );
  assert.equal(autofetch.accountGateBlocked(tb, 'torbox-calm'), false, 'memo frio é fail-open');
  await sleep(20);
  assert.equal(autofetch.accountGateBlocked(tb, 'torbox-calm'), false, '2/10 ativos segue aberto');
  const measured = autofetch.accountGateSnapshot().accounts[0];
  assert.deepEqual(
    { count: measured.count, max: measured.max, blocked: measured.blocked },
    { count: 2, max: torbox.ACTIVE_LIMIT, blocked: false },
  );
});

test('TorBox bloqueia quando os 10 slots ativos estão ocupados', async () => {
  const tb = adapter(
    'torbox-occupancy-full',
    async () => ({ magnets: 900, ready: 890, active: torbox.ACTIVE_LIMIT }),
    torbox.occupancy,
  );
  assert.equal(autofetch.accountGateBlocked(tb, 'torbox-full'), false);
  await sleep(20);
  assert.equal(autofetch.accountGateBlocked(tb, 'torbox-full'), true, '10/10 ativos bloqueia');
});

test('occupancy sem medição válida permanece fail-open', async () => {
  const unknown = adapter(
    'torbox-occupancy-unknown',
    async () => ({ magnets: 900 }),
    torbox.occupancy,
  );
  assert.equal(autofetch.accountGateBlocked(unknown, 'torbox-unknown'), false);
  await sleep(20);
  assert.equal(autofetch.accountGateBlocked(unknown, 'torbox-unknown'), false);
  assert.deepEqual(autofetch.accountGateSnapshot().accounts, [], 'sem active não inventa decisão');
});

test('registry liga occupancy só no TorBox; Premiumize fica fora do patch', () => {
  const tb = debrid.BY_ID.get('torbox') as DebridAdapter;
  const pm = debrid.BY_ID.get('premiumize') as DebridAdapter;
  assert.equal(typeof tb.occupancy, 'function');
  assert.equal(pm.occupancy, undefined);
});
