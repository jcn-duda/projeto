// Rodada 2: checagem ligada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
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
config.debrid.service = config.debrid.service || 'alldebrid';
config.debrid.apiKey = config.debrid.apiKey || 'chave-de-teste';

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
  const segment = runtime.encode({
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-da-instalacao',
  });
  const restore = mockAccount(500);
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
  // /debrid-status carregar warnAtUnit junto.
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
