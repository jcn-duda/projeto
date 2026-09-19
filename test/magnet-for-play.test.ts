// magnetForPlay (o gateway de play dos cinco adaptadores de debrid): a URI é
// lida do banco permanente (`utils/magnet-bank.ts`) e cai no `magnetFor` quando
// o banco está desligado ou não tem o hash. A URI rica (dn= + tracker do post)
// tem de chegar intacta ao corpo que o adaptador manda ao serviço.
process.env.CACHE_PERSIST = 'false';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import { magnetForPlay, magnetFor } from '../src/debrid/common.js';
import * as debridlink from '../src/debrid/debridlink.js';

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'magnet-for-play-'));
const hex = (c: string) => c.repeat(40);
const richMagnet = (h: string, dn: string) =>
  `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(dn)}&tr=${encodeURIComponent('udp://custom.tracker.org:1337/announce')}`;

function mockFetch(handler: (url: URL, init?: RequestInit) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const result = await handler(url, init);
    return {
      ok: result?.ok ?? true,
      status: result?.status ?? 200,
      json: async () => result?.body ?? result,
    };
  }) as unknown as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

beforeEach(() => {
  bank.resetForTests();
  // Engine de memória: o contrato testado é a leitura do banco, não o SQLite
  // (coberto pelos testes de magnet-bank). Evita abrir arquivo no checkout.
  bank.open(FRESH_DIR(), { forceMemory: true });
  config.magnetBank.enabled = true;
});

after(() => {
  bank.resetForTests();
  config.magnetBank.enabled = true;
});

test('magnetForPlay devolve a URI rica guardada no banco', () => {
  const h = hex('a');
  const rich = richMagnet(h, 'Filme.Teste.2024.1080p');
  bank.captureItems([{ infoHash: h, magnet: rich, title: 'Filme Teste 2024 1080p' }], 'idx', {});
  bank.flushNow();

  const stored = bank.lookup(h)?.uri;
  assert.ok(stored && stored.includes('dn='), 'pré-condição: o banco guardou a URI com dn=');
  const uri = magnetForPlay(h);
  assert.equal(uri, stored, 'play usa exatamente a URI do banco');
  assert.ok(uri.includes('custom.tracker.org'), 'tracker do post preservado');
});

test('magnetForPlay cai no magnetFor quando o hash não está no banco', () => {
  const h = hex('b');
  assert.equal(bank.lookup(h), null, 'pré-condição: hash ausente');
  assert.equal(magnetForPlay(h), magnetFor(h));
});

test('magnetForPlay cai no magnetFor com o banco desligado', () => {
  const h = hex('c');
  bank.captureItems([{ infoHash: h, magnet: richMagnet(h, 'Fora.Do.Ar') }], 'idx', {});
  bank.flushNow();
  assert.ok(bank.lookup(h), 'pré-condição: banco tinha o hash');

  config.magnetBank.enabled = false;
  bank.close();
  assert.equal(magnetForPlay(h), magnetFor(h), 'banco desligado não pinta o play');
});

test('adaptador consumidor recebe a URI rica do banco no corpo do play', async () => {
  const h = hex('d');
  const rich = richMagnet(h, 'Filme.Rico.2024.1080p');
  bank.captureItems([{ infoHash: h, magnet: rich, title: 'Filme Rico 2024 1080p' }], 'idx', {});
  bank.flushNow();
  const stored = bank.lookup(h)?.uri;
  assert.ok(stored, 'pré-condição: banco com URI');

  let sent = '';
  const restore = mockFetch((url, init) => {
    if (url.pathname === '/api/v2/seedbox/add') {
      sent = String((init?.body as URLSearchParams).get('url') || '');
      return {
        success: true,
        value: {
          id: 'dl-1',
          downloadPercent: 100,
          files: [{ name: 'Filme.Rico.2024.1080p.mkv', size: 8_000_000_000, downloadUrl: 'https://dl.test/f.mkv' }],
        },
      };
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  });
  try {
    const link = await debridlink.resolveLink('test-key', h);
    assert.equal(link, 'https://dl.test/f.mkv');
  } finally {
    restore();
  }
  assert.equal(sent, stored, 'o adaptador manda exatamente a URI rica do banco');
  assert.ok(sent.includes('custom.tracker.org'), 'o tracker do post chega ao debrid');
});
