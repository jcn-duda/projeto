import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as autofetchTrace from '../src/utils/autofetch-trace.js';
import { noteSkip } from '../src/providers/autofetch-gates.js';
import { autofetchRunnerStatus } from '../src/providers/autofetch-runner.js';
import {
  H1, H2, H3, API_KEY,
  pmAdapter, originalEnqueue, brDub, delta, runEnqueue, resetSkipState, stubEnqueue,
} from './helpers/autofetch-skip-common.js';

test.before(() => {
  pmAdapter.enqueue = stubEnqueue;
  resetSkipState();
});

test.after(() => {
  pmAdapter.enqueue = originalEnqueue;
  resetSkipState();
});

test('kill-switch AUTOFETCH_TRACE=false: contador continua, ring fica vazio após 1000 chamadas', async () => {
  const original = config.debrid.autoFetchTrace;
  try {
    config.debrid.autoFetchTrace = false;
    autofetchTrace.clear();
    const d = delta('dead');
    for (let i = 0; i < 1000; i += 1) {
      noteSkip('dead', brDub(H1) as any, 'premiumize', 'br');
    }
    assert.equal(d(), 1000, 'contador conta mesmo com trace desligado');
    assert.deepEqual(autofetchTrace.lastSkips(), [], 'ring vazio com kill-switch desligado');
  } finally {
    config.debrid.autoFetchTrace = original;
  }
});

test('rótulo com magnet e hash 40-hex sai sanitizado no trace', async () => {
  const magnet = `Coringa magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Coringa%202019`;
  const bare = `Coringa ${'c'.repeat(40)} 1080p`;
  noteSkip('marker', brDub(H1, { title: magnet }) as any, 'torbox', 'br');
  noteSkip('marker', brDub(H1, { title: bare }) as any, 'torbox', 'br');
  const recent = autofetchTrace.lastSkips(5);
  assert.equal(recent[0].label, 'Coringa <magnet>', 'URI inteira do magnet vira <magnet>');
  assert.equal(recent[1].label, 'Coringa <hash> 1080p', '40-hex fora de magnet vira <hash>');
});

test('payload do status não expõe hash cru, searchKey, magnet nem apiKey', async () => {
  autofetchTrace.clear();
  await runEnqueue(H1, {}, { cached: [H1], searchKey: 'busca-secreta-1' });
  await runEnqueue(H2, {}, { cached: [H2], searchKey: 'busca-secreta-2' });
  noteSkip('dead', brDub(H3, { title: `Filme magnet:?xt=urn:btih:${'d'.repeat(40)}` }) as any, 'torbox', 'br');
  const body = JSON.stringify(autofetchRunnerStatus());
  assert.doesNotMatch(body, /[a-f0-9]{40}/i, 'nenhum infoHash cru no payload');
  assert.doesNotMatch(body, /magnet:/i, 'nenhum magnet cru');
  assert.equal(body.includes('busca-secreta'), false, 'nenhum searchKey cru');
  assert.equal(body.includes(API_KEY), false, 'nenhuma apiKey');
  const skips = autofetchRunnerStatus().skips;
  assert.equal(typeof skips, 'object');
  assert.ok(Array.isArray(autofetchRunnerStatus().lastSkips));
});
