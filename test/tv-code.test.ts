import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { makeTvCodeHandlers, acceptableUrl, CODE_TTL_MS } from '../src/routes/tv-code.js';

// Encurtador numérico da TV: código de 7 dígitos, 30 min, no máximo 2 usos,
// só para manifest desta instância e com teto de consulta.

async function serve(options: Parameters<typeof makeTvCodeHandlers>[0] = {}) {
  const handlers = makeTvCodeHandlers(options);
  const app = express();
  app.post('/tv-code', express.text({ type: () => true }), handlers.create);
  app.get('/tv-code/:code', handlers.lookup);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manifest = `${base}/eyJhIjoxfQ/manifest.json`;
  const create = async (body: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/tv-code`, { method: 'POST', body, headers });
    return { status: res.status, json: (await res.json()) as any };
  };
  const lookup = async (code: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/tv-code/${code}`, { headers });
    return { status: res.status, json: (await res.json()) as any };
  };
  return { base, manifest, create, lookup, close: () => new Promise((r) => server.close(r)) };
}

test('gera código de 7 dígitos e devolve a URL', async () => {
  const s = await serve();
  try {
    const created = await s.create(s.manifest);
    assert.equal(created.status, 200);
    assert.match(created.json.code, /^\d{7}$/);
    assert.equal(created.json.usesLeft, 2);
    const found = await s.lookup(created.json.code);
    assert.equal(found.status, 200);
    assert.equal(found.json.url, s.manifest);
  } finally {
    await s.close();
  }
});

test('código só vale 2 usos', async () => {
  const s = await serve();
  try {
    const { json } = await s.create(s.manifest);
    assert.equal((await s.lookup(json.code)).json.usesLeft, 1);
    assert.equal((await s.lookup(json.code)).json.usesLeft, 0);
    assert.equal((await s.lookup(json.code)).status, 404, 'terceiro uso é recusado');
    const again = await s.create(s.manifest);
    assert.notEqual(again.json.code, undefined, 'depois de gasto, o mesmo link ganha código novo');
    assert.equal(again.json.usesLeft, 2);
  } finally {
    await s.close();
  }
});

test('mesmo link dentro da validade devolve o mesmo código', async () => {
  const s = await serve();
  try {
    const a = await s.create(s.manifest);
    const b = await s.create(s.manifest);
    assert.equal(a.json.code, b.json.code);
  } finally {
    await s.close();
  }
});

test('código expira em 30 minutos', async () => {
  let clock = 1_000_000;
  const s = await serve({ now: () => clock });
  try {
    const { json } = await s.create(s.manifest);
    clock += CODE_TTL_MS + 1;
    assert.equal((await s.lookup(json.code)).status, 404);
  } finally {
    await s.close();
  }
});

test('aceita manifest de outro addon em https (legendas, Torrentio)', async () => {
  const s = await serve();
  try {
    const subs = 'https://opensubtitles-v3.strem.io/manifest.json';
    const created = await s.create(subs);
    assert.equal(created.status, 200);
    assert.equal((await s.lookup(created.json.code)).json.url, subs);
    const torrentio = 'https://torrentio.strem.fun/providers=yts|eztv/manifest.json';
    assert.equal((await s.create(torrentio)).status, 200);
    assert.equal((await s.create('https://addon.example/manifest.json?cfg=abc')).status, 200, 'query de config é aceita');
  } finally {
    await s.close();
  }
});

test('recusa o que não é manifest de addon', async () => {
  const s = await serve();
  try {
    assert.equal((await s.create('http://outro.example/x/manifest.json')).status, 400, 'outro host só em https');
    assert.equal((await s.create('https://outro.example/phishing')).status, 400);
    assert.equal((await s.create(`${s.base}/x/configure`)).status, 400);
    assert.equal((await s.create('não é url')).status, 400);
  } finally {
    await s.close();
  }
});

test('código que não é nosso é resolvido na AFTVnews', async () => {
  const calls: string[] = [];
  const s = await serve({
    aftv: {
      async resolve(code: string) {
        calls.push(code);
        if (code === '7330456') return { url: 'https://powermovie.net/abc/manifest.json' };
        if (code === '55555') throw new Error('busy');
        if (code === '66666') throw new Error('FlareSolverr HTTP 500');
        return { url: null };
      },
    },
  });
  try {
    const found = await s.lookup('7330456');
    assert.equal(found.status, 200);
    assert.equal(found.json.url, 'https://powermovie.net/abc/manifest.json');
    assert.equal(found.json.source, 'aftvnews');
    assert.equal((await s.lookup('12345')).status, 404, 'inexistente na AFTVnews');
    assert.equal((await s.lookup('55555')).status, 429, 'solver ocupado');
    assert.equal((await s.lookup('66666')).status, 502, 'falha do solver');
    assert.equal((await s.lookup('12')).status, 404, 'curto demais nem consulta');
    assert.ok(!calls.includes('12'));
  } finally {
    await s.close();
  }
});

test('código nosso válido não consulta a AFTVnews', async () => {
  let called = false;
  const s = await serve({ aftv: { async resolve() { called = true; return { url: null }; } } });
  try {
    const { json } = await s.create(s.manifest);
    assert.equal((await s.lookup(json.code)).status, 200);
    assert.equal(called, false);
  } finally {
    await s.close();
  }
});

test('teto de consulta por IP barra varredura de códigos', async () => {
  const s = await serve({ lookupPerIp: { limit: 3, windowMs: 60_000 } });
  try {
    const ip = { 'cf-connecting-ip': '203.0.113.9' };
    for (let i = 0; i < 3; i++) assert.equal((await s.lookup('1000000', ip)).status, 404);
    assert.equal((await s.lookup('1000001', ip)).status, 429);
    assert.equal((await s.lookup('1000001', { 'cf-connecting-ip': '203.0.113.10' })).status, 404,
      'outro IP segue livre');
  } finally {
    await s.close();
  }
});

test('teto global vale mesmo trocando o IP', async () => {
  const s = await serve({ lookupGlobal: { limit: 2, windowMs: 60_000 } });
  try {
    assert.equal((await s.lookup('1000000', { 'cf-connecting-ip': '1.1.1.1' })).status, 404);
    assert.equal((await s.lookup('1000000', { 'cf-connecting-ip': '2.2.2.2' })).status, 404);
    assert.equal((await s.lookup('1000000', { 'cf-connecting-ip': '3.3.3.3' })).status, 429);
  } finally {
    await s.close();
  }
});

test('acceptableUrl: regra estrita para esta instância, https para outro addon', () => {
  assert.equal(acceptableUrl('https://powermovie.net/abc/manifest.json', 'powermovie.net'),
    'https://powermovie.net/abc/manifest.json');
  assert.equal(acceptableUrl('http://powermovie.net/abc/manifest.json', 'outro.net'), null, 'de outro host, só https');
  assert.equal(acceptableUrl('https://powermovie.net/abc/manifest.json#x', 'outro.net'), null);
  assert.equal(acceptableUrl('https://powermovie.net/abc/manifest.json?x=1', 'powermovie.net'), null);
});
