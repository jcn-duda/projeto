const { test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Credencial recusada vs. serviço instável — a distinção que faltava.
 *
 * Os dois casos tinham o MESMO efeito na tela: o ⚡ sumia de todos os streams e
 * a lista saía inteira como "[AD download]". A diferença é que o serviço fora
 * do ar volta sozinho (e o play até funciona), enquanto a chave recusada nunca
 * volta: todo play morre no /resolve e o usuário fica com uma lista que não
 * toca nada, sem nenhuma pista do motivo.
 *
 * Caso real que motivou isto: a AllDebrid respondendo AUTH_BAD_APIKEY com HTTP
 * 200 — o addon lia como "não sei o que está em cache" e seguia prometendo
 * debrid para 52 streams.
 */
const {
  batched, isAuthError, AuthError, isQuotaError, QuotaError,
  isRateLimitError, RateLimitError, json,
} = require('../src/debrid/common');
const alldebrid = require('../src/debrid/alldebrid');
const premiumize = require('../src/debrid/premiumize');
const torbox = require('../src/debrid/torbox');

const hashes = (n) => Array.from({ length: n }, (_, i) => `h${i}`);

test('isAuthError reconhece os códigos de credencial dos serviços', () => {
  // AllDebrid manda AUTH_* no corpo; os outros respondem 401/403.
  assert.equal(isAuthError(new Error('The auth apikey is invalid (AUTH_BAD_APIKEY)')), true);
  assert.equal(isAuthError(new Error('AUTH_MISSING_APIKEY')), true);
  assert.equal(isAuthError(new Error('AUTH_USER_BANNED')), true);
  assert.equal(isAuthError(new Error('HTTP 401 — unauthorized')), true);
  assert.equal(isAuthError(new Error('HTTP 403 — Forbidden')), true);
  assert.equal(isAuthError(new Error('invalid api key')), true);
  assert.equal(isAuthError(new AuthError('qualquer coisa')), true, 'a marca vale sozinha');

  // Falha transitória continua sendo transitória: tratar como credencial
  // esconderia a lista de quem só tomou um timeout.
  assert.equal(isAuthError(new Error('authentication_failed')), true, 'Premiumize HTTP 200');
  assert.equal(isAuthError(new Error('timeout')), false);
  assert.equal(isAuthError(new Error('HTTP 502 — bad gateway')), false);
  assert.equal(isAuthError(new Error('ECONNRESET')), false);
  assert.equal(isAuthError(null), false);
});

test('batched: todos os lotes recusados por credencial sobem AuthError', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new AuthError('AUTH_BAD_APIKEY'); }),
    (err) => {
      assert.equal(err.isAuthError, true);
      assert.match(err.message, /AUTH_BAD_APIKEY/);
      return true;
    },
  );
});

test('batched: falha comum continua sendo "nenhum lote respondeu", sem marca de auth', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new Error('timeout'); }),
    (err) => {
      assert.equal(err.isAuthError, undefined);
      assert.match(err.message, /nenhum lote/);
      return true;
    },
  );
});

test('batched: auth em UM lote e sucesso no outro não vira erro de credencial', async () => {
  // Resposta parcial ainda serve: o que respondeu vale, e a lista continua.
  const { cached, complete } = await batched(hashes(4), 2, async (batch) => {
    if (batch.includes('h0')) throw new AuthError('AUTH_BAD_APIKEY');
    return batch;
  });
  assert.deepEqual([...cached].sort(), ['h2', 'h3']);
  assert.equal(complete, false);
});

test('json: 401 e 403 viram AuthError; 500 continua erro comum', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const reply = (status) => async () => ({
    ok: false,
    status,
    text: async () => 'motivo no corpo',
    json: async () => ({}),
  });

  try {
    globalThis.fetch = reply(401);
    await assert.rejects(() => json('https://x.test/a'), (err) => err.isAuthError === true);

    globalThis.fetch = reply(403);
    await assert.rejects(() => json('https://x.test/a'), (err) => err.isAuthError === true);

    globalThis.fetch = reply(500);
    await assert.rejects(() => json('https://x.test/a'), (err) => err.isAuthError === undefined);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('alldebrid: AUTH_BAD_APIKEY com HTTP 200 vira AuthError na checagem de cache', async () => {
  // O corpo é o que denuncia: o HTTP é 200 e o `ok` do fetch não ajuda.
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
    await assert.rejects(
      () => alldebrid.checkCached('chave-invalida', ['a'.repeat(40)]),
      (err) => {
        assert.equal(err.isAuthError, true, 'a marca precisa sobreviver ao batched');
        assert.match(err.message, /apikey is invalid/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('alldebrid: conta no limite de magnets vira QuotaError, não credencial', async () => {
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
    await assert.rejects(
      () => alldebrid.checkCached('chave-ok', ['a'.repeat(40)]),
      (err) => {
        assert.equal(err.isAuthError, undefined, 'limite de magnets não é credencial recusada');
        assert.equal(err.isQuotaError, true, 'mas é uma causa estrutural própria');
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- O efeito na lista: quem consome o authFailed -------------------------

const runtime = require('../src/runtime');
const { applyDebrid } = require('../src/providers');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const stream = (infoHash) => ({ infoHash, name: 'Release 1080p', title: 'Release 1080p' });

test('credencial recusada devolve a lista como P2P, sem prometer debrid', async () => {
  // Era aqui que o usuário se perdia: 52 streams saíam "[AD download]" com URL
  // do /resolve, e cada play morria lá porque a chave não autentica. Como
  // torrent puro a lista ao menos toca.
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-revogada',
  };

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
    const result = await runtime.run({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], { deadlineAt: Date.now() + 5000 }),
    );

    assert.equal(result.length, 2, 'nenhum stream some da lista');
    for (const s of result) {
      assert.ok(s.infoHash, 'sem infoHash o cliente não teria como tocar em P2P');
      assert.equal(s.url, undefined, 'nada aponta para o /resolve de uma conta que não autentica');
      assert.doesNotMatch(s.name, /\[AD/, 'nem ⚡ nem "download": o debrid não está no jogo');
    }
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('falha transitória continua mandando pelo debrid, como antes', async () => {
  // A distinção precisa valer nos dois sentidos: serviço fora do ar volta
  // sozinho e o play pelo debrid ainda pode funcionar — essa lista NÃO vira P2P.
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-boa-servico-instavel',
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('simula serviço fora do ar');
  };

  try {
    const result = await runtime.run({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], { deadlineAt: Date.now() + 5000 }),
    );
    for (const s of result) assert.match(s.name, /\[AD download\]/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('credencial recusada não pede revalidação eterna', async () => {
  // `needsFullRefresh` sob credencial recusada fazia TODA busca refazer Jackett
  // e os resolvers BR (7s por request, cache nunca assentando) para chegar
  // exatamente na mesma lista. Trocar a chave já invalida a entrada sozinha: a
  // chave de cache carrega o accountScope.
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-revogada',
  };

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

  let refresh = null;
  try {
    await runtime.run({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A)], {
        deadlineAt: Date.now() + 5000,
        onCacheResult: (res) => { refresh = res.needsFullRefresh; },
      }),
    );
    assert.equal(refresh, false, 'a lista P2P é definitiva enquanto a chave não mudar');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- Conta no teto: mesma consequência, conserto diferente ------------------

test('isQuotaError separa conta cheia de falha transitória', () => {
  // O typo "accross" é da própria API da AllDebrid.
  assert.equal(isQuotaError(new Error('Magnets limit reached (1000 accross all tabs)')), true);
  assert.equal(isQuotaError(new Error('MAGNET_TOO_MANY_ACTIVE')), true);
  assert.equal(isQuotaError(new QuotaError('x')), true);
  assert.equal(isQuotaError(new Error('timeout')), false);
  assert.equal(isQuotaError(new Error('AUTH_BAD_APIKEY')), false, 'chave inválida tem conserto próprio');
});

test('batched: todos os lotes barrados por cota sobem QuotaError', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new QuotaError('Magnets limit reached'); }),
    (err) => err.isQuotaError === true && err.isAuthError === undefined,
  );
});

test('batched: causas MISTURADAS não afirmam nada — erro genérico', async () => {
  // Um lote com chave recusada e outro com timeout não provam a mesma coisa;
  // classificar pela primeira causa faria a lista virar P2P por engano.
  await assert.rejects(
    () => batched(hashes(4), 2, async (batch) => {
      if (batch.includes('h0')) throw new AuthError('AUTH_BAD_APIKEY');
      throw new Error('timeout');
    }),
    (err) => {
      assert.equal(err.isAuthError, undefined);
      assert.equal(err.isQuotaError, undefined);
      assert.match(err.message, /nenhum lote/);
      return true;
    },
  );
});

test('conta no limite devolve a lista como P2P, igual à credencial recusada', async () => {
  // Foi o caso real: a checagem de cache da AllDebrid é um /magnet/upload, e com
  // 1000 magnets na conta o upload é recusado. O play também é upload, então
  // prometer debrid aqui entrega uma lista inteira que não resolve.
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-boa-conta-cheia',
  };

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

  let refresh = null;
  try {
    const result = await runtime.run({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        deadlineAt: Date.now() + 5000,
        onCacheResult: (res) => { refresh = res.needsFullRefresh; },
      }),
    );
    for (const s of result) {
      assert.ok(s.infoHash, 'o hash sustenta o play P2P');
      assert.doesNotMatch(s.name, /\[AD/);
    }
    assert.equal(refresh, false, 'esvaziar a conta é manual; revalidar a cada busca é desperdício');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- Cooldown: o único estado estrutural que merece retry ------------------

const debrid = require('../src/debrid');

test('isRateLimitError reconhece o código HTTP 200 do Premiumize', () => {
  assert.equal(isRateLimitError(new RateLimitError('rate_limit_reached')), true);
  assert.equal(isRateLimitError(new Error('rate_limit_reached')), true);
  assert.equal(isRateLimitError(new Error('too many API requests')), true);
  assert.equal(isRateLimitError(new QuotaError('Magnets limit reached')), false);
  assert.equal(isRateLimitError(new Error('timeout')), false);
});

test('premiumize: rate_limit_reached com HTTP 200 não vira unusable', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'too many requests',
      code: 'rate_limit_reached',
    }),
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-pm',
  };

  try {
    await assert.rejects(
      () => premiumize.checkCached('chave-pm', ['a'.repeat(40)]),
      (err) => {
        assert.equal(err.isRateLimitError, true);
        assert.equal(err.isQuotaError, undefined);
        return true;
      },
    );
    const result = await runtime.run({ opts: userOpts, encoded: '' }, () =>
      debrid.checkCached(['a'.repeat(40)]),
    );
    assert.equal(result.known, false);
    assert.equal(result.unusable, undefined, 'rate limit é transitório: a lista NÃO vira P2P');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('premiumize: authentication_failed com HTTP 200 vira AuthError', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'API key invalid',
      code: 'authentication_failed',
    }),
  });
  try {
    await assert.rejects(
      () => premiumize.checkCached('ruim', ['a'.repeat(40)]),
      (err) => err.isAuthError === true,
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('premiumize: account_limit_reached vira QuotaError (fair-use esgotado)', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'fair-use exhausted',
      code: 'account_limit_reached',
    }),
  });
  try {
    await assert.rejects(
      () => premiumize.checkCached('chave', ['a'.repeat(40)]),
      (err) => err.isQuotaError === true,
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('torbox: success:false sobe o detail, não só o código', async () => {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: false,
      error: 'DOWNLOAD_TOO_LARGE',
      detail: 'File exceeds your plan limit of 10 GB',
    }),
  });
  try {
    await assert.rejects(
      () => torbox.resolveLink('chave', 'a'.repeat(40), {}),
      (err) => {
        assert.match(err.message, /10 GB/);
        assert.match(err.message, /DOWNLOAD_TOO_LARGE/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('cooldown na checagem de cache é transitório: known:false, sem unusable', async () => {
  const original = debrid.BY_ID.get('premiumize');
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Premiumize fake',
    cacheCheck: true,
    async checkCached() {
      throw Object.assign(new Error('MAGNET_PROCESSING_COOLDOWN'), { isCooldown: true });
    },
  });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-cooldown',
  };

  try {
    const result = await runtime.run({ opts: userOpts, encoded: '' }, () =>
      debrid.checkCached(['hash-cooldown']),
    );
    assert.equal(result.known, false, 'cooldown vira "não sei", como qualquer falha transitória');
    assert.equal(result.unusable, undefined, 'cooldown não é auth/quota: a lista NÃO vira P2P');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});
