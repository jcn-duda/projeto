/**
 * F4.6 — defaults do corte da AllDebrid e sobrevivência das rotas vizinhas.
 *
 * O que se prova aqui:
 * 1. os DEFAULTS do corte no `docker-compose.yml` (e no override de
 *    diagnóstico/rollback): `DEBRID_AL_RUST`/`DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP`
 *    nascem `on`, com `${...:-on}` para o `off` no `.env` ser o rollback;
 * 2. a rota `/internal/debrid/check` responde **410** com a nativa ligada e
 *    continua VIVA com `off` (é o rollback de uma linha);
 * 3. `/stream` e `/resolve` seguem montados com o mesmo contrato (`/stream`
 *    aposentado 503/410; `/resolve` recusa hash malformado com 400).
 *
 * Sem rede: a rota 410 sai antes de qualquer adaptador e o `/resolve` recusa o
 * hash antes do debrid. O caminho `off` é exercitado com corpo inválido (400),
 * que só acontece se o handler rodou.
 */
import './setup-env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'tok-cut-al';

/** Lê um arquivo do repo como texto (o teste de defaults não pode depender do cwd). */
const readRoot = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Valor de uma env no bloco `environment:` do compose, com o `:-default`. */
function composeDefault(text: string, name: string): string | null {
  const match = text.match(new RegExp(`^\\s*${name}:\\s*"\\$\\{${name}:-([^}]*)\\}"\\s*$`, 'm'));
  return match ? match[1] : null;
}

let server: any;
const saved: Record<string, string> = {};
let savedToken = '';
let savedAlRust: string | undefined;

const restoreAlRust = () => {
  if (savedAlRust === undefined) delete process.env.DEBRID_AL_RUST;
  else process.env.DEBRID_AL_RUST = savedAlRust;
};

/** Roda o corpo com a flag no modo pedido e restaura o ambiente no finally. */
async function withAlRust(mode: string, fn: () => Promise<void>) {
  process.env.DEBRID_AL_RUST = mode;
  try {
    await fn();
  } finally {
    restoreAlRust();
  }
}

before(async () => {
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.resolveSecret = config.debrid.resolveSecret;
  saved.publicUrl = config.debrid.publicUrl;
  savedToken = config.jackett.testToken;
  // Ambiente neutro: a instalação do teste não herda debrid/host do operador.
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.debrid.publicUrl = 'https://addon.teste';
  config.jackett.testToken = TOKEN;
  savedAlRust = process.env.DEBRID_AL_RUST;
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.debrid.service = saved.debridService!;
  config.debrid.apiKey = saved.debridApiKey!;
  config.debrid.resolveSecret = saved.resolveSecret!;
  config.debrid.publicUrl = saved.publicUrl!;
  config.jackett.testToken = savedToken;
  restoreAlRust();
});

const postCheck = (body: unknown = {}) => server.request('POST', '/internal/debrid/check', {
  headers: { 'X-Indexer-Test-Token': TOKEN },
  body,
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Defaults do corte (docker-compose.yml + override de diagnóstico)
// ═══════════════════════════════════════════════════════════════════════════════

test('docker-compose.yml: as três flags da AllDebrid nascem ON e o off do .env é o rollback', () => {
  const compose = readRoot('docker-compose.yml');
  assert.equal(composeDefault(compose, 'DEBRID_AL_RUST'), 'on');
  assert.equal(composeDefault(compose, 'DEBRID_AL_HOLDS'), 'on');
  assert.equal(composeDefault(compose, 'DEBRID_AL_CLEANUP'), 'on');
  // O gateway é o dono do /stream (F4.4) e continua assim.
  assert.equal(composeDefault(compose, 'GATEWAY'), 'on');
  assert.equal(composeDefault(compose, 'ROUTES_RUST'), 'stream');
});

test('docker-compose.gateway.yml: override repete os defaults e documenta o rollback por env', () => {
  const compose = readRoot('docker-compose.gateway.yml');
  assert.equal(composeDefault(compose, 'DEBRID_AL_RUST'), 'on');
  assert.equal(composeDefault(compose, 'DEBRID_AL_HOLDS'), 'on');
  assert.equal(composeDefault(compose, 'DEBRID_AL_CLEANUP'), 'on');
  assert.match(compose, /DEBRID_AL_RUST=off/);
});

test('.env.example documenta o default do corte e o rollback de uma linha', () => {
  const example = readRoot('.env.example');
  assert.match(example, /^# DEBRID_AL_RUST=on$/m);
  assert.match(example, /^# DEBRID_AL_HOLDS=on$/m);
  assert.match(example, /^# DEBRID_AL_CLEANUP=on$/m);
  assert.match(example, /Rollback: DEBRID_AL_RUST=off/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. A rota da reserva: 410 no corte, viva no rollback
// ═══════════════════════════════════════════════════════════════════════════════

test('DEBRID_AL_RUST=on: /internal/debrid/check responde 410 e aponta o rollback', async () => {
  await withAlRust('on', async () => {
    const res = await postCheck();
    assert.equal(res.status, 410);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.retired, true);
    assert.match(String(res.json.error), /DEBRID_AL_RUST=off/);
  });
});

test('DEBRID_AL_RUST=off: a rota volta a rodar (rollback de uma linha) — 400 de corpo inválido', async () => {
  await withAlRust('off', async () => {
    const res = await postCheck({});
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /encoded/);
  });
});

test('DEBRID_AL_RUST=shadow: a rota segue viva (Node é a REFERÊNCIA da sombra)', async () => {
  await withAlRust('shadow', async () => {
    const res = await postCheck({});
    assert.equal(res.status, 400);
  });
});

test('sem token a guarda vence o 410 (401, nunca 410)', async () => {
  await withAlRust('on', async () => {
    const res = await server.request('POST', '/internal/debrid/check', { body: {} });
    assert.equal(res.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. O corte não toca /stream nem /resolve
// ═══════════════════════════════════════════════════════════════════════════════

test('/manifest.json continua respondendo com a nativa ligada', async () => {
  await withAlRust('on', async () => {
    const res = await server.request('GET', '/manifest.json');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.resources, ['stream']);
  });
});

test('/stream do Node segue APOSENTADO (503/410), nunca lista vazia', async () => {
  await withAlRust('on', async () => {
    // A suíte roda sem GATEWAY/ROUTES_RUST: o contrato é 503. Com o gateway,
    // 410 (coberto em app-routes.test.ts); o que importa aqui é NÃO ser 200.
    const res = await server.request('GET', '/stream/movie/tt1254207.json');
    assert.equal(res.status, 503);
    assert.ok(res.json.err);
  });
});

test('/resolve segue montado: hash malformado → 400 (antes de debrid/assinatura)', async () => {
  await withAlRust('on', async () => {
    const res = await server.request('GET', '/resolve/nao-eh-hash');
    assert.equal(res.status, 400);
    assert.match(res.text, /hash/i);
  });
});
