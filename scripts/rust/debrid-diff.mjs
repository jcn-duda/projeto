#!/usr/bin/env node
/**
 * Harness de diferença do debrid: saída e sequência HTTP (método, rota, corpo).
 *
 * Fase D0 entrega o comparador. O conjunto PORTED segue vazio: o lado Rust
 * não entra aqui (exigiria cargo). `--service` recusa em vez de fingir
 * paridade. `--capture=ts` só descreve o que o TypeScript pediu ao servidor
 * falso, e sai 0 sem comparar com o Rust.
 *
 *   node scripts/rust/debrid-diff.mjs --self-test
 *   node scripts/rust/debrid-diff.mjs --service=premiumize
 *   node scripts/rust/debrid-diff.mjs --capture=ts --service=premiumize
 */
import http from 'node:http';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    service: { type: 'string' },
    capture: { type: 'string' },
    'self-test': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

/** Vazio de propósito: paridade só com diff zero, e o Rust ainda não corre aqui. */
const PORTED = new Set();
const CAPTURE_TS = new Set(['premiumize', 'debridlink']);
const PROBE_KEY = 'probe-key';
const PROBE_HASH = 'a'.repeat(40);

if (values.help) {
  console.log(`Uso:
  node scripts/rust/debrid-diff.mjs --self-test
  node scripts/rust/debrid-diff.mjs --service=<premiumize|debridlink|torbox|realdebrid|alldebrid>
  node scripts/rust/debrid-diff.mjs --capture=ts --service=<premiumize|debridlink>`);
  process.exit(0);
}

export function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

/** Compara a sequência de chamadas. Corpo entra na igualdade: escrita igual é o critério. */
export function diffCalls(left, right) {
  const diffs = [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) {
      diffs.push({ i, reason: 'tamanho' });
      continue;
    }
    if (a.method !== b.method || a.path !== b.path || stable(a.body) !== stable(b.body)) {
      diffs.push({ i, reason: 'chamada', left: a, right: b });
    }
  }
  return diffs;
}

function selfTest() {
  const same = diffCalls(
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['aa'] } }],
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['aa'] } }],
  );
  if (same.length !== 0) {
    console.error('[debrid-diff] comparador aceitou diferença inexistente');
    process.exit(1);
  }
  const changed = diffCalls(
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['aa'] } }],
    [{ method: 'POST', path: '/magnet/upload', body: { magnets: ['bb'] } }],
  );
  if (changed.length !== 1) {
    console.error('[debrid-diff] comparador não viu corpo diferente');
    process.exit(1);
  }
  console.log('rust.debrid.diff.self_test=0');
}

/** Corpo de formulário estável, sem magnet nem chave. `src`/`url` viram o token `magnet`. */
function redactBody(raw) {
  if (!raw) return null;
  if (/magnet:|btih:|apikey/i.test(raw) && !raw.includes('=')) return { redacted: true };
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [key, value] of params) {
    obj[key] = key === 'src' || key === 'url' || /magnet:|btih:|urn:/i.test(value) ? 'magnet' : value;
  }
  if (Object.keys(obj).length === 0) return { redacted: true };
  return obj;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

function replyFor(pathname) {
  if (pathname === '/cache/check') {
    return { status: 'success', response: [false], filesize: [0] };
  }
  if (pathname === '/transfer/directdl') {
    return { status: 'success', content: [{ path: 'clip.mkv', link: 'http://127.0.0.1/clip' }] };
  }
  if (pathname === '/seedbox/add' || pathname === '/seedbox/list') {
    const value = {
      id: 'probe',
      downloadPercent: 100,
      files: [{ name: 'clip.mkv', downloadUrl: 'http://127.0.0.1/clip' }],
    };
    return pathname === '/seedbox/list'
      ? { success: true, value: [value] }
      : { success: true, value };
  }
  return null;
}

function listenFake() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const raw = await readRaw(req);
    calls.push({ method: req.method || 'GET', path: pathname, body: redactBody(raw) });
    const payload = replyFor(pathname);
    if (!payload) {
      res.writeHead(404);
      res.end();
      return;
    }
    sendJson(res, payload);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('servidor falso sem porta'));
        return;
      }
      resolve({ server, calls, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

function silenceSideEffects() {
  process.env.CACHE_PERSIST = 'false';
  process.env.MAGNET_DB = 'false';
  process.env.MAGNET_BANK = 'false';
  process.env.NOTIFY_ENABLED = 'false';
  process.env.NOTIFY_WEBHOOK_URL = '';
  process.env.CRAWL_ENABLED = 'false';
  process.env.RELEASE_INDEX = 'false';
  process.env.ADDON_LOG_LEVEL = 'silent';
  process.env.AUDIO_AUDIT = 'false';
  process.env.HARVEST_ENABLED = 'false';
  process.env.WARMUP_ENABLED = 'false';
}

function guardLocalFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.hostname !== '127.0.0.1') {
      throw new Error('harness recusou host fora de 127.0.0.1');
    }
    return real(input, init);
  };
  return () => { globalThis.fetch = real; };
}

async function captureTs(service) {
  silenceSideEffects();
  const fake = await listenFake();
  process.env.PREMIUMIZE_API_BASE = fake.base;
  process.env.DEBRIDLINK_API_BASE = fake.base;
  const restoreFetch = guardLocalFetch();
  try {
    const file = service === 'premiumize' ? 'premiumize.js' : 'debridlink.js';
    const dist = new URL(`../../dist/src/debrid/${file}`, import.meta.url);
    if (!fs.existsSync(dist)) {
      console.error('[debrid-diff] dist ausente; compile antes de --capture=ts');
      return 1;
    }
    const mod = await import(dist);
    // resolveLink (e o checkCached do Debrid-Link) saíram de src/: o corpo TS
    // compilado mora no oráculo de teste. Premiumize mantém o checkCached em src.
    const { bodiesFor } = await import(new URL('../../dist/test/helpers/pipeline-oracle/debrid-bodies/index.js', import.meta.url));
    const body = { ...mod, ...bodiesFor(service) };
    try { await body.checkCached(PROBE_KEY, [PROBE_HASH]); } catch { /* a sequência é o que chegou no fio */ }
    try { await body.resolveLink(PROBE_KEY, PROBE_HASH); } catch { /* idem */ }
  } finally {
    restoreFetch();
    await new Promise((resolve) => fake.server.close(resolve));
  }
  const lines = fake.calls.map((call) => `${call.method} ${call.path} ${stable(call.body)}`);
  const text = lines.join('\n');
  if (/apikey|magnet:|btih|probe-key|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/i.test(text)) {
    console.error('[debrid-diff] sequência vazou chave ou magnet; nada impresso');
    return 1;
  }
  const expected = service === 'premiumize'
    ? ['GET /cache/check', 'POST /transfer/directdl']
    : ['POST /seedbox/add'];
  const missing = expected.filter((needle) => !lines.some((line) => line.startsWith(needle)));
  if (missing.length > 0) {
    console.error(`[debrid-diff] sequência TS incompleta (${missing.length} chamada(s) ausente(s))`);
    return 1;
  }
  console.log(`rust.debrid.diff.capture=ts service=${service}`);
  for (const line of lines) console.log(line);
  return 0;
}

if (values.capture != null && values.capture !== 'ts') {
  console.error('[debrid-diff] --capture só aceita ts');
  process.exit(2);
}

if (values['self-test']) {
  selfTest();
  process.exit(0);
}

const service = values.service;
if (values.capture === 'ts') {
  if (!CAPTURE_TS.has(service)) {
    console.error(service
      ? `[debrid-diff] ${service}: adaptador Rust ainda não portado; sem medição de paridade`
      : '[debrid-diff] use --self-test ou --service=<id>');
    process.exit(2);
  }
  try {
    process.exit(await captureTs(service));
  } catch {
    console.error('[debrid-diff] captura TS falhou sem rede');
    process.exit(1);
  }
}

if (!service) {
  console.error('[debrid-diff] use --self-test ou --service=<id>');
  process.exit(2);
}
if (!PORTED.has(service)) {
  console.error(`[debrid-diff] ${service}: adaptador Rust ainda não portado; sem medição de paridade`);
  process.exit(2);
}
