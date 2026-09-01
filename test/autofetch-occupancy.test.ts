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

// --- contagem de `active` no TorBox ---------------------------------------
// O gate lê `status.active`. Enquanto o accountStatus somava "tudo que não
// terminou", torrent morto contava como slot ocupado PARA SEMPRE: dez deles
// bloqueavam o Chupim em silêncio, exatamente o defeito que o occupancy veio
// resolver. O parser do mylist e o do torrentStatus agora leem pelo mesmo
// rowState, então nenhum dos dois pode divergir sozinho.
function stubMyList(body: unknown) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

test('accountStatus do TorBox não conta morto nem erro como slot ativo', async () => {
  const restore = stubMyList({
    success: true,
    data: [
      { id: 1, hash: 'a'.repeat(40), download_finished: true },
      { id: 2, hash: 'b'.repeat(40), download_state: 'downloading' },
      { id: 3, hash: 'c'.repeat(40), download_state: 'stalled' },
      { id: 4, hash: 'd'.repeat(40), download_state: 'error' },
      { id: 5, hash: 'e'.repeat(40), download_state: 'failed' },
      { id: 6, hash: 'f'.repeat(40), download_state: 'broken' },
    ],
  });
  try {
    const status = await torbox.accountStatus('chave-de-teste');
    assert.equal(status.magnets, 6, 'o total continua sendo o total');
    assert.equal(status.ready, 1);
    assert.equal(status.active, 2, 'baixando + stalled ocupam slot; os três mortos não');
    assert.deepEqual(torbox.occupancy(status), { used: 2, max: torbox.ACTIVE_LIMIT });
  } finally {
    restore();
  }
});

test('dez torrents mortos no mylist NÃO bloqueiam o gate do TorBox', async () => {
  const restore = stubMyList({
    success: true,
    data: Array.from({ length: 10 }, (_, i) => ({
      id: i, hash: String(i).repeat(40).slice(0, 40), download_state: 'error',
    })),
  });
  try {
    const status = await torbox.accountStatus('chave-de-teste');
    assert.equal(status.active, 0, 'morto não segura vaga');
    assert.equal(torbox.occupancy(status)?.used, 0);
  } finally {
    restore();
  }
  const tb = adapter('torbox-occupancy-dead', async () => torbox.accountStatus('x'), torbox.occupancy);
  const restore2 = stubMyList({
    success: true,
    data: Array.from({ length: 10 }, (_, i) => ({ id: i, hash: 'a'.repeat(40), download_state: 'error' })),
  });
  try {
    assert.equal(autofetch.accountGateBlocked(tb, 'torbox-dead'), false);
    await sleep(20);
    assert.equal(autofetch.accountGateBlocked(tb, 'torbox-dead'), false, 'conta só de mortos segue aberta');
  } finally {
    restore2();
  }
});

test('linha sem download_state conta como ativa; só morte tira a vaga', async () => {
  const restore = stubMyList({
    success: true,
    data: [{ id: 1, hash: 'a'.repeat(40) }, { id: 2, hash: 'b'.repeat(40), download_state: 'quem-sabe' }],
  });
  try {
    const status = await torbox.accountStatus('chave-de-teste');
    // Assimetria deliberada com o torrentStatus: lá `unknown` é "não julgue"
    // porque a decisão é apagar; aqui a pergunta é "ocupa slot?", e sem prova
    // de morte a resposta honesta é sim. O fix mira o morto, não o incerto.
    assert.equal(status.active, 2, 'sem prova de morte a vaga conta como ocupada');
    assert.equal(status.ready, 0);
    assert.equal(status.magnets, 2);
  } finally {
    restore();
  }
});
