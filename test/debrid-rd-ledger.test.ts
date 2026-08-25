import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as ledger from '../src/debrid/rd-ledger.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import { selectProbeCandidates } from '../src/providers/rd-probe.js';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);
const H5 = '5'.repeat(40);

test.beforeEach(() => {
  cache.clearNamespace('rdc');
  metrics.reset();
  ledger.reset();
  config.debrid.rdLedger.enabled = true;
  config.debrid.rdLedger.hitTtl = 2_592_000;
  config.debrid.rdLedger.blockedTtl = 2_592_000;
  config.debrid.rdLedger.missBackoffMs = [1_800_000, 7_200_000, 43_200_000, 259_200_000];
});

test('ledger: backoff do miss cresce a cada observação', () => {
  ledger.noteMiss(H1);
  const first = cache.peekRemaining(ledger.key(H1));
  ledger.noteMiss(H1);
  const second = cache.peekRemaining(ledger.key(H1));
  ledger.noteMiss(H1);
  const third = cache.peekRemaining(ledger.key(H1));

  assert.ok(first != null && second != null && third != null);
  assert.ok(second > first, 'segunda observação espera mais antes de re-sondar');
  assert.ok(third > second, 'backoff segue crescendo até o teto configurado');
  assert.equal(ledger.peek(H1), 'miss');
});

test('ledger: hit fresco não é regravado antes da segunda metade do TTL', () => {
  ledger.noteHit([H2]);
  metrics.reset();
  ledger.renewHits([H2]);

  const counters = metrics.snapshot().counters as Record<string, number>;
  assert.equal(counters['debrid.rd.ledger.noted'], undefined);
  assert.equal(ledger.isHit(H2), true);
});

test('ledger: blocked vence hit atrasado', () => {
  ledger.noteHit([H3]);
  ledger.noteBlocked(H3);
  ledger.noteHit([H3]);
  assert.equal(ledger.peek(H3), 'blocked');
  assert.equal(ledger.isHit(H3), false);
});

test('ledger: chave é global e não carrega conta', () => {
  ledger.noteHit([H4]);
  assert.equal(ledger.key(H4), `rdc:v1:${H4}`);
  // A API não recebe apiKey: a mesma leitura vale para duas instalações RD.
  assert.equal(ledger.isHit(H4), true);
  assert.equal(ledger.isHit(H4), true);
});

test('ledger: kill-switch desliga leitura e escrita', () => {
  config.debrid.rdLedger.enabled = false;
  ledger.noteHit([H5]);
  assert.equal(ledger.peek(H5), 'unknown');
  assert.equal(cache.peekRemaining(ledger.key(H5)), null);
});

test('sonda: miss do ledger pula hash e volta após o backoff', async () => {
  config.debrid.rdLedger.missBackoffMs = [1_000];
  const streams: any[] = [{
    infoHash: H5,
    name: 'Fonte BR',
    _seeders: 1,
    _dubbed: true,
    _br: true,
  }];
  ledger.noteMiss(H5);
  assert.deepEqual(selectProbeCandidates(streams, new Set(), 'conta-a', 1, 'chave-a'), []);

  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.deepEqual(selectProbeCandidates(streams, new Set(), 'conta-b', 1, 'chave-b'), [H5]);
});

test('ledger: status reflete tracked e poda expirados em track', () => {
  ledger.noteHit([H1, H2]);
  const st1 = ledger.status();
  assert.equal(st1.hits, 2);
  assert.equal(st1.tracked, 2);
});

test('knownInstant despacha para rdLedger quando RD + ledger ativos e false para outros adaptadores', () => {
  ledger.noteHit([H1]);
  ledger.noteMiss(H2);
  ledger.noteBlocked(H3);

  const prevOracleEnabled = config.debrid.rdOracle.enabled;
  const prevOracleTorrentio = config.debrid.rdOracle.torrentio;
  config.debrid.rdOracle.enabled = true;
  config.debrid.rdOracle.torrentio = true;

  try {
    // Com Real-Debrid ativo e ledger ativo
    runtime.run({ opts: { debridService: 'realdebrid', debridApiKey: 'rd-key' }, encoded: '' }, () => {
      assert.equal(debrid.knownInstant(H1), true, 'hit deve ser true');
      assert.equal(debrid.knownInstant(H2), false, 'miss deve ser false');
      assert.equal(debrid.knownInstant(H3), false, 'blocked deve ser false');
      assert.equal(debrid.knownInstant(H4), false, 'unknown deve ser false');

      // Com ledger desativado
      config.debrid.rdLedger.enabled = false;
      assert.equal(debrid.knownInstant(H1), false, 'com ledger disabled deve ser false');
      config.debrid.rdLedger.enabled = true;

      // Com oráculo desativado
      config.debrid.rdOracle.enabled = false;
      assert.equal(debrid.knownInstant(H1), false, 'com oracle disabled deve ser false');
      config.debrid.rdOracle.enabled = true;
    });

    // Com AllDebrid ativo
    runtime.run({ opts: { debridService: 'alldebrid', debridApiKey: 'ad-key' }, encoded: '' }, () => {
      assert.equal(debrid.knownInstant(H1), false, 'alldebrid deve ser false');
    });

    // Sem debrid configurado
    runtime.run({ opts: {}, encoded: '' }, () => {
      assert.equal(debrid.knownInstant(H1), false, 'sem debrid deve ser false');
    });
  } finally {
    config.debrid.rdOracle.enabled = prevOracleEnabled;
    config.debrid.rdOracle.torrentio = prevOracleTorrentio;
  }
});
