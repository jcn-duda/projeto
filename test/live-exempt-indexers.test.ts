import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { jackett } from '../src/config/jackett.js';
import { probeIndexers, probeEnabled } from '../src/providers/br-probe.js';

test('probeIndexers subtrai os isentos e continua nao-vazio, probeEnabled continua true', () => {
  const targets = probeIndexers();
  assert.ok(!targets.includes('apachetorrent-cardigann'), 'apachetorrent-cardigann nao deve ser sondado em duplicidade');
  assert.ok(targets.includes('redetorrent-cardigann'), 'redetorrent-cardigann continua na sonda');
  assert.ok(targets.includes('hdrtorrent-cardigann'), 'hdrtorrent-cardigann continua na sonda');
  assert.ok(targets.length > 0, 'intersecao nao-vazia');
  assert.equal(probeEnabled(), true, 'probeEnabled continua true');
});

test('trava regressao (2): a elegibilidade index-only do banco de magnets continua valendo para o apache', () => {
  const indexOnlySet = new Set(config.jackett.indexOnlyIndexers.map((id) => String(id).trim().toLowerCase()));
  assert.ok(
    indexOnlySet.has('apachetorrent-cardigann'),
    'apachetorrent-cardigann continua em indexOnlyIndexers para elegibilidade no banco de magnets',
  );
  assert.ok(
    config.jackett.indexOnlyIndexers.includes('apachetorrent-cardigann'),
    'apachetorrent-cardigann esta em config.jackett.indexOnlyIndexers',
  );
});

test('JACKETT_LIVE_EXEMPT_INDEXERS vazio zera a lista de isentos', () => {
  const prevEnv = process.env.JACKETT_LIVE_EXEMPT_INDEXERS;
  try {
    process.env.JACKETT_LIVE_EXEMPT_INDEXERS = '';
    const reloadedJackett = jackett();
    assert.deepEqual(
      reloadedJackett.liveExemptIndexers,
      [],
      'liveExemptIndexers fica vazio com env vazio',
    );
  } finally {
    if (prevEnv !== undefined) {
      process.env.JACKETT_LIVE_EXEMPT_INDEXERS = prevEnv;
    } else {
      delete process.env.JACKETT_LIVE_EXEMPT_INDEXERS;
    }
    // reset
  }
});
