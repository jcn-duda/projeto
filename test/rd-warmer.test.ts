import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as rdLedger from '../src/debrid/rd-ledger.js';
import { rdGate } from '../src/debrid/rd-gate.js';
import * as activity from '../src/providers/activity.js';
import rdWarmer from '../src/providers/rd-warmer.js';

const [H1, H2, H3, H4, H5] = ['1', '2', '3', '4', '5'].map(c => c.repeat(40));

const savedConfig = { service: config.debrid.service, apiKey: config.debrid.apiKey, allowEnvKey: config.debrid.allowEnvKey, rdWarm: { ...config.debrid.rdWarm }, rdLedger: { ...config.debrid.rdLedger }, rdGate: { ...config.debrid.rdGate } };

function restoreConfig() {
  config.debrid.service = savedConfig.service;
  config.debrid.apiKey = savedConfig.apiKey;
  config.debrid.allowEnvKey = savedConfig.allowEnvKey;
  config.debrid.rdWarm = { ...savedConfig.rdWarm };
  config.debrid.rdLedger = { ...savedConfig.rdLedger };
  config.debrid.rdGate = { ...savedConfig.rdGate };
}

function mockFetch(handler: (url: URL, init?: RequestInit) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const calls: { url: URL; method: string }[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: String(init?.method || 'GET').toUpperCase() });
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

function jsonOk(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test.beforeEach(() => {
  restoreConfig();
  cache.clearNamespace('rdc');
  cache.clearNamespace('rdq');
  metrics.reset();
  rdLedger.reset();
  rdGate.reset();
  rdWarmer.reset();

  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = 'test-api-key';
  config.debrid.allowEnvKey = true;
  config.debrid.rdWarm.enabled = true;
  config.debrid.rdWarm.idleWindowMs = 0;
  config.debrid.rdWarm.batch = 10;
  config.debrid.rdWarm.maxPerHour = 300;
  config.debrid.rdLedger.enabled = true;
  config.debrid.rdGate.minGapMs = 0;
  config.debrid.rdGate.cooldownMs = 0;
});

test.afterEach(() => {
  restoreConfig();
  rdGate.reset();
});

test('rd-warmer: fila sobrevive ao "restart" (recarrega da chave)', () => {
  rdWarmer.enqueue([H1], 10);
  rdWarmer.enqueue([H2], 50);
  rdWarmer.enqueue([H3], 30);

  let st = rdWarmer.status();
  assert.equal(st.queueDepth, 3);

  // Simula restart do processo limpando a memória interna do warmer
  rdWarmer.reset();

  // Ao consultar status ou enfileirar algo, a fila é recarregada do cache
  st = rdWarmer.status();
  assert.equal(st.queueDepth, 3, 'fila foi restaurada da chave do cache');

  // Enfileira mais um hash para verificar que a ordenação e a persistência continuam
  rdWarmer.enqueue([H4], 40);
  assert.equal(rdWarmer.status().queueDepth, 4);
});

test('rd-warmer: tráfego recente pula o tick', async () => {
  config.debrid.rdWarm.idleWindowMs = 60_000;
  activity.noteUserRequest();

  const mock = mockFetch(() => jsonOk({ id: 'T1' }));
  try {
    rdWarmer.enqueue([H1], 100);
    await rdWarmer.tick();

    assert.equal(mock.calls.length, 0, 'não executou chamadas de rede com tráfego recente');
    assert.equal(rdWarmer.status().queueDepth, 1, 'item permaneceu na fila');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: 429 devolve hash à fila', async () => {
  rdWarmer.enqueue([H1], 100);
  rdWarmer.enqueue([H2], 50);

  const mock = mockFetch(() => jsonOk({ error: 'too_many_requests' }, 429));
  try {
    await rdWarmer.tick();

    const st = rdWarmer.status();
    assert.equal(st.queueDepth, 2, 'hash devolvido à frente da fila no 429');
    const counters = metrics.snapshot().counters as Record<string, number>;
    assert.equal(counters['debrid.rd.warm.requeued'], 1);
  } finally {
    mock.restore();
  }
});

test('rd-warmer: hash já conhecido pelo ledger nunca vira chamada', async () => {
  rdLedger.noteHit([H1]);
  rdLedger.noteBlocked(H2);
  rdLedger.noteMiss(H3);

  const probedHashes: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet' && init?.method === 'POST') {
      const decodedBody = decodeURIComponent(String(init.body || ''));
      const m = decodedBody.match(/([a-fA-F0-9]{40})/);
      if (m) probedHashes.push(m[1].toLowerCase());
      return jsonOk({ id: 'T1' });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/info/')) {
      return jsonOk({ id: 'T1', status: 'downloaded', files: [] });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/delete/')) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    }
    return jsonOk({}, 404);
  });

  try {
    // H1 (hit), H2 (blocked) nem chegam a ser inseridos no enqueue se já conhecidos; H3 (miss) é pulado no tick
    rdWarmer.enqueue([H1, H2, H3, H4], 10);

    await rdWarmer.tick();

    assert.deepEqual(probedHashes, [H4], 'apenas hash desconhecido virou chamada');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: enqueue deduplica', () => {
  rdWarmer.enqueue([H1], 10);
  rdWarmer.enqueue([H1], 50); // atualiza score
  rdWarmer.enqueue([H2, H2], 20); // deduplica no mesmo array

  const st = rdWarmer.status();
  assert.equal(st.queueDepth, 2, 'apenas 2 hashes únicos na fila');
});

test('rd-warmer: drain processa e devolve contagem', async () => {
  rdWarmer.enqueue([H1, H2, H3, H4, H5], 10);

  let addCalls = 0;
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet' && init?.method === 'POST') {
      addCalls += 1;
      return jsonOk({ id: `T${addCalls}` });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/info/')) {
      return jsonOk({ id: 'T1', status: 'downloaded', files: [] });
    }
    if (url.pathname.startsWith('/rest/1.0/torrents/delete/')) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    }
    return jsonOk({}, 404);
  });

  try {
    const res = await rdWarmer.drain(3);

    assert.equal(res.processed, 3, 'processou exatamente 3 itens');
    assert.equal(res.queueRemaining, 2, 'restam 2 itens na fila');
    assert.equal(addCalls, 3, 'foram feitas 3 chamadas');
    assert.equal(rdWarmer.status().queueDepth, 2);
  } finally {
    mock.restore();
  }
});

test('rd-warmer: serviço que não é Real-Debrid não vira sonda nem miss no ledger', async () => {
  // A guarda antiga (`service !== 'realdebrid' && typeof probeInstant !== 'function'`)
  // nunca disparava: instalação AllDebrid sondava api.real-debrid.com com a
  // chave errada e gravava o 401 como miss no ledger GLOBAL.
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = 'chave-de-alldebrid';
  const mock = mockFetch(() => jsonOk({ error: 'bad token' }, 401));
  try {
    rdWarmer.enqueue([H1], 100);
    await rdWarmer.tick();
    assert.deepEqual(mock.calls, [], 'nenhuma chamada de rede com outro debrid configurado');
    assert.equal(rdLedger.peek(H1), 'unknown', 'ledger global não pode receber veredito de outro serviço');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: DELETE de limpeza que falha não transforma ⚡ em miss', async () => {
  // O rawRemoveTorrent roda no `finally` da sonda; lançando ali, ele substituía
  // o `{instant:true}` e o warmer gravava miss (backoff de até 3 dias) num hash
  // que ESTÁ em cache.
  const mock = mockFetch((url, init) => {
    if (String(init?.method || 'GET').toUpperCase() === 'DELETE') return jsonOk({ error: 'boom' }, 500);
    if (url.pathname.endsWith('/torrents/addMagnet')) return jsonOk({ id: 'T-CLEAN' });
    if (url.pathname.includes('/torrents/info/')) return jsonOk({ status: 'downloaded', files: [], links: [] });
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    rdWarmer.enqueue([H2], 100);
    await rdWarmer.tick();
    assert.equal(rdLedger.peek(H2), 'hit', 'a sonda viu downloaded; a limpeza não pode apagar a evidência');
    assert.equal(mock.calls.some((c) => c.method === 'DELETE'), true, 'a limpeza foi tentada');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: confirmação de ⚡ promove entrada [RD download] para [RD⚡] no cache ativo', async () => {
  const searchKey = 'streams:v10:movie:ttWarmPromote:cfg';
  cache.set(searchKey, {
    streams: [
      {
        name: '[RD download] 1080p',
        title: 'Filme.2026.1080p',
        url: `http://localhost:7000/prefix/resolve/${H1}?sig=test`,
      },
    ],
    partial: false,
    debridKnown: true,
  }, 900);

  const mock = mockFetch((url) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet') return jsonOk({ id: 'T-PROMOTE' });
    if (url.pathname.includes('/torrents/info/')) {
      return jsonOk({
        id: 'T-PROMOTE',
        status: 'downloaded',
        files: [{ id: 1, path: '/Filme.mkv', bytes: 1000, selected: 1 }],
      });
    }
    if (url.pathname.includes('/torrents/delete/')) return { ok: true, status: 204, async json() { return null; }, async text() { return ''; } };
    return jsonOk({}, 404);
  });

  try {
    rdWarmer.enqueue([H1], 100);
    await rdWarmer.tick();

    assert.equal(rdLedger.peek(H1), 'hit');
    const entry = cache.get(searchKey) as any;
    assert.ok(entry && Array.isArray(entry.streams));
    assert.equal(entry.streams[0].name, '[RD⚡] 1080p', 'stream foi promovido de [RD download] para [RD⚡]');
  } finally {
    mock.restore();
    cache.forget(searchKey);
  }
});

test('rd-warmer: credencial vinda da URL destrava o aquecimento sem .env', async () => {
  // A config selada na URL do app nunca chega ao .env. Exigir
  // config.debrid.service === 'realdebrid' deixava a F3 inteira inerte numa
  // instalação que só configura o debrid pelo link de instalação.
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = '';
  rdWarmer.reset();
  assert.equal(rdWarmer.rdInPlay(), false, 'sem .env e sem requisição, nada aquece');

  rdWarmer.noteCredential('chave-rd-da-url');
  assert.equal(rdWarmer.rdInPlay(), true, 'chave vista numa requisição RD habilita o warmer');

  const mock = mockFetch((url, init) => {
    if (String(init?.method || 'GET').toUpperCase() === 'DELETE') return jsonOk({}, 204);
    if (url.pathname.endsWith('/torrents/addMagnet')) return jsonOk({ id: 'T-URL' });
    if (url.pathname.includes('/torrents/info/')) return jsonOk({ status: 'downloaded', files: [], links: [] });
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    rdWarmer.enqueue([H3], 100);
    await rdWarmer.tick();
    assert.equal(rdLedger.peek(H3), 'hit', 'a sonda rodou com a credencial da requisição');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: .env do operador tem precedência sobre a credencial da URL', () => {
  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = 'chave-do-operador';
  config.debrid.allowEnvKey = true;
  rdWarmer.reset();
  rdWarmer.noteCredential('chave-da-url');
  assert.equal(rdWarmer.rdInPlay(), true);
});

test('rd-warmer: 451 deixa ledger blocked e magnetdb bad=false; segunda tentativa não re-sonda', async () => {
  config.debrid.rdLedger.enabled = true;
  let addCalls = 0;
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/rest/1.0/torrents/addMagnet' && String(init?.method || 'GET').toUpperCase() === 'POST') {
      addCalls += 1;
      // 451 / error_code 35 = recusa legal do conteúdo; a sonda vira
      // { instant:false, reason:'blocked' }.
      return {
        ok: false,
        status: 451,
        async text() { return JSON.stringify({ error_code: 35, error: 'infringing_file' }); },
        async json() { return null; },
      };
    }
    return jsonOk({}, 404);
  });
  try {
    rdWarmer.enqueue([H1], 100);
    await rdWarmer.tick();

    assert.equal(rdLedger.peek(H1), 'blocked', 'recusa legal marca o ledger');
    assert.equal(magnetdb.isBad('realdebrid', config.debrid.apiKey, H1), false, '451 não vira magnet quebrado');

    const counters = (metrics.snapshot() as any).counters;
    assert.equal(counters['debrid.rd.warm.blocked'], 1, 'métrica própria do caminho bloqueado');
    assert.equal(counters['debrid.rd.warm.miss'] == null, true, 'bloqueio não conta como miss no quente');

    // Re-enfileirar o mesmo hash não pode gerar outra sonda: o `blocked` já
    // deduplica no enqueue.
    rdWarmer.enqueue([H1], 100);
    await rdWarmer.tick();
    assert.equal(addCalls, 1, 'hash bloqueado não é re-sondado');
  } finally {
    mock.restore();
  }
});

test('rd-warmer: reparo idempotente limpa só o bad RD correlacionado com ledger blocked', () => {
  config.debrid.rdLedger.enabled = true;
  const blockedHash = 'b'.repeat(40); // dano antigo: bad + blocked
  const noVideoHash = 'c'.repeat(40); // NoVideo legítimo: bad, sem blocked
  const otherHash = 'd'.repeat(40);   // bad de outro adapter
  magnetdb.markBad('realdebrid', config.debrid.apiKey, blockedHash);
  magnetdb.markBad('realdebrid', config.debrid.apiKey, noVideoHash);
  magnetdb.markBad('torbox', 'outra-conta', otherHash);
  rdLedger.noteBlocked(blockedHash);
  const staleStreamKey = 'streams:v10:movie:ttBlockedRepair';
  cache.set(staleStreamKey, { streams: [] }, 600);
  metrics.reset();

  const cleared = rdWarmer.scanBlockedRdBads();
  assert.equal(cleared, 1, 'só o par bad+blocked é recuperado');

  const scanCounters = (metrics.snapshot() as any).counters;
  assert.equal(scanCounters['cache.hit.rdc'], undefined, 'varredura não promove nem conta hit do ledger');
  assert.equal(scanCounters['cache.miss.rdc'], undefined, 'varredura não conta miss do ledger');

  assert.equal(magnetdb.isBad('realdebrid', config.debrid.apiKey, blockedHash), false, 'bad+blocked limpo');
  assert.equal(magnetdb.isBad('realdebrid', config.debrid.apiKey, noVideoHash), true, 'NoVideo sem blocked preservado');
  assert.equal(magnetdb.isBad('torbox', 'outra-conta', otherHash), true, 'bad de outro adapter preservado');
  assert.equal(cache.peek(staleStreamKey), null, 'lista pronta antiga é invalidada para o hash voltar na próxima abertura');

  const counters = (metrics.snapshot() as any).counters;
  assert.equal(counters['magnetdb.bad.clearedBlocked'], 1, 'métrica específica do reparo');

  // Idempotente: segunda execução não acha nada a limpar.
  metrics.reset();
  assert.equal(rdWarmer.scanBlockedRdBads(), 0);
  assert.equal((metrics.snapshot() as any).counters['magnetdb.bad.clearedBlocked'] ?? 0, 0, 'nada recuperado no segundo passe');
});
