import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { makeAppUpdateHandlers } from '../src/routes/app-updates.js';

// Atualização do app Power Movie: latest.json + instaladores, só com token.

const TOKEN = 'token-de-teste';
const LATEST = {
  version: '1.0.1',
  platforms: { 'android-armeabi-v7a': { build: 42034, file: 'pm-42034-v7a.apk', sha256: 'ab', size: 5 } },
};

async function serve(token = TOKEN, latest: unknown = LATEST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-updates-'));
  if (latest !== null) {
    fs.writeFileSync(path.join(dir, 'latest.json'), typeof latest === 'string' ? latest : JSON.stringify(latest));
  }
  fs.writeFileSync(path.join(dir, 'pm-42034-v7a.apk'), 'APK!!');
  fs.writeFileSync(path.join(dir, 'segredo.txt'), 'não sai');
  fs.writeFileSync(path.join(os.tmpdir(), 'fora.apk'), 'fora');
  const handlers = makeAppUpdateHandlers(() => ({ token, dir }));
  const app = express();
  app.get('/app/latest.json', handlers.latest);
  app.get('/app/files/:name', handlers.file);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (p: string, auth: string | null = `Bearer ${TOKEN}`) =>
    fetch(base + p, { headers: auth ? { Authorization: auth } : {} });
  return {
    get,
    close: async () => {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('latest.json sai com o token certo', async () => {
  const s = await serve();
  try {
    const res = await s.get('/app/latest.json');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), LATEST);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }
});

test('sem token, token errado ou rota desligada respondem 404', async () => {
  const s = await serve();
  try {
    assert.equal((await s.get('/app/latest.json', null)).status, 404);
    assert.equal((await s.get('/app/latest.json', 'Bearer errado')).status, 404);
    assert.equal((await s.get('/app/files/pm-42034-v7a.apk', null)).status, 404);
  } finally {
    await s.close();
  }
  const off = await serve('');
  try {
    assert.equal((await off.get('/app/latest.json', 'Bearer ')).status, 404, 'sem APP_UPDATE_TOKEN a rota fica desligada');
  } finally {
    await off.close();
  }
});

test('baixa o APK com o tipo certo', async () => {
  const s = await serve();
  try {
    const res = await s.get('/app/files/pm-42034-v7a.apk');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(await res.text(), 'APK!!');
  } finally {
    await s.close();
  }
});

test('não serve extensão fora da lista nem caminho fora do diretório', async () => {
  const s = await serve();
  try {
    assert.equal((await s.get('/app/files/segredo.txt')).status, 404);
    assert.equal((await s.get('/app/files/..%2Ffora.apk')).status, 404);
    assert.equal((await s.get('/app/files/.oculto.apk')).status, 404);
    assert.equal((await s.get('/app/files/naoexiste.apk')).status, 404);
  } finally {
    await s.close();
  }
});

test('sem latest.json publicado responde 404; JSON quebrado responde 503', async () => {
  const none = await serve(TOKEN, null);
  try {
    assert.equal((await none.get('/app/latest.json')).status, 404);
  } finally {
    await none.close();
  }
  const broken = await serve(TOKEN, '{"version": ');
  try {
    assert.equal((await broken.get('/app/latest.json')).status, 503);
  } finally {
    await broken.close();
  }
});
