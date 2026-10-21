/**
 * F4.6/R3 — defaults do corte da AllDebrid e sobrevivência das rotas vizinhas.
 *
 * O que se prova aqui:
 * 1. os DEFAULTS dos dois kill-switches que ficam no `docker-compose.yml` (e no
 *    override de diagnóstico): `DEBRID_AL_HOLDS`/`DEBRID_AL_CLEANUP` nascem
 *    `on`, com `${...:-on}` para o `off` no `.env` ser o kill-switch;
 * 2. `/stream` e `/resolve` seguem montados com o mesmo contrato (`/stream`
 *    aposentado 503/410; `/resolve` recusa hash malformado com 400).
 *
 * A checagem nativa da AllDebrid é incondicional desde a R3: a rota Node da
 * checagem e a flag de rollback não existem mais.
 *
 * Sem rede: o `/resolve` recusa o hash antes do debrid e o `/stream` do Node
 * responde 503 sem GATEWAY/ROUTES_RUST.
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

/** Lê um arquivo do repo como texto (o teste de defaults não pode depender do cwd). */
const readRoot = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** Valor de uma env no bloco `environment:` do compose, com o `:-default`. */
function composeDefault(text: string, name: string): string | null {
  const match = text.match(new RegExp(`^\\s*${name}:\\s*"\\$\\{${name}:-([^}]*)\\}"\\s*$`, 'm'));
  return match ? match[1] : null;
}

let server: any;
const saved: Record<string, string> = {};

before(async () => {
  saved.debridService = config.debrid.service;
  saved.debridApiKey = config.debrid.apiKey;
  saved.debridResolveSecret = config.debrid.resolveSecret;
  saved.debridPublicUrl = config.debrid.publicUrl;
  // Ambiente neutro: a instalação do teste não herda debrid/host do operador.
  config.debrid.service = '';
  config.debrid.apiKey = '';
  config.debrid.resolveSecret = '';
  config.debrid.publicUrl = 'https://addon.teste';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.debrid.service = saved.debridService!;
  config.debrid.apiKey = saved.debridApiKey!;
  config.debrid.resolveSecret = saved.debridResolveSecret!;
  config.debrid.publicUrl = saved.debridPublicUrl!;
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Defaults do corte (docker-compose.yml + override de diagnóstico)
// ═══════════════════════════════════════════════════════════════════════════════

test('docker-compose.yml: os kill-switches da AllDebrid nascem ON e o off do .env é o rollback', () => {
  const compose = readRoot('docker-compose.yml');
  assert.equal(composeDefault(compose, 'DEBRID_AL_HOLDS'), 'on');
  assert.equal(composeDefault(compose, 'DEBRID_AL_CLEANUP'), 'on');
  // O gateway é o dono do /stream (F4.4) e continua assim.
  assert.equal(composeDefault(compose, 'GATEWAY'), 'on');
  assert.equal(composeDefault(compose, 'ROUTES_RUST'), 'stream');
});

test('docker-compose.gateway.yml: override repete os defaults dos kill-switches', () => {
  const compose = readRoot('docker-compose.gateway.yml');
  assert.equal(composeDefault(compose, 'DEBRID_AL_HOLDS'), 'on');
  assert.equal(composeDefault(compose, 'DEBRID_AL_CLEANUP'), 'on');
});

test('.env.example documenta o default dos kill-switches', () => {
  const example = readRoot('.env.example');
  assert.match(example, /^# DEBRID_AL_HOLDS=on$/m);
  assert.match(example, /^# DEBRID_AL_CLEANUP=on$/m);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. O corte não toca /stream nem /resolve
// ═══════════════════════════════════════════════════════════════════════════════

test('/manifest.json continua respondendo', async () => {
  const res = await server.request('GET', '/manifest.json');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.resources, ['stream']);
});

test('/stream do Node segue APOSENTADO (503/410), nunca lista vazia', async () => {
  // A suíte roda sem GATEWAY/ROUTES_RUST: o contrato é 503. Com o gateway,
  // 410 (coberto em app-routes.test.ts); o que importa aqui é NÃO ser 200.
  const res = await server.request('GET', '/stream/movie/tt1254207.json');
  assert.equal(res.status, 503);
  assert.ok(res.json.err);
});

test('/resolve segue montado: hash malformado → 400 (antes de debrid/assinatura)', async () => {
  const res = await server.request('GET', '/resolve/nao-eh-hash');
  assert.equal(res.status, 400);
  assert.match(res.text, /hash/i);
});
