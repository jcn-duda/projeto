// Ledger durável do Real-Debrid (`rdc:v2`). A ESCRITA é do GATEWAY
// (`rd_renew_hits`, `note_rd_blocked`, `rd_warmer_ledger`); no oráculo ela é
// simulada com a MESMA régua (`adom-core::debrid_rd_ledger` via napi) e o
// MESMO KV nativo. O módulo de produção (`src/debrid/rd-ledger.js`) sobrou com
// leitura, vocabulário puro do golden (`scripts/rust/debrid-golden/rd-decision.mjs`)
// e o diagnóstico do painel — a régua em si nunca foi duplicada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import * as metrics from '../src/utils/metrics.js';
import * as ledger from './helpers/pipeline-oracle/rd-ledger.js';
import * as ledgerNode from '../src/debrid/rd-ledger.js';
import { knownInstant } from './helpers/pipeline-oracle/play/actions.js';
import * as runtime from '../src/runtime.js';
import { kvForget, kvRemaining } from '../src/utils/native-kv.js';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);
const H5 = '5'.repeat(40);

test.beforeEach(() => {
  cache.clearNamespace('rdc');
  metrics.reset();
  config.debrid.rdLedger.enabled = true;
  config.debrid.rdLedger.hitTtl = 2_592_000;
  config.debrid.rdLedger.blockedTtl = 2_592_000;
  config.debrid.rdLedger.missBackoffMs = [1_800_000, 7_200_000, 43_200_000, 259_200_000];
});

test('ledger: backoff do miss cresce a cada observação', () => {
  ledger.noteMiss(H1);
  const first = kvRemaining(ledgerNode.key(H1));
  ledger.noteMiss(H1);
  const second = kvRemaining(ledgerNode.key(H1));
  ledger.noteMiss(H1);
  const third = kvRemaining(ledgerNode.key(H1));

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
  assert.equal(ledgerNode.key(H4), `rdc:v2:${H4}`);
  // A API não recebe apiKey: a mesma leitura vale para duas instalações RD.
  assert.equal(ledger.isHit(H4), true);
  assert.equal(ledger.isHit(H4), true);
});

test('ledger: kill-switch desliga leitura e escrita', () => {
  config.debrid.rdLedger.enabled = false;
  ledger.noteHit([H5]);
  assert.equal(ledger.peek(H5), 'unknown');
  assert.equal(kvRemaining(ledgerNode.key(H5)), null);
});

test('ledger: status do Node zera a amostra e mede a ocupação durável que o gateway grava', () => {
  // O oráculo escreve na MESMA chave `rdc:v2:` que o gateway escreve em
  // produção — é essa ocupação durável que o diagnóstico do painel mede.
  ledger.noteHit([H1, H2]);
  ledger.noteMiss(H3);
  const st = ledgerNode.status();
  assert.equal(st.tracked, 0, 'amostra vazia por desenho: o escritor é o gateway');
  assert.equal(st.hits, 0);
  assert.equal(st.misses, 0);
  assert.equal(st.blocked, 0);
  assert.ok(st.l1Entries >= 3, 'ocupação durável vê as linhas do namespace rdc');
  assert.ok(st.l1Max >= st.l1Entries);
  assert.equal(st._origem.tracked, 'amostra');
  assert.equal(st._origem.l1Entries, 'duravel');

  // Forget não notifica processo nenhum: a ocupação desce na próxima leitura.
  kvForget(ledgerNode.key(H1));
  const after = ledgerNode.status();
  assert.ok(after.l1Entries < st.l1Entries, 'linha esquecida sai da ocupação');
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
      assert.equal(knownInstant(H1), true, 'hit deve ser true');
      assert.equal(knownInstant(H2), false, 'miss deve ser false');
      assert.equal(knownInstant(H3), false, 'blocked deve ser false');
      assert.equal(knownInstant(H4), false, 'unknown deve ser false');

      // Com ledger desativado
      config.debrid.rdLedger.enabled = false;
      assert.equal(knownInstant(H1), false, 'com ledger disabled deve ser false');
      config.debrid.rdLedger.enabled = true;

      // Com oráculo desativado
      config.debrid.rdOracle.enabled = false;
      assert.equal(knownInstant(H1), false, 'com oracle disabled deve ser false');
      config.debrid.rdOracle.enabled = true;
    });

    // Com AllDebrid ativo
    runtime.run({ opts: { debridService: 'alldebrid', debridApiKey: 'ad-key' }, encoded: '' }, () => {
      assert.equal(knownInstant(H1), false, 'alldebrid deve ser false');
    });

    // Sem debrid configurado
    runtime.run({ opts: {}, encoded: '' }, () => {
      assert.equal(knownInstant(H1), false, 'sem debrid deve ser false');
    });
  } finally {
    config.debrid.rdOracle.enabled = prevOracleEnabled;
    config.debrid.rdOracle.torrentio = prevOracleTorrentio;
  }
});
