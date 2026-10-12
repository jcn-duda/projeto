#!/usr/bin/env node
/**
 * Golden do contrato de config por usuário: segmento base64url da URL + selo
 * AES da `dk` (porte Rust de `runtime.ts`/`secret-box.ts`).
 *
 * Geração (`node scripts/golden/dump-config-encoding.mjs`): roda o corpus
 * contra o `dist` REAL e grava `rust/golden/config-encoding.jsonl` + manifest
 * (determinístico, sem timestamp). `--check`: só leitura; falha se faltar,
 * estiver vazio ou divergir.
 *
 * ISOLAMENTO: importar `dist/src/runtime.js` arrasta config -> autofetch-live ->
 * cache (que abre data/cache.db no LOAD). Por isso o CWD vai para TEMP, o
 * dotenv aponta para um arquivo vazio e `CACHE_PERSIST=false`. O golden grava os
 * `defaults` efetivos de cada caso de `decode`, então o porte Rust recebe os
 * MESMOS defaults por parâmetro — nada do `.env` do operador entra no corpus.
 *
 * NONCE: `secretBox.seal` usa `randomBytes(12)`, que não é reproduzível. Para o
 * `--check` ser determinístico, os casos de SELO gravam um blob feito com a
 * MESMA primitiva do secret-box (aes-256-gcm + scryptSync + layout iv||tag||ct)
 * e um nonce fixo do corpus. O gerador continua exercendo o caminho real:
 * `secretBox.open` tem que abrir o blob gravado de volta ao texto claro, e o
 * `runtime.sealSegment` real tem que produzir um segmento que abre com a mesma
 * chave. Os blobs de ENTRADA de `open` são selos reais do Node (IV aleatório),
 * congelados no corpus — é o que prova a interoperabilidade byte a byte.
 */

import { createHash, createCipheriv, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_FORMAT = 'adom-golden-manifest/1';
const CORPUS = 'scripts/golden/corpus-config-encoding.json';
const OUT_JSONL = 'rust/golden/config-encoding.jsonl';
const OUT_MANIFEST = 'rust/golden/config-encoding.manifest.json';
const FUNCOES = [
  { id: 'config-encoding/encode', name: 'encode', source: 'src/runtime.ts', artifact: 'dist/src/runtime.js' },
  { id: 'config-encoding/normalize', name: 'normalize', source: 'src/runtime.ts', artifact: 'dist/src/runtime.js' },
  { id: 'config-encoding/decode', name: 'decode', source: 'src/runtime.ts', artifact: 'dist/src/runtime.js' },
  { id: 'config-encoding/sealSegment', name: 'sealSegment', source: 'src/runtime.ts', artifact: 'dist/src/runtime.js' },
  { id: 'config-encoding/seal', name: 'seal', source: 'src/utils/secret-box.ts', artifact: 'dist/src/utils/secret-box.js' },
  { id: 'config-encoding/open', name: 'open', source: 'src/utils/secret-box.ts', artifact: 'dist/src/utils/secret-box.js' },
  { id: 'config-encoding/isSealed', name: 'isSealed', source: 'src/utils/secret-box.ts', artifact: 'dist/src/utils/secret-box.js' },
];
// Qualquer uma destas no shell do operador contaminaria os `defaults` gravados.
const ENV_PROIBIDA = ['RESOLVE_SECRET', 'DEBRID_API_KEY', 'DEBRID_SERVICE', 'PROVIDER', 'QUALITY_FILTER', 'MAX_RESULTS', 'MIN_SEEDERS', 'JACKETT_INDEXERS', 'TORRENTIO_ENABLED', 'DEBRID_ALLOW_ENV_KEY'];
const PREFIX = 'enc.v1.';
const DK_KEY = 'dk'; // SCHEMA.debridApiKey.key no runtime
const STRING_MAX_CHARS = 200; // sealSegment corta o dk em 200, nao em 400
const SALT = Buffer.from('stremio-adom/dk/v1', 'utf8');

class GoldenError extends Error {}
const fail = (msg) => { throw new GoldenError(String(msg)); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');
const fileSha = (rel) => sha256(fs.readFileSync(path.join(REPO, rel)));

function parseArgs(argv) {
  const args = { check: false, force: false };
  for (const a of argv) {
    if (a === '--check') args.check = true;
    else if (a === '--force') args.force = true;
    else fail(`flag desconhecida: ${a}`);
  }
  return args;
}

/** Selo determinístico com as primitivas EXATAS do secret-box. */
function sealComNonce(plaintext, secret, nonceHex) {
  if (!secret || !plaintext || plaintext.startsWith(PREFIX)) return plaintext;
  const iv = Buffer.from(nonceHex, 'hex');
  if (iv.length !== 12) fail('nonce do corpus precisa ter 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', scryptSync(secret, SALT, 32), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** `encode` do runtime, com o `dk` opcionalmente selado (casos de decode). */
function segmentoPara(c, runtime, secretBox, secret) {
  if (typeof c.segmentoCru === 'string') return c.segmentoCru;
  if (c.raw === undefined) fail(`${c.id}: sem "raw" nem "segmentoCru"`);
  const raw = structuredClone(c.raw);
  if (typeof raw.dk === 'string' && c.repetirDk) raw.dk = raw.dk.repeat(c.repetirDk);
  if (c.selarAntes) {
    if (raw.dk !== undefined) raw.dk = sealComNonce(String(raw.dk), c.selarCom ?? secret, '00112233445566778899aabb');
  }
  return runtime.encode(raw);
}

async function loadOracle() {
  const url = (rel) => pathToFileURL(path.join(REPO, rel)).href;
  const runtime = await import(url('dist/src/runtime.js'));
  const secretBox = await import(url('dist/src/utils/secret-box.js'));
  const config = (await import(url('dist/src/config.js'))).default;
  return { runtime, secretBox, config };
}

function computeRow(c, oracle) {
  const { runtime, secretBox, config } = oracle;
  const secret = c.secret ?? '';
  if (typeof secret !== 'string') fail(`${c.id}: "secret" precisa ser string`);
  config.debrid.resolveSecret = secret; // o mesmo truque do test/secret-box.test.ts
  switch (c.op) {
    case 'encode':
      return { id: c.id, op: 'encode', raw: c.raw, expected: runtime.encode(c.raw) };
    case 'decode': {
      const segment = segmentoPara(c, runtime, secretBox, secret);
      const expected = runtime.decode(segment);
      // O porte Rust recebe os defaults por parâmetro: grava os efetivos.
      return { id: c.id, op: 'decode', segment, secret, defaults: runtime.defaults(), expected: expected ?? null };
    }
    case 'sealSegment': {
      const segment = segmentoPara(c, runtime, secretBox, secret);
      const esperado = runtime.sealSegment(segment);
      if (esperado === null) return { id: c.id, op: 'sealSegment', segment, secret, nonce: c.nonce, expected: null };
      // Contrato (runtime.ts:224): sem `dk` (P2P puro) ou já selado => devolve cru.
      const cru = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
      const dkCru = cru[DK_KEY];
      if (!dkCru || secretBox.isSealed(String(dkCru))) {
        if (esperado !== segment) fail(`${c.id}: deveria devolver o segmento cru`);
        return { id: c.id, op: 'sealSegment', segment, secret, nonce: c.nonce, expected: segment };
      }
      // O caminho real usa IV aleatório: ele precisa abrir de volta o texto claro.
      const texto = String(dkCru).slice(0, STRING_MAX_CHARS);
      const selado = JSON.parse(Buffer.from(esperado, 'base64url').toString('utf8'));
      // Com secret vazio o `seal` é identidade, e `open` de texto puro também é.
      if (secretBox.open(selado[DK_KEY]) !== texto) {
        fail(`${c.id}: o sealSegment real não abriu de volta o texto claro`);
      }
      const deterministico = { ...cru, [DK_KEY]: sealComNonce(texto, secret, c.nonce) };
      return { id: c.id, op: 'sealSegment', segment, secret, nonce: c.nonce, expected: runtime.encode(deterministico) };
    }
    case 'seal':
      return { id: c.id, op: 'seal', plaintext: c.plaintext, secret, nonce: c.nonce, expected: sealComNonce(c.plaintext, secret, c.nonce) };
    case 'open': {
      const sealed = typeof c.sealed === 'string' && c.sealed.startsWith('blobs.')
        ? oracle.blobs[c.sealed.slice('blobs.'.length)]
        : c.sealed;
      if (!sealed) fail(`${c.id}: blob do corpus ausente (${c.sealed})`);
      return { id: c.id, op: 'open', sealed, secret, expected: secretBox.open(sealed) };
    }
    case 'key':
      return { id: c.id, op: 'key', secret, expected: scryptSync(secret, SALT, 32).toString('hex') };
    default:
      return fail(`${c.id}: op desconhecido ${c.op}`);
  }
}

function loadCorpus() {
  const bruto = fs.readFileSync(path.join(REPO, CORPUS));
  const corpus = JSON.parse(bruto.toString('utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(corpus.cases) || !corpus.cases.length) fail('corpus vazio ou sem "cases"');
  const vistos = new Set();
  for (const c of corpus.cases) {
    if (!c?.id || vistos.has(c.id)) fail(`id ausente ou duplicado: ${c.id}`);
    vistos.add(c.id);
    if (!c.op) fail(`${c.id}: sem "op"`);
  }
  return { sha: sha256(bruto), ...corpus };
}

function computeJsonl(corpus) {
  const oracle = { ...corpus, ...(require_oracle()) };
  const linhas = corpus.cases.map((c) => JSON.stringify(computeRow(c, oracle)));
  return Buffer.from(`${linhas.join('\n')}\n`, 'utf8');
}

// O oráculo é assíncrono (import dinâmico) — guardado aqui para os helpers
// permanecerem síncronos como nos outros geradores do diretório.
let ORACLE = null;
function require_oracle() { return ORACLE; }

function buildManifest(corpus, jsonl) {
  return {
    format: MANIFEST_FORMAT,
    registry: FUNCOES.map((f) => f.id),
    functions: FUNCOES.map((f) => ({
      id: f.id, name: f.name,
      sourcePath: toPosix(f.source), sourceSha256: fileSha(f.source),
      // Provenance apenas: rebuild alheio muda o hash sem mudar comportamento.
      artifactPath: toPosix(f.artifact), artifactSha256: fileSha(f.artifact),
    })),
    corpus: { path: toPosix(CORPUS), sha256: corpus.sha, cases: corpus.cases.length },
    output: { path: toPosix(OUT_JSONL), sha256: sha256(jsonl), lines: corpus.cases.length },
    notes: 'seal/sealSegment gravam blob com nonce fixo (as primitivas do secret-box); os blobs de entrada de open são selos reais do Node com IV aleatório.',
    node: { major: Number(process.versions.node.split('.')[0]), version: process.version },
    git: { revision: gitRevision() },
  };
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim() || null;
  } catch {
    return null; // provenance: ausência de git não pode bloquear
  }
}

function readJsonlIfExists() {
  try {
    return fs.readFileSync(path.join(REPO, OUT_JSONL));
  } catch {
    return null;
  }
}

function check(corpus, jsonl) {
  const manifestPath = path.join(REPO, OUT_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    fail(`manifest ausente ou ilegível: ${OUT_MANIFEST}`);
  }
  if (manifest.format !== MANIFEST_FORMAT) fail(`formato de manifest desconhecido: ${manifest.format}`);
  const committed = readJsonlIfExists();
  if (!committed) fail(`golden ausente: ${OUT_JSONL}`);
  if (!committed.toString('utf8').trim()) fail('golden vazio: nunca aceitar saída zero-linhas');
  if (manifest.output?.sha256 !== sha256(committed)) fail('golden divergiu do manifest (arquivo alterado fora do gerador)');
  if (!committed.equals(jsonl)) fail('comportamento do dist divergiu do golden (comparação caso a caso falhou)');
  if (manifest.corpus?.sha256 !== corpus.sha) fail('corpus mudou desde a geração (hash diverge do manifest)');
  const linhas = committed.toString('utf8').trimEnd().split('\n');
  if (linhas.length !== corpus.cases.length || manifest.output?.lines !== corpus.cases.length) {
    fail(`contagem de linhas diverge: golden=${linhas.length} corpus=${corpus.cases.length}`);
  }
  console.log(`[golden] OK: ${toPosix(OUT_JSONL)} (${linhas.length} casos batem com o dist vivo)`);
}

function generate(corpus, jsonl, force) {
  const existente = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(REPO, OUT_MANIFEST), 'utf8'));
    } catch {
      return null;
    }
  })();
  const fonte = fileSha('src/runtime.ts');
  if (existente && !force && existente.functions?.[0]?.sourceSha256 !== fonte) {
    fail('fonte mudou desde a última geração; regenere com --force');
  }
  fs.writeFileSync(path.join(REPO, OUT_JSONL), jsonl);
  const manifest = buildManifest(corpus, jsonl);
  fs.writeFileSync(
    path.join(REPO, OUT_MANIFEST),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
  console.log(`[golden] gerado: ${toPosix(OUT_JSONL)} (${corpus.cases.length} linhas)`);
  console.log(`[golden] manifest: ${toPosix(OUT_MANIFEST)} output=${manifest.output.sha256.slice(0, 12)}…`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ENV_PROIBIDA) {
    if (process.env[key] !== undefined) fail(`variável ${key} está no ambiente e contaminaria os defaults; desampere-a`);
  }
  const dist = path.join(REPO, 'dist/src/runtime.js');
  if (!fs.existsSync(dist)) fail(`oráculo ausente: rode npm run build antes (${toPosix('dist/src/runtime.js')})`);
  if (fs.statSync(dist).mtimeMs < fs.statSync(path.join(REPO, 'src/runtime.ts')).mtimeMs) {
    fail(`dist defasado; rode npm run build`);
  }
  const corpus = loadCorpus();

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-config-'));
  const dotenvVazio = path.join(temp, 'empty-dotenv');
  fs.writeFileSync(dotenvVazio, '');
  process.env.DOTENV_CONFIG_PATH = dotenvVazio;
  process.env.CACHE_PERSIST = 'false';
  process.env.ADDON_LOG_LEVEL = 'silent';
  process.chdir(temp); // data/cache.db nasce no TEMP, nunca no repo
  try {
    ORACLE = await loadOracle();
    ORACLE.blobs = corpus.blobs;
    const jsonl = computeJsonl(corpus);
    if (args.check) check(corpus, jsonl);
    else generate(corpus, jsonl, args.force);
  } finally {
    // Windows recusa remover o diretório que é o CWD; e um erro aqui dentro
    // mascararia a falha real do try. Volta ao repo e nunca propaga a limpeza.
    try {
      process.chdir(REPO);
      fs.rmSync(temp, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(`[golden] aviso: limpeza do TEMP falhou: ${cleanupError?.message || cleanupError}`);
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(`[golden] FALHA: ${e instanceof GoldenError ? e.message : e?.stack || e?.message || String(e)}`);
  process.exit(1);
}
