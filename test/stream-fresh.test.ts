// F4.3: o comportamento "fresco" (sem SWR/fast-path/índice/prefetch) deixou de
// depender da captura congelada. O gateway manda `X-Adom-Shadow-Frozen: 1` na
// 2ª request do canário direto; o header sozinho basta, mesmo sem
// `STREAM_FROZEN_MODE`/`STREAM_FROZEN_SHADOW_BASE`.
import { test } from 'node:test';
import assert from 'node:assert';
import * as runtime from '../src/runtime.js';
import { freshMode, freshRequest } from '../src/utils/stream-fresh.js';

test('header fresco liga o pipeline cru sem captura congelada', () => {
  // Fora de qualquer contexto: produção normal.
  assert.equal(freshRequest(), false);
  assert.equal(runtime.run({ shadowFrozen: false }, () => freshRequest()), false);
  // A 2ª request do gateway (ou do canário direto) traz o header.
  assert.equal(runtime.run({ shadowFrozen: true }, () => freshRequest()), true);
  // Contextos aninhados não vazam o flag para a request normal.
  assert.equal(
    runtime.run({ shadowFrozen: true }, () => {
      assert.equal(freshRequest(), true);
      return runtime.run({ shadowFrozen: false }, () => freshRequest());
    }),
    false,
  );
});

test('record/replay congelado continua fresco, mas depende do dir do corpus', () => {
  if (freshMode.MODE === 'record' || freshMode.MODE === 'replay') {
    // O processo de teste só cai aqui se o operador exportou o modo; o harness
    // passa STREAM_FROZEN_DIR, então a expectativa é a mesma do gate.
    assert.equal(freshRequest(), freshMode.hasDir);
    return;
  }
  // Fora do record/replay o header é a única fonte (default F4.3).
  assert.equal(freshMode.HONOR_HEADER, true);
  assert.equal(runtime.run({ shadowFrozen: true }, () => freshRequest()), true);
});
