import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batched, isAuthError, AuthError, isQuotaError, QuotaError,
  isRateLimitError, RateLimitError, json,
} from '../src/debrid/common.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as premiumize from '../src/debrid/premiumize.js';
import * as torbox from '../src/debrid/torbox.js';
import * as runtime from '../src/runtime.js';
import { applyDebrid } from '../src/providers/index.js';
import debrid from '../src/debrid/index.js';
import type { DebridAdapter } from '../types/domain.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const stream = (infoHash: any) => ({ infoHash, name: 'Release 1080p', title: 'Release 1080p' });

const hashes = (n: any) => Array.from({ length: n }, (_, i) => `h${i}`);
interface TestStream {
  name: string;
  title?: string;
  url?: string;
  infoHash?: string;
}
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;
const fakeFetch = (fn: () => Promise<any>) => fn as unknown as typeof globalThis.fetch;

test('isQuotaError separa conta cheia de falha transitória', () => {
  // O typo "accross" é da própria API da AllDebrid.
  assert.equal(isQuotaError(new Error('Magnets limit reached (1000 accross all tabs)')), true);
  assert.equal(isQuotaError(new Error('MAGNET_TOO_MANY_ACTIVE')), true);
  assert.equal(isQuotaError(new QuotaError('x')), true);
  assert.equal(
    isQuotaError(new RateLimitError('request limit reached')),
    false,
    'marca transitória tem precedência sobre o regex amplo de quota',
  );
  assert.equal(isQuotaError(new Error('timeout')), false);
  assert.equal(isQuotaError(new Error('AUTH_BAD_APIKEY')), false, 'chave inválida tem conserto próprio');
});

test('batched: todos os lotes barrados por cota sobem QuotaError', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new QuotaError('Magnets limit reached'); }),
    (err: any) => err.isQuotaError === true && err.isAuthError === undefined,
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
    (err: any) => {
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
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      error: { code: 'MAGNET_TOO_MANY_ACTIVE', message: 'Magnets limit reached (1000 accross all tabs)' },
    }),
  }));

  let refresh = null;
  try {
    const result = await runWith<TestStream[]>({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        deadlineAt: Date.now() + 5000,
        onCacheResult: (res: any) => { refresh = res.needsFullRefresh; },
      } as any),
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
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'too many requests',
      code: 'rate_limit_reached',
    }),
  }));
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-pm',
  };

  try {
    await assert.rejects(
      () => premiumize.checkCached('chave-pm', ['a'.repeat(40)]),
      (err: any) => {
        assert.equal(err.isRateLimitError, true);
        assert.equal(err.isQuotaError, undefined);
        return true;
      },
    );
    const result = await runWith<{ known: boolean; unusable?: { reason: string } }>({ opts: userOpts, encoded: '' }, () =>
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
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'API key invalid',
      code: 'authentication_failed',
    }),
  }));
  try {
    await assert.rejects(
      () => premiumize.checkCached('ruim', ['a'.repeat(40)]),
      (err: any) => err.isAuthError === true,
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
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'error',
      message: 'fair-use exhausted',
      code: 'account_limit_reached',
    }),
  }));
  try {
    await assert.rejects(
      () => premiumize.checkCached('chave', ['a'.repeat(40)]),
      (err: any) => err.isQuotaError === true,
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
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: false,
      error: 'DOWNLOAD_TOO_LARGE',
      detail: 'File exceeds your plan limit of 10 GB',
    }),
  }));
  try {
    await assert.rejects(
      () => torbox.resolveLink('chave', 'a'.repeat(40), {}),
      (err: any) => {
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
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', {
    id: 'premiumize',
    label: 'Premiumize fake',
    cacheCheck: true,
    async checkCached() {
      throw Object.assign(new Error('MAGNET_PROCESSING_COOLDOWN'), { isCooldown: true });
    },
  } as unknown as DebridAdapter);
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake-cooldown',
  };

  try {
    const result = await runWith<{ known: boolean; unusable?: { reason: string } }>({ opts: userOpts, encoded: '' }, () =>
      debrid.checkCached(['hash-cooldown']),
    );
    assert.equal(result.known, false, 'cooldown vira "não sei", como qualquer falha transitória');
    assert.equal(result.unusable, undefined, 'cooldown não é auth/quota: a lista NÃO vira P2P');
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

// --- Envelope success:false na CHECAGEM do TorBox (não só no play) ---------

test('torbox: ACTIVE_LIMIT no envelope da checagem vira QuotaError', async () => {
  // O `call` do adaptador classifica o envelope `{success:false, error:...}` —
  // mas a checagem de cache usa o `json` direto. O contrato: conta no teto de
  // magnets na hora da checagem é o MESMO estado estrutural do play (quota),
  // e o orquestrador degrada a lista para P2P em vez de marcar "nada em cache".
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: false,
      error: 'ACTIVE_LIMIT',
      detail: 'Account has reached the active torrent limit',
    }),
  }));

  try {
    await assert.rejects(
      () => torbox.checkCached('chave', ['a'.repeat(40)]),
      (err: any) => {
        assert.equal(err.isQuotaError, true, 'ACTIVE_LIMIT é cota, não falha genérica');
        assert.equal(err.isAuthError, undefined, 'e não é credencial recusada');
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('torbox: COOLDOWN_LIMIT no envelope da checagem vira RateLimitError', async () => {
  // Mesma regra do play: cooldown é rajada, não cota — a resposta do serviço
  // diz para esperar, e a lista NÃO pode virar P2P por causa disso.
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: false,
      error: 'COOLDOWN_LIMIT',
      detail: 'Too many requests, please wait',
    }),
  }));

  try {
    await assert.rejects(
      () => torbox.checkCached('chave', ['a'.repeat(40)]),
      (err: any) => {
        assert.equal(err.isRateLimitError, true, 'cooldown é rate limit, não cota');
        assert.equal(err.isQuotaError, undefined);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

// --- HTTP 429 no transporte: rate limit, não falha genérica -----------------

test('json: HTTP 429 vira RateLimitError', async () => {
  // 401/403 já viram AuthError no `json`; o contrato é 429 entrar na mesma
  // categoria própria de rate limit, senão o log diz "falhou" em vez de
  // "espera um minuto e tenta de novo" (o passe tardio refaz).
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = fakeFetch(async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited, tente de novo em instantes',
    json: async () => ({}),
  }));

  try {
    await assert.rejects(
      () => json('https://x.test/a'),
      (err: any) => err.isRateLimitError === true,
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

test('torbox: HTTP 429 na checagem propaga como RateLimitError, não "nenhum lote"', async () => {
  // Preferência pelo adaptador: é o caminho que a busca percorre. A marca
  // precisa sobreviver ao batched — todos os lotes recusados com a MESMA causa
  // sobem classificados, e a mensagem "nenhum lote respondeu" apagaria o motivo.
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = fakeFetch(async () => ({
    ok: false,
    status: 429,
    text: async () => 'slow down',
    json: async () => ({}),
  }));

  try {
    await assert.rejects(
      () => torbox.checkCached('chave', ['a'.repeat(40)]),
      (err: any) => {
        assert.equal(err.isRateLimitError, true);
        assert.doesNotMatch(err.message, /nenhum lote/, 'a causa não pode se perder no batched');
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

