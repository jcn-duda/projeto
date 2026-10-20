// Infraestrutura do harness do gate congelado do `/stream`.
//
// Fica separado de `stream-frozen.mjs` para caber no teto de 400 linhas por
// arquivo. Só imports nativos: nada de dependência nova.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const APP = fileURLToPath(new URL('../../dist/src/app.js', import.meta.url));
/** Cópia estável do build (imune a `npm test`/clean concorrente). */
export function appPath() {
  const override = String(process.env.STREAM_FROZEN_APP || '').trim();
  return override ? path.resolve(REPO, override) : APP;
}export const DEFAULT_ROOT = path.join(REPO, 'rust', 'golden', 'stream-frozen');
export const DEFAULT_CASES = path.join(REPO, 'scripts', 'golden', 'stream-frozen-cases.json');
export const PILOT = 'movie-cidade-de-deus';
export const DEFAULT_ENCODED = 'e30';
export const USER_AGENT = 'Dart/3.0 (dart:io)';

export class HarnessError extends Error {}

export function fail(message) {
  throw new HarnessError(String(message));
}

export function readJsonFile(file, label = file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    fail(`${label}: JSON inválido ou ausente (${err.message})`);
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** `id` vira nome de diretório: formato fechado, sem traversal. */
export function caseDir(root, id) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(id || ''))) {
    fail(`id de caso inválido para diretório: ${JSON.stringify(id)}`);
  }
  return path.join(root, id);
}

function indexersFromConfig(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const list = parsed?.options?.jackettIndexers;
    return Array.isArray(list) && list.length > 0 ? list.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Lista de indexers do record/replay. Sem `JACKETT_INDEXERS` o app fica com
 * `indexersAuto=true` (espera o catálogo do Jackett, que `createApp` NÃO roda)
 * e a coleta grava zero itens. Por isso a lista explícita vem do caso, do
 * piloto ou de `--indexers`.
 */
export function resolveIndexers({ indexers, dir, root }) {
  if (indexers) {
    const list = String(indexers).split(',').map((name) => name.trim()).filter(Boolean);
    if (list.length === 0) fail('--indexers veio vazio');
    return list;
  }
  return indexersFromConfig(path.join(dir, 'inputs', 'config.json'))
    ?? indexersFromConfig(path.join(root, PILOT, 'inputs', 'config.json'));
}

/** Seta TODAS as envs antes de importar `dist/src/app.js` (o módulo lê no import). */
export function prepareEnv({ mode, dir, id, indexers }) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'adom-frozen-'));
  const cacheDb = path.join(tempDir, 'cache.db');
  process.env.STREAM_FROZEN_MODE = mode;
  process.env.STREAM_FROZEN_DIR = dir;
  process.env.STREAM_FROZEN_CASE = id;
  process.env.RELEASE_INDEX = 'false';
  process.env.MAGNET_BANK = 'false';
  // CACHE_DB_PATH é CAMINHO DE ARQUIVO (src/config/cache.ts); diretório faz o
  // SQLite falhar e cair em memória.
  process.env.CACHE_DB_PATH = cacheDb;
  process.env.APP_REPLY_DEADLINE_MS = String(process.env.STREAM_FROZEN_DEADLINE_MS || '60000');
  process.env.JACKETT_TEST_TOKEN = randomBytes(16).toString('hex');
  if (indexers && indexers.length > 0) process.env.JACKETT_INDEXERS = indexers.join(',');
  return { tempDir, cacheDb, token: process.env.JACKETT_TEST_TOKEN };
}

export function cleanupTemp(tempDir) {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // SQLite pode manter o arquivo aberto no Windows; o tmp do SO limpa depois.
  }
}

export async function loadApp() {
  const app = appPath();
  if (!existsSync(app)) fail(`build ausente: ${app} (rode npm run build)`);
  const mod = await import(pathToFileURL(app).href);
  if (typeof mod.createApp !== 'function') fail(`${app} não exporta createApp()`);
  return mod.createApp().app;
}

export async function startServer(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') fail('listen(0) não devolveu porta TCP');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

export async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export async function postConfig({ base, token, encoded, timeoutMs }) {
  const res = await fetch(`${base}/internal/search/config`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Indexer-Test-Token': token,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ encoded }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) fail(`POST /internal/search/config respondeu ${res.status}: ${text.slice(0, 400)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`POST /internal/search/config não devolveu JSON: ${text.slice(0, 200)}`);
  }
  if (parsed?.ok !== true) fail(`POST /internal/search/config devolveu ok!=true: ${text.slice(0, 400)}`);
  return { text, parsed };
}

export async function getStream({ base, encoded, type, id, timeoutMs }) {
  const prefix = encoded ? `/${encoded}` : '';
  const url = `${base}${prefix}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) fail(`GET ${url} respondeu ${res.status}: ${text.slice(0, 400)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`GET ${url} não devolveu JSON: ${text.slice(0, 200)}`);
  }
  return { text, parsed, url };
}

/** Espera o arquivo existir e não estar vazio (o módulo grava ao fim do /stream). */
export async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (statSync(file).size > 0) return;
    } catch { /* ainda não existe */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  fail(`arquivo não apareceu em ${timeoutMs}ms: ${file}`);
}

/**
 * Tee do stderr: o módulo frozen loga `[frozen] collect ausente` só no replay.
 * O log continua visível; as linhas ficam disponíveis para o diagnóstico.
 */
export function captureFrozenStderr() {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string'
      ? chunk
      : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('[frozen]')) lines.push(line.trim());
    }
    return original(chunk, encoding, callback);
  };
  return {
    lines,
    restore() {
      process.stderr.write = original;
    },
  };
}
