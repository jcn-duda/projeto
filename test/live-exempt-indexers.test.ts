import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { jackett } from '../src/config/jackett.js';
import { liveIndexers } from '../src/providers/search-plan.js';
import { probeIndexers, probeEnabled } from '../src/providers/br-probe.js';
import { allowedSourceIndexer } from '../src/providers/allowed-source-indexer.js';
import * as runtime from '../src/runtime.js';

test('liveIndexers com exempt mantem o apache e ainda remove o 1337x', () => {
  const selecionados = ['thepiratebay', '1337x', 'apachetorrent-cardigann', 'redetorrent-cardigann'];
  const indexOnly = config.jackett.indexOnlyIndexers;
  const exempt = config.jackett.liveExemptIndexers;

  const vivos = liveIndexers(selecionados, indexOnly, exempt);
  assert.ok(vivos.includes('apachetorrent-cardigann'), 'apachetorrent-cardigann esta presente no plano ao vivo via exempt');
  assert.ok(!vivos.includes('1337x'), '1337x continua removido');
  assert.ok(!vivos.includes('redetorrent-cardigann'), 'redetorrent-cardigann continua removido');
  assert.ok(vivos.includes('thepiratebay'), 'thepiratebay preservado');
});

test('liveIndexers: terceiro parametro ausente preserva o comportamento antigo', () => {
  const selecionados = ['thepiratebay', '1337x', 'apachetorrent-cardigann'];
  const indexOnly = config.jackett.indexOnlyIndexers;

  const vivos = liveIndexers(selecionados, indexOnly);
  assert.ok(!vivos.includes('1337x'), '1337x fica fora sem exempt');
  assert.ok(!vivos.includes('apachetorrent-cardigann'), 'apachetorrent-cardigann fica fora sem exempt');
  assert.deepEqual(vivos, ['thepiratebay']);
});

test('probeIndexers subtrai os isentos e continua nao-vazio, probeEnabled continua true', () => {
  const targets = probeIndexers();
  assert.ok(!targets.includes('apachetorrent-cardigann'), 'apachetorrent-cardigann nao deve ser sondado em duplicidade');
  assert.ok(targets.includes('redetorrent-cardigann'), 'redetorrent-cardigann continua na sonda');
  assert.ok(targets.includes('hdrtorrent-cardigann'), 'hdrtorrent-cardigann continua na sonda');
  assert.ok(targets.length > 0, 'intersecao nao-vazia');
  assert.equal(probeEnabled(), true, 'probeEnabled continua true');
});

test('trava regressao (1): allowedSourceIndexer continua true para apachetorrent com ji que nao o inclui', () => {
  const customOpts = {
    ...runtime.normalize(null),
    providers: ['jackett'],
    jackettIndexers: ['thepiratebay'],
  };
  runtime.run({ opts: customOpts, encoded: 'test-ji-no-apache' }, () => {
    assert.equal(
      allowedSourceIndexer('apachetorrent-cardigann'),
      true,
      'apache continua permitido mesmo quando o ji nao o inclui (semantica index-only preservada)',
    );
    assert.equal(allowedSourceIndexer('hdrtorrent-cardigann'), true);
    assert.equal(allowedSourceIndexer('thepiratebay'), true);
    assert.equal(allowedSourceIndexer('yts'), false);
  });
});

test('trava regressao (2): a elegibilidade index-only do magnet-bank-instant continua valendo para o apache', () => {
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

test('JACKETT_LIVE_EXEMPT_INDEXERS vazio restaura o comportamento anterior', () => {
  const prevEnv = process.env.JACKETT_LIVE_EXEMPT_INDEXERS;
  try {
    process.env.JACKETT_LIVE_EXEMPT_INDEXERS = '';
    const reloadedJackett = jackett();
    assert.deepEqual(
      reloadedJackett.liveExemptIndexers,
      [],
      'liveExemptIndexers fica vazio com env vazio',
    );
    const selecionados = ['thepiratebay', '1337x', 'apachetorrent-cardigann'];
    const vivos = liveIndexers(selecionados, config.jackett.indexOnlyIndexers, reloadedJackett.liveExemptIndexers);
    assert.ok(!vivos.includes('apachetorrent-cardigann'), 'apache volta a ser excluido do plano ao vivo');
    assert.deepEqual(vivos, ['thepiratebay']);
  } finally {
    if (prevEnv !== undefined) {
      process.env.JACKETT_LIVE_EXEMPT_INDEXERS = prevEnv;
    } else {
      delete process.env.JACKETT_LIVE_EXEMPT_INDEXERS;
    }
    // reset
  }
});
