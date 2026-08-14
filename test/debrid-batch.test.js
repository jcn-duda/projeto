const { test } = require('node:test');
const assert = require('node:assert');

// O lote de checagem de cache é o ponto onde "não perguntei" virava "não tem":
// com `cachedOnly`, um lote perdido no timeout apagava 100 streams da lista,
// inclusive fontes BR que ESTAVAM em cache no serviço.
const { batched } = require('../src/debrid/common');
const debrid = require('../src/debrid');
const runtime = require('../src/runtime');
const premiumize = require('../src/debrid/premiumize');
const torbox = require('../src/debrid/torbox');

const hashes = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('todos os lotes respondem: completo, com o Set inteiro', async () => {
  const { cached, complete } = await batched(hashes(5), 2, async (batch) => batch);
  assert.equal(complete, true);
  assert.deepEqual([...cached].sort(), hashes(5).sort());
});

test('um lote que falha marca a resposta como incompleta', async () => {
  const { cached, complete } = await batched(hashes(4), 2, async (batch) => {
    if (batch.includes('h0')) throw new Error('timeout');
    return batch;
  });
  // O que respondeu continua valendo — dá pra marcar o ⚡ de quem foi confirmado.
  assert.deepEqual([...cached].sort(), ['h2', 'h3']);
  // Mas quem não foi perguntado NÃO pode ser tratado como fora do cache.
  assert.equal(complete, false);
});

test('todos os lotes falhando sobe erro em vez de dizer "nada em cache"', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new Error('token inválido'); }),
    /nenhum lote/,
  );
});

test('lista vazia não vira falha', async () => {
  const { cached, complete } = await batched([], 100, async (batch) => batch);
  assert.equal(cached.size, 0);
  assert.equal(complete, true);
});

test('os lotes vão em paralelo, não em série', async () => {
  // Em série, dois lotes somavam dois timeouts inteiros (6s + 6s) contra um
  // REPLY_DEADLINE de 8,5s e a busca voltava vazia mesmo com tudo coletado.
  let running = 0;
  let peak = 0;
  await batched(hashes(6), 2, async (batch) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return batch;
  });
  assert.equal(peak, 3);
});

test('batched repassa o mesmo teto dinâmico para todos os lotes', async () => {
  const seen = [];
  await batched(hashes(5), 2, async (batch, options) => {
    seen.push({ batch, options });
    return batch;
  }, { timeoutMs: 1234 });

  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((entry) => entry.options), [
    { timeoutMs: 1234 },
    { timeoutMs: 1234 },
    { timeoutMs: 1234 },
  ]);
});

test('batched sem teto preserva o timeout próprio do adaptador', async () => {
  const seen = [];
  await batched(hashes(2), 1, async (batch, options) => {
    seen.push(options);
    return batch;
  });
  assert.deepEqual(seen, [{ timeoutMs: undefined }, { timeoutMs: undefined }]);
});

test('checkCached degrada sem rede quando o prazo acabou e propaga teto positivo', async () => {
  const original = debrid.BY_ID.get('premiumize');
  const calls = [];
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Premiumize fake',
    cacheCheck: true,
    async checkCached(apiKey, infoHashes, options) {
      calls.push({ apiKey, infoHashes, options });
      return { cached: new Set(infoHashes), complete: true };
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
  };

  try {
    const expired = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['hash-a'], { timeoutMs: 0 }),
    );
    assert.equal(expired.known, false);
    assert.equal(expired.cached.size, 0);
    assert.equal(calls.length, 0, 'prazo esgotado não pode chamar o serviço');

    const bounded = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['hash-b'], { timeoutMs: 750 }),
    );
    assert.equal(bounded.known, true);
    assert.deepEqual([...bounded.cached], ['hash-b']);
    assert.deepEqual(calls[0], {
      apiKey: 'chave-fake',
      infoHashes: ['hash-b'],
      options: { timeoutMs: 750 },
    });
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('checkCached limitado não aborta adaptador cuja consulta cria transferência', async () => {
  const original = debrid.BY_ID.get('premiumize');
  let calls = 0;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached() {
      calls += 1;
      return new Set();
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
  };

  try {
    const result = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(['hash-a'], { timeoutMs: 750 }),
    );
    assert.equal(result.known, false);
    assert.equal(calls, 0, 'consulta limitada não pode deixar transferência sem limpeza');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('Premiumize e TorBox aplicam o teto recebido na requisição real do adaptador', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  };
  globalThis.fetch = async (url) => {
    const premiumizeRequest = String(url).includes('premiumize.me');
    return {
      ok: true,
      json: async () => premiumizeRequest
        ? { status: 'success', response: [true] }
        : { data: [{ hash: 'hash-torbox' }] },
    };
  };

  try {
    const pm = await premiumize.checkCached('chave-fake', ['hash-premiumize'], { timeoutMs: 321 });
    const tb = await torbox.checkCached('chave-fake', ['hash-torbox'], { timeoutMs: 654 });
    assert.deepEqual([...pm.cached], ['hash-premiumize']);
    assert.deepEqual([...tb.cached], ['hash-torbox']);
    assert.deepEqual(timeouts, [321, 654]);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
