// Protetor com destino final provado NÃO-magnet (gate-2 do vacadb com
// download direto — Google Drive) e magnet gravado sem os dois-pontos
// (`urnbtih<hash>`). Dados reais medidos em 2026-09-26 nas páginas do Vaca que
// davam `no_magnet`: 25 de 27 eram Drive, 2 eram magnets bons mutilados.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as transport from '../resolvers/transport.js';
import { b64DataLinkIsHttp, createMagnetExtractor } from '../resolvers/magnet-extract.js';

const opts = {
  assertAllowedUrl: (u: unknown) => new URL(String(u)),
  decodeEntities: (s: unknown) => String(s),
  extractMagnet: (html: string): string | null => {
    const m = String(html).match(/magnet:\?[^"'<>\s]+/);
    return m ? m[0] : null;
  },
  nextProtectedUrl: () => null,
  extractMetaRefresh: () => null,
  maxHops: 10,
  timeoutMs: 5000,
  userAgent: 'UA/1.0',
};

describe('followProtectedUrl: destino provado não-magnet (download direto)', () => {
  const driveGate = fs.readFileSync(fileURLToPath(new URL('./fixtures/crawl/vaca/protector-final-drive.html', import.meta.url)), 'utf8');
  const serve = () => (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => driveGate,
  })) as unknown as typeof fetch;

  test('gate-2 com data-link do Drive + isNonMagnetTarget → protector_non_magnet', async () => {
    const original = global.fetch;
    global.fetch = serve();
    try {
      await assert.rejects(
        () => transport.followProtectedUrl('https://sys-a.example.com/go', null, { ...opts, isNonMagnetTarget: b64DataLinkIsHttp }),
        /protector_non_magnet/,
      );
    } finally {
      global.fetch = original;
    }
  });

  test('sem o detector o laço segue como antes (no_magnet)', async () => {
    const original = global.fetch;
    global.fetch = serve();
    try {
      await assert.rejects(
        () => transport.followProtectedUrl('https://sys-a.example.com/go', null, opts),
        /no_magnet/,
      );
    } finally {
      global.fetch = original;
    }
  });

  test('magnet gravado SEM dois-pontos (urnbtih<hash>) é remontado pelo hash', () => {
    // data-link REAL da página final de A Raiz do Mal (2026-09-26): decodifica
    // `magnet:?xt=urnbtih3831…&tr=udptracker.openbittorrent.com80announce…`.
    const real = '<body data-link="bWFnbmV0Oj94dD11cm5idGloMzgzMWE2YTdjMGI5YjQ4YTJlMDIwYTEyMGE0MmUwNjk2YTY4N2ZhMSZ0cj11ZHB0cmFja2VyLm9wZW5iaXR0b3JyZW50LmNvbTgwYW5ub3VuY2UmdHI9dWRwdHJhY2tlci5vcGVudHJhY2tyLm9yZzEzMzdhbm5vdW5jZSZ0cj11ZHB0cmFja2VyLmludGVybmV0d2FycmlvcnMubmV0MTMzN2Fubm91bmNl">';
    const extract = createMagnetExtractor({ decodeEntities: (v) => String(v ?? ''), encodedVariants: true, b64DataLink: true });
    assert.equal(extract(real), 'magnet:?xt=urn:btih:3831a6a7c0b9b48a2e020a120a42e0696a687fa1');
    assert.equal(b64DataLinkIsHttp(real), false, 'magnet mutilado não é download direto');
    // Hash curto/não-hex continua fora (não inventa torrent).
    const bad = Buffer.from('magnet:?xt=urnbtih1234').toString('base64');
    assert.equal(extract(`<body data-link="${bad}">`), null);
  });

  test('b64DataLinkIsHttp: Drive sim; magnet em base64, base64 lixo e ausência não', () => {
    assert.equal(b64DataLinkIsHttp(driveGate), true);
    const b64 = (v: string) => Buffer.from(v).toString('base64');
    assert.equal(b64DataLinkIsHttp(`<body data-link="${b64('magnet:?xt=urn:btih:' + 'a'.repeat(40))}">`), false);
    assert.equal(b64DataLinkIsHttp(`<body data-link="${'A'.repeat(40)}">`), false);
    assert.equal(b64DataLinkIsHttp('<body>sem atributo</body>'), false);
    assert.equal(b64DataLinkIsHttp(null), false);
  });
});
