// Infraestrutura de arquivos/máscara do gate congelado do `/stream`.
//
// Extraído de `stream-frozen.ts` pela catraca de linhas (teto 400): aqui fica
// só o I/O do corpus (caminhos, leitura/escrita, máscara, manifesto). A API
// pública de record/replay e os "around*" continuam no módulo irmão.
//
// Segurança: o segmento de config NUNCA é gravado (só o sha256); `sig` vira
// `{{sig}}`, a origem vira `{{base}}` e campos internos `_*` são removidos.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as runtime from '../runtime.js';

export type FrozenMode = 'off' | 'record' | 'replay' | 'shadow';

const RAW_MODE = String(process.env.STREAM_FROZEN_MODE || 'off').trim().toLowerCase();
export const MODE: FrozenMode = RAW_MODE === 'record' || RAW_MODE === 'replay' || RAW_MODE === 'shadow'
  ? RAW_MODE
  : 'off';
export const DIR = String(process.env.STREAM_FROZEN_DIR || '').trim();
/**
 * Base do modo shadow: cada `/stream` grava em `<base>/<X-Adom-Shadow-Id>`.
 * O gateway manda o id no header; sem ele (ou sem base) a requisição não grava.
 */
export const SHADOW_BASE = String(process.env.STREAM_FROZEN_SHADOW_BASE || '').trim();
export const CASE_ID = String(process.env.STREAM_FROZEN_CASE || '').trim();

export const FILES = {
  request: 'request.json',
  meta: 'meta.json',
  index: 'index.json',
  collect: 'collect.json',
  fallback: 'fallback.json',
  debrid: 'debrid.json',
  files: 'files.json',
  instant: 'instant.json',
  apply: 'apply-debrid.json',
  config: 'config.json',
  response: 'node-response.json',
};

export const active = () => (MODE === 'shadow' ? Boolean(SHADOW_BASE) : MODE !== 'off' && Boolean(DIR));
/**
 * Congela o COMPORTAMENTO (SWR, fast-path, índice, prefetch). Em record/replay
 * vale para o processo todo; no shadow só para a 2ª request do gateway
 * (`X-Adom-Shadow-Frozen: 1`), que é a que grava o caso e é reexecutada pelo
 * Rust. A resposta normal do cliente continua sendo a de produção.
 */
export const behaviorFrozen = () => {
  if (MODE === 'record' || MODE === 'replay') return Boolean(DIR);
  return MODE === 'shadow' && Boolean(SHADOW_BASE) && runtime.capture()?.shadowFrozen === true;
};
/** Modos que gravam no disco; replay só lê. */
export const recording = () => MODE === 'record' || MODE === 'shadow';
export const mode = (): FrozenMode => (active() ? MODE : 'off');

/**
 * Dir do corpus da requisição corrente. O `frozenDir` do AsyncLocalStorage
 * (shadow, por request) vence o DIR global de record/replay — nada de variável
 * global mutável, senão duas requisições concorrentes dividiriam o mesmo dir.
 */
export function dirOf() {
  const perRequest = String(runtime.capture()?.frozenDir || '').trim();
  return perRequest || DIR;
}

/** Dir do caso shadow (`<base>/<id>`); id fechado impede traversal. */
export function shadowDir(id: string, base = SHADOW_BASE) {
  const root = String(base || '').trim();
  if (!root || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(id || ''))) return '';
  return path.join(root, id);
}

export function inputsOf(dir = dirOf()) {
  return dir ? path.join(dir, 'inputs') : '';
}

export function expectedOf(dir = dirOf()) {
  return dir ? path.join(dir, 'expected') : '';
}

export function inputFile(name: string, dir = dirOf()) {
  const base = inputsOf(dir);
  return base ? path.join(base, name) : '';
}

export function expectedFile(name: string, dir = dirOf()) {
  const base = expectedOf(dir);
  return base ? path.join(base, name) : '';
}

export function caseFile(name: string, dir = dirOf()) {
  return dir ? path.join(dir, name) : '';
}

export function readJson<T>(file: string, fallback: T): T {
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
}

/**
 * Conjunto `instant` REAL do sort (`magnetdb.isAlive` + inventário + knownInstant).
 * O gate não pode derivar isso só dos `fromAccount`: há alive do banco que não é
 * da conta e item da conta que não estava instantâneo. Sem gravar o conjunto que
 * o Node usou, o desempate de seeders muda e a lista diverge.
 */
export function writeInstant(hashes: string[]) {
  const list = [...new Set(hashes.map((hash) => String(hash || '').toLowerCase()).filter(Boolean))].sort();
  writeJson(inputFile(FILES.instant), list);
}

export function appendJson(file: string, entry: unknown) {
  const list = readJson<unknown[]>(file, []);
  list.push(entry);
  writeJson(file, list);
}

/**
 * Arquivos (caminho + tamanho) que o debrid leu para ESTE hash. O build do Node
 * usa o memo `fsz` para o 💾 médio de pack; o Rust não tem esse cache, então o
 * record grava a lista aqui e o `FrozenCase` a injeta no `BuildContext`.
 */
export function writeFileSizes(infoHash: string, files: Array<{ path: string; size: number }>) {
  const hash = String(infoHash || '').toLowerCase();
  if (!hash || files.length === 0) return;
  const data = readJson<Record<string, unknown>>(inputFile(FILES.files), {});
  data[hash] = files.map((file) => ({ path: file.path, size: file.size }));
  writeJson(inputFile(FILES.files), data);
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(file: string) {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** Remove campos internos `_*` e mascara segredo/host. Vale para o corpus commitado. */
export function maskValue(value: unknown, ctx: { origin?: string | null; encoded?: string | null } = {}): unknown {
  if (Array.isArray(value)) return value.map((item) => maskValue(item, ctx));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? maskString(value, ctx) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) continue;
    if (raw === undefined) continue;
    out[key] = maskValue(raw, ctx);
  }
  return out;
}

function maskString(text: string, ctx: { origin?: string | null; encoded?: string | null }) {
  let out = text.replace(/sig=([A-Za-z0-9_-]+)/g, 'sig={{sig}}');
  if (ctx.encoded && ctx.encoded.length > 1) out = out.split(ctx.encoded).join('{{config}}');
  if (ctx.origin && ctx.origin.length > 1) out = out.split(ctx.origin).join('{{base}}');
  return out;
}

/**
 * Remove transporte com credencial do corpus. `downloadUrl` do Jackett carrega
 * `jackett_apikey`; o build não o usa (o magnet já veio resolvido), então
 * gravá-lo só vazaria segredo. Aplicado antes de qualquer escrita.
 */
export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'downloadUrl') continue;
    out[key] = stripSecrets(raw);
  }
  return out;
}

export function reset(dir = dirOf()) {
  // `config.json` NÃO entra aqui: o harness grava o POST /internal/search/config
  // ANTES do GET /stream e o beginRequest() do record chama reset(). Apagá-lo
  // deixaria o manifest sem o arquivo (e o replay sem os knobs do operador).
  if (!dir) return;
  for (const name of [FILES.meta, FILES.index, FILES.collect, FILES.fallback, FILES.debrid, FILES.files, FILES.instant, FILES.apply]) {
    try {
      fs.rmSync(inputFile(name, dir), { force: true });
    } catch { /* arquivo ausente */ }
  }
  try {
    fs.rmSync(expectedFile(FILES.response, dir), { force: true });
  } catch { /* arquivo ausente */ }
}

export function writeManifest(dir = dirOf()) {
  if (!dir) return;
  const files: Record<string, string> = {};
  const add = (rel: string) => {
    const hash = sha256File(path.join(dir, rel));
    if (hash) files[rel.split(path.sep).join('/')] = hash;
  };
  add(FILES.request);
  for (const name of [FILES.meta, FILES.index, FILES.collect, FILES.fallback, FILES.debrid, FILES.files, FILES.instant, FILES.apply, FILES.config]) {
    add(path.join('inputs', name));
  }
  add(path.join('expected', FILES.response));
  // No shadow o `case` é o id do header (o dir por request); no record o
  // harness passa STREAM_FROZEN_CASE e ele continua vencendo.
  const request = readJson<{ case?: string }>(caseFile(FILES.request, dir), {});
  writeJson(caseFile('manifest.json', dir), {
    format: 'adom-stream-frozen/1',
    case: CASE_ID || request.case || null,
    mode: MODE,
    files,
    masked: true,
    notCaptured: [
      'índice e banco vivo: desligados neste piloto (RELEASE_INDEX=false, MAGNET_BANK=false)',
      'relógio, ordem da lista e ordem de chaves: fora do diff (§9.3)',
      'HMAC: sig mascarado; replay Rust usa segredo vazio',
      'segmento de config: não versionado; replay usa e30 ou --encoded do operador',
      ...(MODE === 'shadow' ? ['shadow: inputs/config.json é hidratado pelo gateway (POST /internal/search/config)'] : []),
    ],
  });
}
