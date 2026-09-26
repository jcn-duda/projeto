import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import * as autofetchTrace from '../src/utils/autofetch-trace.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { obraKey } from '../src/providers/autofetch-obra.js';
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

// Fase 7 do Chupim 2.0 — resumo por OBRA do teto (F2) no status do runner.
// O teste fixa a forma (digest de 12, pools, brReady, idade) e a higiene: o
// bloco nunca identifica a obra (sem imdbId, conta, chave ou hash cru).
test('obras no status: digest curto, pools contados e prova BR-ready sem vazar identidade', async () => {
  const identity = { adapterId: 'premiumize', account: 'conta-secreta-f7', imdbId: 'tt7654321', season: 1, episode: 2 };
  const key = obraKey(identity);
  const now = Date.now();
  cache.set(key, { entries: [
    { hash: 'a'.repeat(40), pool: 'br', acceptedAt: now, br: true, dubbed: true },
    { hash: 'b'.repeat(40), pool: 'seeds', acceptedAt: now - 1000 },
    { hash: 'c'.repeat(40), pool: 'exotico', acceptedAt: now - 500 },
  ] }, 900);
  const obraPrefix = `${prefix('autofetch')}o:`;
  const digest = key.slice(obraPrefix.length);
  cache.set(`${prefix('autofetch')}er:${digest}`, { at: now }, 900);

  try {
    const status = autofetchRunnerStatus();
    assert.ok(Array.isArray(status.obras), 'obras é array');
    const alvo = status.obras.find((o) => o.digest === digest.slice(0, 12));
    assert.ok(alvo, 'a obra semeada aparece no resumo');
    assert.equal(alvo.digest.length, 12);
    assert.deepEqual(alvo.pools, { br: 1, any: 0, seeds: 1 });
    assert.equal(alvo.brReady, true, 'prova durável da Fase 6 refletida');
    assert.equal(typeof alvo.ageMs, 'number');
    assert.ok(alvo.ageMs >= 0 && alvo.ageMs < 5000);

    const bloco = JSON.stringify(status.obras);
    assert.doesNotMatch(bloco, /tt\d+/, 'nenhum imdbId no bloco de obras');
    assert.equal(bloco.includes('conta-secreta-f7'), false, 'nenhuma conta no bloco');
    assert.doesNotMatch(bloco, /[a-f0-9]{40}/i, 'nenhum hash cru no bloco');
  } finally {
    cache.forget(key);
    cache.forget(`${prefix('autofetch')}er:${digest}`);
  }
});
