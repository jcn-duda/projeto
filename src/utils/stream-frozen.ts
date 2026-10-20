// Captura/replay congelado do `/stream` (Fase 1 do gate de paridade).
//
// O problema que isto resolve: Node e Rust liam Jackett/Flare/banco em instantes
// diferentes e o diff acusava ruído de coleta como se fosse divergência de
// pipeline. Aqui o Node grava as entradas que USOU (meta, lotes crus, checagem
// de debrid, saída do applyDebrid) e o replay as devolve sem rede e sem SQLite.
// O Rust consome os mesmos arquivos pelas rotas internas (`FrozenRoutes`).
//
// Segurança: o segmento de config NUNCA é gravado (só o sha256); `sig` vira
// `{{sig}}`, a origem vira `{{base}}`, `downloadUrl` (jackett_apikey) sai e
// campos internos `_*` são removidos do envelope final.
//
// Modo:
//   STREAM_FROZEN_MODE=record|replay
//   STREAM_FROZEN_DIR=<dir do caso>
//   STREAM_FROZEN_CASE=<id do caso> (opcional)
//   STREAM_FROZEN_MODE=shadow + STREAM_FROZEN_SHADOW_BASE=<base>
//     Grava UM dir por request (`<base>/<X-Adom-Shadow-Id>`) sem desligar SWR,
//     fast-path, índice ou prefetch: a resposta é a de produção.
//
// A infraestrutura de I/O/máscara/manifesto vive em `stream-frozen-store.ts`
// (catraca de 400 linhas); este módulo é a API pública de record/replay.
import type { LiveIndexerState } from '../providers/live-indexer-state.js';
import { liveFromSnapshot } from '../providers/live-indexer-state.js';
import {
  MODE,
  CASE_ID,
  FILES,
  active,
  behaviorFrozen,
  recording,
  mode,
  dirOf,
  inputFile,
  expectedFile,
  caseFile,
  readJson,
  writeJson,
  appendJson,
  sha256,
  maskValue,
  stripSecrets,
  reset,
  shadowDir,
  writeManifest,
  writeFileSizes,
  writeInstant,
  writeTorrentTotal,
} from './stream-frozen-store.js';

export { active, behaviorFrozen, mode };
export { freshRequest } from './stream-fresh.js';
export type { FrozenMode } from './stream-frozen-store.js';

// `fsz`/`tsz` e o estado da 1ª passada (pré-debrid) moram no store (catraca).
export { recordFileSizes, recordTorrentTotal, recordFileSizesAtBuild, recordTorrentTotalAtBuild, markBuildPass } from './stream-frozen-store.js';

/**
 * Grava a qualidade que o build REALMENTE usou (hash → qualidade provada). Mora
 * no store pela catraca de linhas; a API pública é esta.
 */
export { recordProvenQualities } from './stream-frozen-store.js';

/** Conjunto `instant` exato que o sort usou (magnetdb/inventário/knownInstant). */
export function recordInstant(hashes: string[]) {
  if (!recording() || !active()) return;
  writeInstant(hashes);
}

// -- request/response -------------------------------------------------------

/**
 * Abre a captura da requisição. Devolve o dir POR REQUEST no shadow (o chamador
 * o publica no AsyncLocalStorage) e `null` em record/replay, que usam o DIR
 * global. `base` existe para o teste/smoke; em produção vale a env.
 */
export function beginRequest(info: {
  type: string;
  id: string;
  encoded?: string | null;
  deadlineMs?: number | null;
  userAgent?: string | null;
  shadowId?: string | null;
  base?: string | null;
}): string | null {
  if (!active() || MODE === 'replay') return null;
  const shadowId = String(info.shadowId || '').trim();
  const dir = MODE === 'shadow'
    ? shadowDir(shadowId, String(info.base || '').trim() || undefined)
    : dirOf();
  if (!dir) return null;
  reset(dir);
  const encoded = String(info.encoded || '');
  writeJson(caseFile(FILES.request, dir), {
    format: 'adom-stream-frozen-request/1',
    case: CASE_ID || (MODE === 'shadow' ? shadowId : '') || `${info.type}-${info.id}`,
    type: info.type,
    stream_id: info.id,
    encoded_sha256: encoded ? sha256(encoded) : null,
    encoded_len: encoded.length,
    deadline_ms: info.deadlineMs ?? null,
    user_agent: info.userAgent ?? null,
    captured_at: new Date().toISOString(),
    node_version: process.version,
    mode: MODE,
  });
  return MODE === 'shadow' ? dir : null;
}

export function finishResponse(
  response: unknown,
  ctx: { origin?: string | null; encoded?: string | null } = {},
) {
  if (!active()) return;
  // Sem dir desta requisição não há o que gravar (shadow sem header, ou tarefa
  // de fundo que não pertence a nenhum caso).
  if (!dirOf()) return;
  const masked = maskValue(response, ctx);
  if (recording()) {
    writeJson(expectedFile(FILES.response), masked);
    writeManifest();
    return;
  }
  // Replay nunca sobrescreve a referência gravada; grava ao lado para o diff.
  writeJson(expectedFile('node-replay.json'), masked);
}

// -- metadados --------------------------------------------------------------

export interface FrozenMeta {
  meta: unknown;
  titles: unknown;
  collection: unknown;
  homeReleaseAt: number | null;
}

export async function aroundMeta<T extends FrozenMeta>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const file = inputFile(FILES.meta);
  if (!active() || !file) return run();
  if (MODE === 'replay') {
    const captured = readJson<T | null>(file, null);
    if (!captured) throw new Error(`frozen: ${file} ausente no replay`);
    return captured;
  }
  const value = await run();
  writeJson(file, { key, ...value });
  return value;
}

// -- coleta -----------------------------------------------------------------

export interface CollectKey {
  imdb: string;
  type: string;
  season: number | null;
  episode: number | null;
  scope: string;
  query: string;
  ptQuery?: string | null;
}

interface CollectEntry {
  key: CollectKey;
  response: {
    items: unknown[];
    partial: boolean;
    sweepInline: boolean;
    live: unknown;
  };
}

export async function aroundCollect<T extends {
  items: unknown[];
  partial: boolean;
  sweepInline?: boolean;
  live?: LiveIndexerState | null;
}>(key: CollectKey, run: () => Promise<T>): Promise<T> {
  const file = inputFile(FILES.collect);
  if (!active() || !file) return run();
  if (MODE === 'replay') {
    const entries = readJson<CollectEntry[]>(file, []);
    const entry = matchCollect(entries, key);
    // Lacuna de captura, não "a fonte respondeu vazio": sem esta linha o lote
    // vazio do replay pareceria divergência de pipeline. stderr é capturado
    // pelo harness (`scripts/golden/stream-frozen.mjs`).
    if (!entry) {
      console.warn(
        `[frozen] collect ausente: imdb=${key.imdb} type=${key.type}`
        + ` season=${key.season ?? '-'} episode=${key.episode ?? '-'} scope=${key.scope}`
        + ` query=${JSON.stringify(key.query)} ptQuery=${JSON.stringify(key.ptQuery ?? null)}`,
      );
    }
    return replayBatch(entry, key) as unknown as T;
  }
  const value = await run();
  appendJson(file, {
    key,
    response: {
      items: stripSecrets(value.items),
      partial: value.partial,
      sweepInline: Boolean(value.sweepInline),
      live: value.live ? value.live.snapshot() : null,
    },
  });
  return value;
}

function matchCollect(entries: CollectEntry[], key: CollectKey): CollectEntry | null {
  const exact = entries.find((entry) => sameCollectKey(entry.key, key));
  if (exact) return exact;
  const byScope = entries.filter((entry) => entry.key.imdb === key.imdb && entry.key.scope === key.scope);
  if (byScope.length === 1) return byScope[0];
  return byScope.find((entry) => (entry.key.season ?? null) === (key.season ?? null)
    && (entry.key.episode ?? null) === (key.episode ?? null)) ?? null;
}

function sameCollectKey(a: CollectKey, b: CollectKey) {
  return a.imdb === b.imdb && a.type === b.type
    && (a.season ?? null) === (b.season ?? null)
    && (a.episode ?? null) === (b.episode ?? null)
    && a.scope === b.scope && a.query === b.query
    && (a.ptQuery ?? null) === (b.ptQuery ?? null);
}

function replayBatch(entry: CollectEntry | null, key: CollectKey) {
  const live = entry?.response.live
    ? liveFromSnapshot(entry.response.live as Parameters<typeof liveFromSnapshot>[0])
    : null;
  return {
    items: entry?.response.items ?? [],
    partial: entry?.response.partial ?? false,
    completion: Promise.resolve(),
    sweepInline: entry?.response.sweepInline ?? false,
    live,
    ...(entry ? {} : { _frozenMissing: `${key.imdb} ${key.scope} ${key.query}` }),
  };
}

// -- índice -----------------------------------------------------------------

export async function aroundIndex<T extends { servedFromIndex: boolean; instant: boolean; raw: any }>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const file = inputFile(FILES.index);
  if (!active() || !file) return run();
  if (MODE === 'replay') {
    const captured = readJson<{ key: string; value: any } | null>(file, null);
    if (!captured) return { servedFromIndex: false, instant: false, raw: null } as T;
    const raw = captured.value.raw
      ? { ...captured.value.raw, completion: Promise.resolve() }
      : null;
    return { ...captured.value, raw } as T;
  }
  const value = await run();
  writeJson(file, {
    key,
    value: {
      servedFromIndex: value.servedFromIndex,
      instant: value.instant,
      raw: value.raw
        ? {
          items: stripSecrets(value.raw.items),
          partial: value.raw.partial,
          sweepInline: Boolean(value.raw.sweepInline),
          instant: Boolean(value.raw.instant),
          live: value.raw.live ? value.raw.live.snapshot() : null,
        }
        : null,
    },
  });
  return value;
}

// -- fallback do banco ------------------------------------------------------

export async function aroundFallback<T extends { items: unknown[]; injected: number; cut: unknown }>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const file = inputFile(FILES.fallback);
  if (!active() || !file) return run();
  if (MODE === 'replay') {
    const captured = readJson<{ key: string; value: T } | null>(file, null);
    return captured?.value ?? ({ items: [], injected: 0, cut: {} } as unknown as T);
  }
  const value = await run();
  // A 1ª passada é a que monta a resposta; o tail (`late`) não pode
  // sobrescrever a reserva que o build usou.
  if (readJson<{ key: string; value: T } | null>(file, null)) return value;
  writeJson(file, { key, value: stripSecrets(value) });
  return value;
}

// -- debrid: checkCached ----------------------------------------------------

interface CheckCall {
  hashes: string[];
  file_hashes: string[];
  known: boolean;
  unusable: { reason: string; message: string } | null;
  cached: string[];
}

interface DebridFile {
  service: string | null;
  results: Record<string, { cached: boolean; known: boolean; unusable?: unknown }>;
  calls: CheckCall[];
}

export async function aroundCheck<T extends {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string; message: string };
}>(
  hashes: string[],
  meta: { service: string | null; fileHashes?: string[] },
  run: () => Promise<T>,
): Promise<T> {
  const file = inputFile(FILES.debrid);
  if (!active() || !file) return run();
  if (MODE === 'replay') {
    const data = readJson<DebridFile>(file, { service: null, results: {}, calls: [] });
    const normalized = hashes.map((hash) => String(hash).toLowerCase());
    const call = data.calls.find((entry) => covers(entry.hashes, normalized))
      ?? data.calls.find((entry) => entry.hashes.some((hash) => normalized.includes(hash)));
    const cached = new Set<string>();
    for (const hash of normalized) {
      if (data.results[hash]?.cached) cached.add(hash);
    }
    if (!call) return { cached, known: false } as T;
    return {
      cached,
      known: Boolean(call.known),
      ...(call.unusable ? { unusable: call.unusable } : {}),
    } as T;
  }
  const value = await run();
  const data = readJson<DebridFile>(file, { service: meta.service, results: {}, calls: [] });
  if (meta.service) data.service = meta.service;
  for (const hash of hashes.map((item) => String(item).toLowerCase())) {
    data.results[hash] = {
      cached: value.cached.has(hash),
      known: value.known,
      ...(value.unusable ? { unusable: value.unusable } : {}),
    };
  }
  data.calls.push({
    hashes: hashes.map((item) => String(item).toLowerCase()),
    file_hashes: (meta.fileHashes || []).map((item) => String(item).toLowerCase()),
    known: value.known,
    unusable: value.unusable ?? null,
    cached: [...value.cached].map((item) => String(item).toLowerCase()),
  });
  writeJson(file, data);
  return value;
}

function covers(recorded: string[], wanted: string[]) {
  if (recorded.length !== wanted.length) return false;
  const set = new Set(recorded);
  return wanted.every((hash) => set.has(hash));
}

// -- debrid: applyDebrid (replay do Node) -----------------------------------

interface ApplyEntry {
  key: string;
  signals: unknown[];
  output: unknown[];
}

export async function aroundApplyDebrid<T extends unknown[]>(
  input: T,
  meta: { service: string | null; cachedOnly: boolean; hashes: string[] },
  run: (captureSignal: (signal: unknown) => void) => Promise<T>,
  replaySignal?: (signal: unknown) => void,
): Promise<T> {
  const file = inputFile(FILES.apply);
  if (!active() || !file) return run(() => {});
  const key = `${meta.service || ''}|${meta.cachedOnly ? 1 : 0}|${meta.hashes.map((h) => h.toLowerCase()).sort().join(',')}`;
  if (MODE === 'replay') {
    const entries = readJson<ApplyEntry[]>(file, []);
    const entry = entries.find((item) => item.key === key) ?? entries[0];
    if (!entry) return input;
    for (const signal of entry.signals) replaySignal?.(signal);
    return entry.output as T;
  }
  const signals: unknown[] = [];
  const value = await run((signal) => signals.push(signal));
  const entries = readJson<ApplyEntry[]>(file, []);
  entries.push({ key, signals, output: stripSecrets(value) as unknown[] });
  writeJson(file, entries);
  return value;
}
