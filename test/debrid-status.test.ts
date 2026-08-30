// Rodada 2: checagem ligada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { resetAccountStatusMemo } from '../src/debrid/account-status.js';
import { createApp } from '../src/app.js';
import config from '../src/config.js';

/**
 * O verificador da conta do debrid.
 *
 * Ele existe por causa de um caso que custou caro: a conta AllDebrid encheu
 * (1000 magnets), a checagem de cache — que é um /magnet/upload — passou a
 * falhar inteira, e o ⚡ sumiu de TODOS os streams. Até estourar não havia
 * sinal nenhum, e o sintoma na tela não aponta para a causa. Aqui dá para ver
 * a ocupação antes de quebrar.
 */
// Em ESM os `import` são içados: mexer em process.env AQUI acontece depois de
// `src/config.ts` já ter lido a variável. Quem vale é o config carregado — sem
// isso a rota devolve 503 (token não configurado) e o teste do 401 quebra em
// qualquer máquina sem JACKETT_TEST_TOKEN no .env, como o CI.
config.jackett.testToken = config.jackett.testToken || 'token-de-teste';
// Mesma razão: sem serviço/chave o accountStatus responde "não suportado" e
// nem chega ao adaptador dublado. O mockAccount intercepta o fetch, então a
// chave só precisa existir.
config.debrid.service = 'alldebrid';
config.debrid.apiKey = 'chave-de-teste';

const TOKEN = config.jackett.testToken;

/**
 * Dublê do /magnet/status: N magnets, dos quais `ready` prontos.
 *
 * Deixa passar o que for para 127.0.0.1: os testes da rota conversam com o
 * próprio app por HTTP, e interceptar essa chamada faria o servidor responder
 * o dublê da AllDebrid em vez do JSON do endpoint.
 */
function mockAccount(total: any, ready = 0) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    return {
    ok: true,
    status: 200,
    json: async () => ({
      status: 'success',
      data: {
        magnets: Array.from({ length: total }, (_, i) => ({
          id: i,
          ready: i < ready,
          size: 1024,
          uploadDate: 1_700_000_000 + i,
        })),
      },
    }),
    };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

/** Retorno do /debrid-status: cada campo é opcional porque cada serviço mede o
 * que consegue (AllDebrid conta magnets, Premiumize publica fair-use, TorBox
 * conta o mylist). */
interface AccountStatusResult {
  ok: boolean;
  service: string | null;
  label?: string;
  supported?: boolean;
  reason?: string;
  error?: string;
  warn?: boolean;
  warnAt?: number;
  warnAtUnit?: string;
  magnets?: number;
  ready?: number;
  active?: number;
  limitUsed?: number | null;
  premiumUntil?: number | null;
  oldestAt?: number | string | null;
  usedPct?: number;
  cached?: boolean;
  fetchedAt?: number;
  fix?: string | null;
}

const withKey = (fn: () => unknown) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'chave-de-teste' },
      encoded: 'cfg',
    },
    fn,
  ) as Promise<AccountStatusResult>;

test('conta folgada: ok, sem aviso, com a ocupação medida', async () => {
  const restore = mockAccount(120, 30);
  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.ok, true);
    assert.equal(status.service, 'alldebrid');
    assert.deepEqual(
      { magnets: status.magnets, ready: status.ready },
      { magnets: 120, ready: 30 },
    );
    assert.equal(status.warn, false, '120 magnets não é motivo de alarme');
    assert.equal(status.usedPct, undefined, 'sem percentual sobre um teto que não conhecemos');
  } finally {
    restore();
  }
});

test('conta cheia avisa ANTES de a checagem quebrar', async () => {
  // O limiar é nosso, não do serviço: a AllDebrid tem dois tetos que não batem
  // (30 ativos na doc, 1000 na mensagem real) e nenhum é consultável. O que
  // importa é existir aviso — sem ele, o primeiro sinal é o ⚡ sumindo de tudo.
  resetAccountStatusMemo();
  const restore = mockAccount(800);
  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.magnets, 800);
    assert.equal(status.warn, true);
    assert.equal(status.warnAt, 800, 'o limiar viaja na resposta, para não virar número mágico');
  } finally {
    restore();
  }
});

test('conta estourada é reportada como quota, não como falha genérica', async () => {
  resetAccountStatusMemo();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      error: { code: 'MAGNET_TOO_MANY_ACTIVE', message: 'Magnets limit reached (1000 accross all tabs)' },
    }),
  })) as unknown as typeof globalThis.fetch;

  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'quota', 'a mesma linguagem da busca serve ao diagnóstico');
    assert.match(status.error as string, /limit reached/i);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('chave recusada é reportada como auth, e o verificador não explode', async () => {
  // O verificador precisa responder JUSTAMENTE quando o serviço está ruim.
  resetAccountStatusMemo();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' },
    }),
  })) as unknown as typeof globalThis.fetch;

  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'auth');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

const withPremiumize = (fn: () => unknown) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-pm' },
      encoded: 'cfg',
    },
    fn,
  ) as Promise<AccountStatusResult>;

test('premiumize folgado: ok, sem aviso, com o fair-use medido', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', limit_used: 0.42, premium_until: 1799999999 }),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    const status = await withPremiumize(() => debrid.accountStatus());
    assert.equal(status.ok, true);
    assert.equal(status.service, 'premiumize');
    assert.equal(status.supported, true);
    assert.equal(status.limitUsed, 0.42);
    assert.equal(status.warn, false);
    assert.equal(status.warnAt, 0.8);
    assert.equal(status.magnets, undefined, 'fair-use não se disfarça de magnets AllDebrid');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('premiumize perto do teto de fair-use avisa ANTES de account_limit_reached', async () => {
  resetAccountStatusMemo();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', limit_used: 0.81 }),
  })) as unknown as typeof globalThis.fetch;
  try {
    const status = await withPremiumize(() => debrid.accountStatus());
    assert.equal(status.limitUsed, 0.81);
    assert.equal(status.warn, true);
    assert.equal(status.warnAt, 0.8);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('premiumize em rate limit no verificador é reason=rate, não falha genérica', async () => {
  resetAccountStatusMemo();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'slow down',
      code: 'rate_limit_reached',
    }),
  })) as unknown as typeof globalThis.fetch;
  try {
    const status = await withPremiumize(() => debrid.accountStatus());
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'rate');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

const withTorbox = (fn: () => unknown) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'torbox', debridApiKey: 'chave-tb' },
      encoded: 'cfg',
    },
    fn,
  ) as Promise<AccountStatusResult>;

const withRealDebrid = (fn: () => unknown) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'realdebrid', debridApiKey: 'chave-rd' },
      encoded: 'cfg',
    },
    fn,
  ) as Promise<AccountStatusResult & { rd?: any }>;

function mockRealDebridAccount(torrents = [{ id: '1', status: 'downloaded' }, { id: '2', status: 'downloading' }]) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    const strUrl = String(url);
    if (strUrl.includes('127.0.0.1')) return realFetch(url, init);
    if (strUrl.includes('/user')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 12345, username: 'testuser', expiration: '2028-01-01T00:00:00.000Z' }),
      };
    }
    if (strUrl.includes('/torrents')) {
      return {
        ok: true,
        status: 200,
        json: async () => torrents,
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

test('realdebrid: o verificador mede magnets, ready, active e premiumUntil', async () => {
  const restore = mockRealDebridAccount();
  try {
    const status = await withRealDebrid(() => debrid.accountStatus());
    assert.equal(status.ok, true);
    assert.equal(status.service, 'realdebrid');
    assert.equal(status.supported, true);
    assert.equal(status.magnets, 2);
    assert.equal(status.ready, 1);
    assert.equal(status.active, 1);
    assert.equal(typeof status.premiumUntil, 'number');
  } finally {
    restore();
  }
});

test('torbox: o verificador conta o mylist, não devolve supported:false', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: [
          { hash: 'aa', name: 'pronto', download_finished: true, download_present: true },
          { hash: 'bb', name: 'baixando', download_finished: false, download_present: false },
        ],
      }),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    const status = await withTorbox(() => debrid.accountStatus());
    assert.equal(status.ok, true);
    assert.equal(status.service, 'torbox');
    assert.equal(status.supported, true);
    assert.equal(status.magnets, 2);
    assert.equal(status.ready, 1);
    assert.equal(status.active, 1);
    assert.equal(status.warn, false, '2 torrents não dispara o limiar de 800 magnets');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('sem debrid configurado o verificador diz isso, sem tocar a rede', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('não deveria haver chamada'); };
  try {
    const status = await runtime.run(
      { opts: { ...runtime.defaults(), debridService: '', debridApiKey: '' }, encoded: 'cfg' },
      () => debrid.accountStatus(),
    );
    assert.deepEqual(status, { ok: false, reason: 'sem-debrid', service: null });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- A rota ---------------------------------------------------------------

async function request(app: any, path: any, headers = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('a rota exige o token de diagnóstico', async () => {
  const { app } = createApp();
  const semToken = await request(app, '/debrid-status.json');
  assert.equal(semToken.status, 401);

  const tokenErrado = await request(app, '/debrid-status.json', { 'X-Indexer-Test-Token': 'outro' });
  assert.equal(tokenErrado.status, 401);
});

test('a rota responde 200 com o diagnóstico mesmo com a conta ruim', async () => {
  // Conta estourada não é erro de request: o corpo É a resposta útil.
  resetAccountStatusMemo();
  const restore = mockAccount(1000);
  const { app } = createApp();
  try {
    const { status, body } = await request(app, '/debrid-status.json', {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.magnets, 1000);
    assert.equal(body.warn, true);
  } finally {
    restore();
  }
});

test('com config na URL o verificador olha a chave DAQUELA instalação', async () => {
  // É a diferença que importa na prática: a chave do .env pode estar quebrada
  // enquanto a do app está boa (foi exatamente o caso real).
  //
  // O segmento precisa ser codificado com as CHAVES CURTAS do SCHEMA (`ds`,
  // `dk`) — é o que o /configure real produz. `normalize()` ignora chave
  // desconhecida, então um segmento com nomes completos (`debridApiKey`) era
  // silenciosamente descartado e este teste validava nada: o mock devolvia o
  // mesmo valor para qualquer chave. O memo da conta expôs o teste vazio —
  // a rota lia os defaults, batia no memo da entrada anterior e devolvia o
  // magnets de OUTRA conta.
  resetAccountStatusMemo();
  const segment = runtime.encode({
    [runtime.SCHEMA.debridService.key]: 'alldebrid',
    [runtime.SCHEMA.debridApiKey.key]: 'chave-da-instalacao',
  });
  // O dublê DISCRIMINA por chave (a AllDebrid leva a apikey no header
  // Authorization): 500 para a da instalação, 999 para qualquer outra. Asserir
  // 500 só prova a chave certa se OUTRA chave devolver outro número — era aqui
  // que este teste validava nada antes do memo (o mock antigo devolvia o mesmo
  // corpo para qualquer chave).
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    const auth = String((init && init.headers && (init.headers.Authorization || init.headers.authorization)) || '');
    const total = auth.includes('chave-da-instalacao') ? 500 : 999;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          magnets: Array.from({ length: total }, (_, i) => ({
            id: i,
            ready: true,
            size: 1024,
            uploadDate: 1_700_000_000 + i,
          })),
        },
      }),
    };
  }) as unknown as typeof globalThis.fetch;
  const restore = () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
  const { app } = createApp();
  try {
    const { status, body } = await request(app, `/${segment}/debrid-status.json`, {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.service, 'alldebrid');
    assert.equal(body.magnets, 500);
  } finally {
    restore();
  }
});

// --- A unidade do warnAt: número sem unidade é número mágico ---------------

test('a rota expõe a unidade dos magnets no warnAt', async () => {
  // O limiar viaja na resposta justamente para não virar número mágico no
  // cliente; sem a unidade, 800 não diz de quê. O contrato é o corpo do
  // /debrid-status carregar warnAtUnit junto. O memo reinicia: a leitura
  // anterior desta mesma chave (1000 magnets) não pode vazar para cá.
  resetAccountStatusMemo();
  const restore = mockAccount(500);
  const { app } = createApp();
  try {
    const { status, body } = await request(app, '/debrid-status.json', {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.warnAt, 800);
    assert.equal(body.warnAtUnit, 'magnets');
  } finally {
    restore();
  }
});

test('warnAt do fair-use carrega a unidade explícita no corpo', async () => {
  resetAccountStatusMemo();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', limit_used: 0.42, premium_until: 1799999999 }),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    const status = await withPremiumize(() => debrid.accountStatus());
    assert.equal(status.warnAt, 0.8);
    assert.equal(status.warnAtUnit, 'fair-use');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- Bloco RD no /debrid-status.json ----------------------------------------

test('a rota /debrid-status.json inclui bloco rd quando o serviço é realdebrid', async () => {
  const oldService = config.debrid.service;
  const oldApiKey = config.debrid.apiKey;
  config.debrid.service = 'realdebrid';
  config.debrid.apiKey = 'chave-rd-teste';
  const restore = mockRealDebridAccount();
  const { app } = createApp();
  try {
    const { status, body } = await request(app, '/debrid-status.json', {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.service, 'realdebrid');
    assert.ok(body.rd, 'bloco rd deve estar presente');
    assert.equal(typeof body.rd.ledger, 'object');
    assert.equal(typeof body.rd.ledger.tracked, 'number');
    assert.equal(typeof body.rd.ledger.hits, 'number');
    assert.equal(typeof body.rd.ledger.misses, 'number');
    assert.equal(typeof body.rd.ledger.blocked, 'number');
    assert.equal(typeof body.rd.oracle, 'object');
    assert.equal(typeof body.rd.oracle.enabled, 'boolean');
    assert.equal(typeof body.rd.oracle.stremthru, 'boolean');
    assert.equal(typeof body.rd.oracle.torrentio, 'boolean');
    assert.equal(typeof body.rd.gate, 'object');
    assert.equal(typeof body.rd.gate.enabled, 'boolean');
    assert.ok(Array.isArray(body.rd.gate.accounts));
    assert.equal(typeof body.rd.warm, 'object');
    assert.equal(typeof body.rd.warm.enabled, 'boolean');
    assert.equal(typeof body.rd.warm.queueDepth, 'number');
    assert.equal(typeof body.rd.warm.paused, 'boolean');
    assert.equal(typeof body.rd.warm.processedLastHour, 'number');
  } finally {
    restore();
    config.debrid.service = oldService;
    config.debrid.apiKey = oldApiKey;
  }
});

test('com config na URL apontando para realdebrid, /debrid-status.json inclui o bloco rd', async () => {
  const segment = runtime.encode({
    ds: 'realdebrid',
    dk: 'chave-rd-instalacao',
  });
  const restore = mockRealDebridAccount();
  const { app } = createApp();
  try {
    const { status, body } = await request(app, `/${segment}/debrid-status.json`, {
      'X-Indexer-Test-Token': TOKEN,
    });
    assert.equal(status, 200);
    assert.equal(body.service, 'realdebrid');
    assert.ok(body.rd, 'bloco rd deve estar presente');
    assert.equal(typeof body.rd.ledger.tracked, 'number');
    assert.equal(typeof body.rd.oracle.enabled, 'boolean');
    assert.equal(typeof body.rd.gate.enabled, 'boolean');
    assert.equal(typeof body.rd.warm.queueDepth, 'number');
  } finally {
    restore();
  }
});

// --- Memo curto da conta no dashboard ---------------------------------------
//
// Consultar saúde na AllDebrid É um upload: N abas do painel abertas em
// rajada não podem virar N uploads na conta. O memo é curto de propósito —
// falha transiente congela no máximo até o TTL (default 60s), e 0 desliga.

/** Dublê que CONTA chamadas: o assert é no delta, não no total absoluto,
 * porque cada adaptador pode fazer mais de um fetch por consulta. */
function mockAccountCounting(payload: () => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('127.0.0.1')) return realFetch(url, init);
    calls += 1;
    return { ok: true, status: 200, json: async () => payload() };
  }) as unknown as typeof globalThis.fetch;
  return {
    count: () => calls,
    restore: () => {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

const okPayload = () => ({
  status: 'success',
  data: {
    magnets: Array.from({ length: 5 }, (_, i) => ({
      id: i,
      ready: true,
      size: 1024,
      uploadDate: 1_700_000_000 + i,
    })),
  },
});

const authPayload = () => ({
  status: 'error',
  error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' },
});

test('memo: duas leituras dentro do TTL = 1 consulta; corpo traz fetchedAt e cached', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    const first = await withKey(() => debrid.accountStatus());
    const oneFlight = mock.count();
    assert.ok(oneFlight > 0, 'a primeira leitura foi à rede');
    assert.equal(first.cached, false);
    assert.equal(typeof first.fetchedAt, 'number');
    const second = await withKey(() => debrid.accountStatus());
    assert.equal(mock.count(), oneFlight, 'segunda leitura veio do memo');
    assert.equal(second.cached, true);
    assert.equal(second.fetchedAt, first.fetchedAt, 'fetchedAt marca a consulta, não a leitura');
    assert.equal(second.magnets, first.magnets);
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: TTL expirado reconsulta, e TTL=0 desliga o memo', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    config.debrid.dashboardAccountTtlMs = 25;
    await withKey(() => debrid.accountStatus());
    const oneFlight = mock.count();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const depois = await withKey(() => debrid.accountStatus());
    assert.equal(mock.count(), oneFlight * 2, 'TTL vencido foi à rede de novo');
    assert.equal(depois.cached, false);

    config.debrid.dashboardAccountTtlMs = 0;
    resetAccountStatusMemo();
    await withKey(() => debrid.accountStatus());
    const base = mock.count();
    await withKey(() => debrid.accountStatus());
    assert.equal(mock.count(), base + oneFlight, 'com 0 cada leitura consulta');
    const direto = await withKey(() => debrid.accountStatus());
    assert.equal(direto.cached, false, 'memo desligado nunca diz cached');
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: chaves distintas nunca dividem entrada', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    const primeira = await withKey(() => debrid.accountStatus());
    const umaChave = mock.count();
    const outra = await runtime.run(
      { opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'outra-chave' }, encoded: 'cfg' },
      () => debrid.accountStatus(),
    ) as AccountStatusResult;
    assert.equal(outra.cached, false, 'chave nova não herda memo da anterior');
    assert.equal(mock.count(), umaChave * 2, 'cada conta pagou a própria consulta');
    const repetida = await withKey(() => debrid.accountStatus());
    assert.equal(repetida.cached, true);
    assert.equal(repetida.fetchedAt, primeira.fetchedAt);
    assert.equal(mock.count(), umaChave * 2, 'memo da primeira chave continua valendo');
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: chamada concorrente é coalescida em uma consulta só', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(okPayload);
  try {
    await withKey(() => debrid.accountStatus());
    const umVoo = mock.count();
    resetAccountStatusMemo();
    const antes = mock.count();
    const [a, b] = await Promise.all([
      withKey(() => debrid.accountStatus()),
      withKey(() => debrid.accountStatus()),
    ]);
    assert.equal(mock.count() - antes, umVoo, 'duas leituras concorrentes = 1 consulta');
    assert.equal(a.cached, false);
    assert.equal(b.cached, false, 'quem participou da consulta em voo viu dado novo');
    assert.equal(a.fetchedAt, b.fetchedAt);
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('memo: falha auth preserva reason/fix e não congela além do TTL', async () => {
  const savedTtl = config.debrid.dashboardAccountTtlMs;
  config.debrid.dashboardAccountTtlMs = 60_000;
  resetAccountStatusMemo();
  const mock = mockAccountCounting(authPayload);
  try {
    const primeira = await withKey(() => debrid.accountStatus());
    assert.equal(primeira.ok, false);
    assert.equal(primeira.reason, 'auth');
    assert.ok(primeira.fix, 'o conserto viaja no corpo da falha');
    const memoizada = await withKey(() => debrid.accountStatus());
    assert.equal(memoizada.cached, true);
    assert.equal(memoizada.reason, primeira.reason);
    assert.equal(memoizada.fix, primeira.fix, 'reason/fix sobrevivem ao memo');
    config.debrid.dashboardAccountTtlMs = 25;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const renovada = await withKey(() => debrid.accountStatus());
    assert.equal(renovada.cached, false, 'TTL curto é o teto do congelamento da falha');
    assert.equal(renovada.reason, 'auth');
  } finally {
    config.debrid.dashboardAccountTtlMs = savedTtl;
    mock.restore();
  }
});

test('dashboardAccounts reutiliza o memo para a conta do operador', async () => {
  resetAccountStatusMemo();
  const saved = {
    service: config.debrid.service,
    apiKey: config.debrid.apiKey,
    allowEnvKey: config.debrid.allowEnvKey,
    ttl: config.debrid.dashboardAccountTtlMs,
  };
  const mock = mockAccountCounting(okPayload);
  config.debrid.service = 'alldebrid';
  config.debrid.apiKey = 'chave-do-operador';
  config.debrid.allowEnvKey = true;
  config.debrid.dashboardAccountTtlMs = 60_000;
  try {
    // Ativo ≠ operador (premiumize na requisição): é o caso em que o painel
    // consulta a conta do .env por fora, e é ela que precisa do memo.
    const ler = () =>
      runtime.run(
        { opts: { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-pm' }, encoded: 'cfg' },
        () => debrid.dashboardAccounts({ ok: true, service: 'premiumize' }),
      ) as Promise<Record<string, any>>;
    const first = await ler();
    const umVoo = mock.count();
    assert.ok(first.alldebrid, 'conta do operador entra no mapa');
    assert.equal(first.alldebrid.cached, false);
    const second = await ler();
    assert.equal(mock.count(), umVoo, 'segunda leitura do operador veio do memo');
    assert.equal(second.alldebrid.cached, true);
    assert.equal(second.alldebrid.fetchedAt, first.alldebrid.fetchedAt);
  } finally {
    mock.restore();
    config.debrid.service = saved.service;
    config.debrid.apiKey = saved.apiKey;
    config.debrid.allowEnvKey = saved.allowEnvKey;
    config.debrid.dashboardAccountTtlMs = saved.ttl;
  }
});
