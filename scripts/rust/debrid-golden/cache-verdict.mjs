/**
 * Oráculo do veredito de cache (`src/debrid/cache-check.ts`).
 *
 * Importa o dist real. Não chama checkCached, noteAvailable, peekDavail,
 * unusable() (métrica + notify), HTTP, dropUncached, cache.db nem magnetdb.
 * A classificação sai de unusableReason/failureReason e dos predicados de
 * common.js. O objeto { cached, known, unusable? } do ramo auth|quota é o
 * retorno de unusable() sem os efeitos: a função em si não é chamada.
 *
 * Persistência e notify ficam desligados ANTES do import (dotenv não
 * sobrescreve env já setada) para o grafo do módulo não abrir sqlite nem
 * disparar webhook.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';
process.env.MAGNET_DB = 'false';
process.env.MAGNET_BANK = 'false';
process.env.NOTIFY_ENABLED = 'false';
process.env.NOTIFY_WEBHOOK_URL = '';
process.env.CRAWL_ENABLED = 'false';
process.env.AUDIO_AUDIT = 'false';
process.env.RELEASE_INDEX = 'false';
process.env.HARVEST_ENABLED = 'false';
process.env.WARMUP_ENABLED = 'false';
process.env.SEED_ENABLED = 'false';
process.env.F3_ENABLED = 'false';
process.env.ACCOUNT_FAST_PATH = 'false';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CASES = path.join(REPO, 'test/fixtures/debrid/cache/cases.json');
const OUT = path.join(REPO, 'rust/crates/adom-core/tests/golden/debrid_cache_verdict.json');
const DIST = new URL('../../../dist/src/debrid/', import.meta.url);

const fail = (msg) => {
  console.error(`cache-verdict: ${msg}`);
  process.exit(1);
};

const {
  normalizeCacheResult,
  unusableReason,
  failureReason,
} = await import(new URL('cache-check.js', DIST));
const {
  AuthError,
  QuotaError,
  RateLimitError,
  isAuthError,
  isQuotaError,
  isRateLimitError,
} = await import(new URL('common.js', DIST));
const { errorMessage } = await import(new URL('../utils/logger.js', DIST));
const { id: premiumizeId, cacheCheck: premiumizeCheck } = await import(new URL('premiumize.js', DIST));
const { id: torboxId, cacheCheck: torboxCheck } = await import(new URL('torbox.js', DIST));
const { id: alldebridId, cacheCheck: alldebridCheck } = await import(new URL('alldebrid.js', DIST));
const { id: debridlinkId, cacheCheck: debridlinkCheck } = await import(new URL('debridlink.js', DIST));
const { id: realdebridId, cacheCheck: realdebridCheck } = await import(new URL('realdebrid-core.js', DIST));

const exported = [
  ['premiumize', premiumizeId, premiumizeCheck],
  ['torbox', torboxId, torboxCheck],
  ['alldebrid', alldebridId, alldebridCheck],
  ['debridlink', debridlinkId, debridlinkCheck],
  ['realdebrid', realdebridId, realdebridCheck],
];
const honestTable = new Map();
for (const [name, id, flag] of exported) {
  if (id !== name) fail(`id exportado por ${name} é ${JSON.stringify(id)}`);
  if (typeof flag !== 'boolean') fail(`${name}.cacheCheck não é boolean`);
  honestTable.set(id, flag);
}
const requiredHonest = {
  premiumize: true,
  torbox: true,
  alldebrid: true,
  debridlink: false,
  realdebrid: false,
};
for (const [id, want] of Object.entries(requiredHonest)) {
  if (honestTable.get(id) !== want) {
    fail(`${id} exporta cacheCheck=${honestTable.get(id)}; o núcleo travado é ${want}`);
  }
}

function buildError(spec) {
  let err;
  if (spec.class === 'AuthError') err = new AuthError(spec.message);
  else if (spec.class === 'QuotaError') err = new QuotaError(spec.message);
  else if (spec.class === 'RateLimitError') err = new RateLimitError(spec.message);
  else if (spec.class === 'Error') err = new Error(spec.message);
  else fail(`${spec.id}: classe ${spec.class} não é predicado de common.ts`);
  if (spec.isAuthError === true) err.isAuthError = true;
  if (spec.isQuotaError === true) err.isQuotaError = true;
  if (spec.isRateLimitError === true) err.isRateLimitError = true;
  return err;
}

function toResponse(spec) {
  if (spec.form === 'set') return new Set(spec.cached);
  if (spec.form !== 'object') fail(`${spec.id}: form ${spec.form}`);
  const result = { cached: new Set(spec.cached) };
  if (Object.prototype.hasOwnProperty.call(spec, 'complete')) result.complete = spec.complete;
  return result;
}

function verdictOf(result) {
  const out = { cached: [...result.cached], known: result.known };
  if (result.unusable) out.unusable = { reason: result.unusable.reason, message: result.unusable.message };
  return out;
}

/**
 * Retorno de unusable() sem metrics/log/notify. O motivo vem de
 * unusableReason (TS real). rate e falha não ganham a chave unusable.
 */
function failureVerdict(reason, message) {
  if (reason === 'auth' || reason === 'quota') {
    return { cached: [], known: false, unusable: { reason, message } };
  }
  return { cached: [], known: false };
}

const corpus = JSON.parse(fs.readFileSync(CASES, 'utf8'));
const cases = [];

for (const spec of corpus.normalize) {
  const result = normalizeCacheResult({ id: 'oracle' }, toResponse(spec));
  const input = { form: spec.form, cached: spec.cached };
  if (Object.prototype.hasOwnProperty.call(spec, 'complete')) input.complete = spec.complete;
  cases.push({
    id: spec.id,
    op: 'normalize',
    input,
    expect: verdictOf(result),
  });
}

for (const spec of corpus.errors) {
  const err = buildError(spec);
  const reason = unusableReason(err);
  const failure = failureReason(err);
  const message = errorMessage(err);
  if (typeof isAuthError(err) !== 'boolean') fail(`${spec.id}: isAuthError não é boolean`);
  if (typeof isQuotaError(err) !== 'boolean') fail(`${spec.id}: isQuotaError não é boolean`);
  if (typeof isRateLimitError(err) !== 'boolean') fail(`${spec.id}: isRateLimitError não é boolean`);
  cases.push({
    id: spec.id,
    op: 'failure',
    input: {
      isAuthError: isAuthError(err),
      isQuotaError: isQuotaError(err),
      isRateLimitError: isRateLimitError(err),
      message,
    },
    expect: {
      unusableReason: reason,
      failureReason: failure,
      verdict: failureVerdict(reason, message),
    },
  });
}

for (const spec of corpus.honest) {
  const expect = honestTable.has(spec.service) ? honestTable.get(spec.service) : false;
  cases.push({
    id: spec.id,
    op: 'honest',
    input: { service: spec.service },
    expect,
  });
}

const byId = new Map(cases.map((row) => [row.id, row]));
const need = (id) => {
  const row = byId.get(id);
  if (!row) fail(`caso obrigatório ausente: ${id}`);
  return row;
};
const eq = (id, cond) => {
  if (!cond) fail(`contrato do dist quebrou em ${id}`);
};

const setHashes = need('set-hashes');
eq('set-hashes', setHashes.expect.known === true && setHashes.expect.cached.join(',') === 'h1,h2');
eq('set-mixed-case', need('set-mixed-case').expect.cached.join(',') === 'AbC');
eq('set-dupes', need('set-dupes').expect.cached.join(',') === 'h1,h2' && need('set-dupes').expect.known === true);
eq('object-complete-true', need('object-complete-true').expect.known === true);
const incomplete = need('object-complete-false');
eq('object-complete-false', incomplete.expect.known === false && incomplete.expect.cached.join(',') === 'h1,h2');
eq('object-complete-omitted', need('object-complete-omitted').expect.known === true);
eq('object-complete-null', need('object-complete-null').expect.known === true);
const emptyKnown = need('empty-set-known-true');
const emptyUnknown = need('empty-object-complete-false');
eq('empty-set-known-true', emptyKnown.expect.known === true && emptyKnown.expect.cached.length === 0);
eq('empty-object-complete-true', need('empty-object-complete-true').expect.known === true && need('empty-object-complete-true').expect.cached.length === 0);
eq(
  'empty-object-complete-false',
  emptyUnknown.expect.known === false && emptyUnknown.expect.cached.length === 0 && emptyKnown.expect.known !== emptyUnknown.expect.known,
);

function expectFailure(id, { unusableReason: reason, failureReason: failure, unusable }) {
  const row = need(id);
  eq(id, row.expect.unusableReason === reason && row.expect.failureReason === failure);
  if (unusable) {
    eq(id, row.expect.verdict.known === false && row.expect.verdict.cached.length === 0);
    eq(id, row.expect.verdict.unusable?.reason === unusable && row.expect.verdict.unusable?.message === row.input.message);
  } else {
    eq(id, row.expect.verdict.known === false && row.expect.verdict.cached.length === 0 && row.expect.verdict.unusable == null);
  }
}

expectFailure('auth-class', { unusableReason: 'auth', failureReason: 'auth', unusable: 'auth' });
expectFailure('auth-message', { unusableReason: 'auth', failureReason: 'auth', unusable: 'auth' });
expectFailure('quota-class', { unusableReason: 'quota', failureReason: 'quota', unusable: 'quota' });
expectFailure('quota-message', { unusableReason: 'quota', failureReason: 'quota', unusable: 'quota' });
expectFailure('quota-class-account-code', { unusableReason: 'quota', failureReason: 'quota', unusable: 'quota' });
expectFailure('plain-account-code-not-quota', { unusableReason: null, failureReason: 'falha', unusable: null });
expectFailure('rate-class', { unusableReason: null, failureReason: 'rate', unusable: null });
expectFailure('rate-message', { unusableReason: null, failureReason: 'rate', unusable: null });
expectFailure('rate-blocks-quota', { unusableReason: null, failureReason: 'rate', unusable: null });
expectFailure('auth-wins-over-rate', { unusableReason: 'auth', failureReason: 'auth', unusable: 'auth' });
expectFailure('generic', { unusableReason: null, failureReason: 'falha', unusable: null });
expectFailure('plain-cooldown-not-rate', { unusableReason: null, failureReason: 'falha', unusable: null });
expectFailure('rate-class-cooldown', { unusableReason: null, failureReason: 'rate', unusable: null });

eq('honest-premiumize', need('honest-premiumize').expect === true);
eq('honest-torbox', need('honest-torbox').expect === true);
eq('honest-alldebrid', need('honest-alldebrid').expect === true);
eq('honest-debridlink', need('honest-debridlink').expect === false);
eq('honest-realdebrid', need('honest-realdebrid').expect === false);
eq('honest-unknown', need('honest-unknown').expect === false);

const ids = cases.map((row) => row.id);
if (new Set(ids).size !== ids.length) fail('id de caso duplicado');

const doc = {
  oracle: 'dist/src/debrid/cache-check.js',
  cases,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`cache-verdict: ${cases.length} casos → rust/crates/adom-core/tests/golden/debrid_cache_verdict.json`);
