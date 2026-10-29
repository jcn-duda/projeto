// Higiene do que o Chupim publica: o anel de desistências (`autofetch-trace`)
// e o resumo por OBRA do teto F2 (`autofetch-obra-summary`). Os dois módulos
// FICAM na leva B4; o `autofetchRunnerStatus` (que juntava os dois) saiu com o
// corpo do runner, então o teste mede cada peça direto.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { createHash } from 'node:crypto';

import config from '../src/config.js';
import * as autofetchTrace from '../src/utils/autofetch-trace.js';
import { prefix } from '../src/utils/cache-keys.js';
import { obraSummaries } from '../src/providers/autofetch-obra-summary.js';
import { kvForget } from '../src/utils/native-kv.js';
import { commitObraNative, noteBrReadyNative } from '../src/utils/autofetch-state-native.js';
import {
  createStreamTrace, sanitizeTraceLabel, setTraceChupim, STREAM_TRACE_CHUPIM_MAX,
} from '../src/utils/stream-trace.js';

const API_KEY = 'chave-secreta-do-trace';
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

function entry(label: string, o: { reason?: string; adapter?: string; pool?: string } = {}) {
  return {
    adapter: o.adapter ?? 'premiumize',
    pool: o.pool ?? 'br',
    reason: o.reason ?? 'dead',
    label,
    br: true,
    dubbed: true,
    quality: '1080p',
    hash12: autofetchTrace.hash12(H1),
  };
}

test('kill-switch AUTOFETCH_TRACE=false: ring fica vazio e volta a encher quando liga', () => {
  const original = config.debrid.autoFetchTrace;
  try {
    config.debrid.autoFetchTrace = false;
    autofetchTrace.clear();
    for (let i = 0; i < 1000; i += 1) autofetchTrace.note(entry(`Filme ${i}`));
    assert.deepEqual(autofetchTrace.lastSkips(), [], 'ring vazio com kill-switch desligado');
    assert.equal(autofetchTrace.traceEnabled(), false);

    config.debrid.autoFetchTrace = true;
    for (let i = 0; i < 1000; i += 1) autofetchTrace.note(entry(`Filme ${i}`));
    assert.equal(autofetchTrace.lastSkips(200).length, autofetchTrace.RING_MAX, 'anel tem teto próprio');
  } finally {
    config.debrid.autoFetchTrace = original;
    autofetchTrace.clear();
  }
});

test('rótulo com magnet e hash 40-hex sai sanitizado no anel', () => {
  autofetchTrace.clear();
  try {
    autofetchTrace.note(entry(`Coringa magnet:?xt=urn:btih:${H2}&dn=Coringa%202019`));
    autofetchTrace.note(entry(`Coringa ${H2} 1080p`));
    const recent = autofetchTrace.lastSkips(5);
    assert.equal(recent[0].label, 'Coringa <magnet>', 'URI inteira do magnet vira <magnet>');
    assert.equal(recent[1].label, 'Coringa <hash> 1080p', '40-hex fora de magnet vira <hash>');
    assert.equal(sanitizeTraceLabel(`x magnet:?xt=urn:btih:${H1}`), 'x <magnet>', 'mesma régua do saneador exportado');
  } finally {
    autofetchTrace.clear();
  }
});

test('payload do anel não expõe hash cru, searchKey, magnet nem apiKey', () => {
  autofetchTrace.clear();
  try {
    autofetchTrace.note(entry(`Filme magnet:?xt=urn:btih:${H1}`, { reason: 'marker' }));
    autofetchTrace.note(entry(`Filme ${H2}`, { reason: 'already-cached', pool: 'seeds' }));
    const body = JSON.stringify(autofetchTrace.lastSkips());
    assert.doesNotMatch(body, /[a-f0-9]{40}/i, 'nenhum infoHash cru no payload');
    assert.doesNotMatch(body, /magnet:/i, 'nenhum magnet cru');
    assert.equal(body.includes(API_KEY), false, 'nenhuma apiKey');
    const skips = autofetchTrace.lastSkips();
    assert.equal(skips.length, 2);
    for (const skip of skips) {
      assert.equal(skip.hash12.length, 12, 'só o digest curto do hash');
      assert.match(skip.hash12, /^[a-f0-9]{12}$/);
    }
    assert.equal(skips[0].hash12, skips[1].hash12, 'mesmo hash de entrada ⇒ mesmo digest');
  } finally {
    autofetchTrace.clear();
  }
});

// O campo `chupim` do trace ficou sem escritor no Node depois do corte (quem
// escrevia era o corpo do Chupim), mas o SANEADOR que o guarda continua vivo —
// `setTraceChupim` ainda é a única porta de entrada do campo.
test('resumo do Chupim no trace: magnet/hash fora e teto de unidades', () => {
  const t = createStreamTrace();
  setTraceChupim(t, `pool=br; seeds=n/a; magnet:?xt=urn:btih:${H1}; ${H2}`);
  assert.equal(t.chupim, 'pool=br; seeds=n/a; <magnet>; <hash>', 'mesma defesa do rótulo');

  const longo = createStreamTrace();
  setTraceChupim(longo, 'p'.repeat(STREAM_TRACE_CHUPIM_MAX + 40));
  assert.equal(String(longo.chupim).length, STREAM_TRACE_CHUPIM_MAX, 'corta no teto');
  assert.equal(String(longo.chupim).endsWith('…'), true, 'marca o corte com reticências');

  setTraceChupim(t, '');
  assert.equal(t.chupim, '', 'texto vazio não inventa rótulo');
});

// Fase 7 do Chupim 2.0 — resumo por OBRA do teto (F2). A forma (digest de 12,
// pools, brReady, idade) e a higiene (sem imdbId, conta, chave ou hash cru) são
// as do painel que fica com `autofetch-obra-summary`.
test('obras no painel: digest curto, pools contados e prova BR-ready sem vazar identidade', () => {
  // A régua de identidade saiu do TS na leva 6e (vive em `adom-core::autofetch_obra`):
  // o painel NÃO calcula chave de obra, só enumera o namespace `o:` e trunca o
  // digest. Qualquer sha256 de 64 hex é uma obra válida para o resumo.
  const digest = createHash('sha256').update('conta-secreta-f7:tt7654321:1:2').digest('hex');
  const now = Date.now();
  // `o:` e `er:` são RUST_OWNED: a semente vai pela ponte.
  const obraPrefix = `${prefix('autofetch')}o:`;
  const key = `${obraPrefix}${digest}`;
  try {
    assert.equal(
      obraSummaries().some((item) => item.digest === digest.slice(0, 12)),
      false,
      'obra não semeada não aparece',
    );

    // Semeia pela MESMA porta do commit real: chave `autofetch:v3:o:<digest>` → KV nativo.
    const entryBr = { hash: H1, pool: 'br', acceptedAt: now, br: true, dubbed: true };
    const entrySeeds = { hash: H2, pool: 'seeds', acceptedAt: now - 1000 };
    const entryExotico = { hash: 'c'.repeat(40), pool: 'exotico', acceptedAt: now - 500 };
    for (const e of [entryBr, entrySeeds, entryExotico]) commitObraNative(key, e, 900);
    noteBrReadyNative(digest, 900, now);

    const alvo = obraSummaries().find((item) => item.digest === digest.slice(0, 12));
    assert.ok(alvo, 'a obra semeada aparece no resumo');
    assert.equal(alvo.digest.length, 12);
    assert.deepEqual(alvo.pools, { br: 1, any: 0, seeds: 1 });
    assert.equal(alvo.brReady, true, 'prova durável da Fase 6 refletida');
    assert.equal(typeof alvo.ageMs, 'number');
    assert.ok(alvo.ageMs >= 0 && alvo.ageMs < 5000);

    const bloco = JSON.stringify(obraSummaries());
    assert.doesNotMatch(bloco, /tt\d+/, 'nenhum imdbId no bloco de obras');
    assert.equal(bloco.includes('conta-secreta-f7'), false, 'nenhuma conta no bloco');
    assert.doesNotMatch(bloco, /[a-f0-9]{40}/i, 'nenhum hash cru no bloco');
  } finally {
    kvForget(key);
    kvForget(`${prefix('autofetch')}er:${digest}`);
  }
});
