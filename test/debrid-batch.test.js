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

test('abortSafeCacheCheck:false com orçamento suficiente roda sem teto dinâmico', async () => {
  const original = debrid.BY_ID.get('premiumize');
  const calls = [];
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey, infoHashes, options) {
      calls.push({ apiKey, infoHashes, options });
      return new Set(infoHashes);
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-budget',
  };

  try {
    const result = await runtime.run(
      { opts: userOpts, encoded: '' },
      // 750ms está acima do piso: a consulta disputa a corrida em vez de adiar
      // a checagem inteira para o passe tardio.
      () => debrid.checkCached(['hash-budget'], { timeoutMs: 750 }),
    );
    assert.equal(calls.length, 1, 'orçamento suficiente executa a consulta na primeira resposta');
    assert.equal(calls[0].options, undefined, 'a consulta não recebe teto dinâmico');
    assert.equal(result.known, true);
    assert.deepEqual([...result.cached], ['hash-budget']);
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('orçamento abaixo do piso não chama rede em consulta não abortável', async () => {
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
    debridApiKey: 'chave-fake-race-floor',
  };

  try {
    const result = await runtime.run(
      { opts: userOpts, encoded: '' },
      // Abaixo do piso a consulta só atrasaria a resposta sem chance útil de
      // vencer — e, na AllDebrid, cada chamada é um upload de verdade.
      () => debrid.checkCached(['hash-floor'], { timeoutMs: 100 }),
    );
    assert.equal(result.known, false);
    assert.equal(result.cached.size, 0);
    assert.equal(calls, 0, 'abaixo do piso o upload nem começa');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('corrida perdida devolve unknown; o sem-teto junta a mesma consulta', async () => {
  const original = debrid.BY_ID.get('premiumize');
  let calls = 0;
  let openCheck;
  const gate = new Promise((resolve) => { openCheck = resolve; });
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    checkCached(apiKey, infoHashes) {
      calls += 1;
      // Não resolve até o teste liberar: a corrida da primeira resposta perde
      // de propósito, mas o trabalho continua em background.
      return gate.then(() => new Set(infoHashes));
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-lost',
  };
  const hashes = ['hash-lost-a', 'hash-lost-b'];

  // O timer da corrida é unref'd (não segura o processo vivo). Num processo de
  // teste sem servidor isso deixaria o loop esvaziar antes dos 450ms e o runner
  // cancelaria o teste como pendente; o keepAlive ref'd segura o loop até lá.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const lost = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes, { timeoutMs: 450 }),
    );
    assert.equal(lost.known, false, 'a resposta não espera a consulta');
    assert.equal(lost.cached.size, 0);
    assert.equal(calls, 1, 'a consulta continua depois de perder a corrida');

    openCheck();

    // O passe tardio (sem teto) não pode repetir o upload: junta a mesma promise.
    const joined = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(joined.known, true);
    assert.deepEqual([...joined.cached].sort(), [...hashes].sort());
    assert.equal(calls, 1, 'o sem-teto junta a mesma promise, sem segundo upload');
  } finally {
    clearInterval(keepAlive);
    debrid.BY_ID.set('premiumize', original);
  }
});

test('resultado conhecido permanece coalescido para o passe tardio', async () => {
  const original = debrid.BY_ID.get('premiumize');
  const calls = [];
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey, infoHashes) {
      calls.push(infoHashes);
      return new Set(infoHashes);
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-known',
  };
  const hashes = ['hash-known-a', 'hash-known-b'];

  try {
    const first = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(first.known, true);

    // Resposta confiável vira dedupe curto: o passe tardio de uma segunda busca
    // não pode repetir o upload enquanto a consulta ainda vale (60s).
    const second = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(second.known, true);
    assert.deepEqual([...second.cached].sort(), [...hashes].sort());
    assert.equal(calls.length, 1, 'resultado conhecido continua coalescido');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('falha da consulta não abortável não fica memorizada', async () => {
  const original = debrid.BY_ID.get('premiumize');
  let calls = 0;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey, infoHashes) {
      calls += 1;
      if (calls === 1) throw new Error('serviço fora do ar');
      return new Set(infoHashes);
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-fail',
  };
  const hashes = ['hash-fail-a'];

  try {
    const failed = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(failed.known, false, 'falha vira unknown na hora');

    // Falha não pode ficar memorizada: se a segunda chamada juntasse a promise
    // morta, o ⚡ nunca se recuperaria quando o serviço voltasse.
    const recovered = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(recovered.known, true, 'chamada sem teto reexecuta o adaptador');
    assert.deepEqual([...recovered.cached], hashes);
    assert.equal(calls, 2, 'a segunda consulta roda de novo em vez de juntar a falha');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('resposta incompleta não fica memorizada e permite recuperar known', async () => {
  const original = debrid.BY_ID.get('premiumize');
  let calls = 0;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Adaptador com efeito colateral',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    async checkCached(apiKey, infoHashes) {
      calls += 1;
      if (calls === 1) return { cached: new Set([infoHashes[0]]), complete: false };
      return { cached: new Set(infoHashes), complete: true };
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-race-incomplete',
  };
  const hashes = ['hash-inc-a', 'hash-inc-b'];

  try {
    const incomplete = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(incomplete.known, false, 'lote perdido não é "não tem"');

    const recovered = await runtime.run(
      { opts: userOpts, encoded: '' },
      () => debrid.checkCached(hashes),
    );
    assert.equal(recovered.known, true);
    assert.deepEqual([...recovered.cached].sort(), [...hashes].sort());
    assert.equal(calls, 2, 'resposta incompleta não fica memorizada');
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
