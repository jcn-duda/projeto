const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * O verificador da conta do debrid.
 *
 * Ele existe por causa de um caso que custou caro: a conta AllDebrid encheu
 * (1000 magnets), a checagem de cache — que é um /magnet/upload — passou a
 * falhar inteira, e o ⚡ sumiu de TODOS os streams. Até estourar não havia
 * sinal nenhum, e o sintoma na tela não aponta para a causa. Aqui dá para ver
 * a ocupação antes de quebrar.
 */
process.env.JACKETT_TEST_TOKEN = process.env.JACKETT_TEST_TOKEN || 'token-de-teste';

const runtime = require('../src/runtime');
const debrid = require('../src/debrid');
const { createApp } = require('../src/app');

const TOKEN = process.env.JACKETT_TEST_TOKEN;

/**
 * Dublê do /magnet/status: N magnets, dos quais `ready` prontos.
 *
 * Deixa passar o que for para 127.0.0.1: os testes da rota conversam com o
 * próprio app por HTTP, e interceptar essa chamada faria o servidor responder
 * o dublê da AllDebrid em vez do JSON do endpoint.
 */
function mockAccount(total, ready = 0) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = async (url, init) => {
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
  };
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

const withKey = (fn) =>
  runtime.run(
    {
      opts: { ...runtime.defaults(), debridService: 'alldebrid', debridApiKey: 'chave-de-teste' },
      encoded: 'cfg',
    },
    fn,
  );

test('conta folgada: ok, sem aviso, com a ocupação medida', async () => {
  const restore = mockAccount(120, 30);
  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.ok, true);
    assert.equal(status.service, 'alldebrid');
    assert.deepEqual(
      { magnets: status.magnets, ready: status.ready, limit: status.limit, usedPct: status.usedPct },
      { magnets: 120, ready: 30, limit: 1000, usedPct: 12 },
    );
    assert.equal(status.warn, false, '12% não é motivo de alarme');
  } finally {
    restore();
  }
});

test('conta perto do teto avisa ANTES de a checagem quebrar', async () => {
  // 80% é o ponto em que ainda dá tempo de limpar. O valor exato importa menos
  // que existir um aviso: sem ele, o primeiro sinal é o ⚡ sumindo de tudo.
  const restore = mockAccount(800);
  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.usedPct, 80);
    assert.equal(status.warn, true);
  } finally {
    restore();
  }
});

test('conta estourada é reportada como quota, não como falha genérica', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      error: { code: 'MAGNET_TOO_MANY_ACTIVE', message: 'Magnets limit reached (1000 accross all tabs)' },
    }),
  });

  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'quota', 'a mesma linguagem da busca serve ao diagnóstico');
    assert.match(status.error, /limit reached/i);
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
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' },
    }),
  });

  try {
    const status = await withKey(() => debrid.accountStatus());
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'auth');
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

async function request(app, path, headers = {}) {
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
    assert.equal(body.usedPct, 100);
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
    assert.equal(body.usedPct, 50);
  } finally {
    restore();
  }
});
