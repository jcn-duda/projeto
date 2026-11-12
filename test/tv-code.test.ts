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

test('recusa link de outro host ou que não é manifest', async () => {
  const s = await serve();
  try {
    assert.equal((await s.create('https://evil.example/x/manifest.json')).status, 400);
    assert.equal((await s.create(`${s.base}/x/configure`)).status, 400);
    assert.equal((await s.create('não é url')).status, 400);
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

test('acceptableUrl exige o host da requisição', () => {
  assert.equal(acceptableUrl('https://powermovie.net/abc/manifest.json', 'powermovie.net'),
    'https://powermovie.net/abc/manifest.json');
  assert.equal(acceptableUrl('https://powermovie.net/abc/manifest.json', 'outro.net'), null);
  assert.equal(acceptableUrl('https://powermovie.net/abc/manifest.json?x=1', 'powermovie.net'), null);
});
