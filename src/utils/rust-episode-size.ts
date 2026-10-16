/**
 * Ponte do lote de anotação de tamanho em Rust (`annotateEpisodeSizes`,
 * `rust/crates/adom-napi/src/episode_size.rs`): fill do total do torrent
 * (`tsz`), anotação do episódio/filme pela lista de arquivos (`fsz`), guarda de
 * pack, corte do total em texto, fill de quem veio sem 💾 e dedupe de pack
 * repetido — UMA chamada napi. O IO continua aqui: o Node lê os caches
 * `fsz`/`tsz` (`file-sizes.ts`) e manda o lote pronto.
 *
 * Modos (`RUST_EPISODE_SIZE`): `off` (default) = só TS; `on` = o Rust decide e
 * cai no TS se ele lançar; `shadow` = o TS anota e a comparação roda em
 * `setImmediate` (divergência → `rust.episodeSize.divergence` no /metrics.json).
 * No `on` os eventos `episodeSize.*` do stageTrace não são emitidos (o Rust não
 * traca) — em `shadow` o TS continua tracando normalmente.
 */
import config from '../config.js';
import { peekFileSizes, peekTorrentTotal } from '../debrid/file-sizes.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';

export type NapiDebridFileT = { path: string; size: number };

export type AnnotateInputNapi = {
  streams: unknown[];
  filesByHash: Record<string, NapiDebridFileT[]>;
  totalsByHash: Record<string, number>;
  season: number | null;
  episode: number | null;
  episodesMeta: Array<{ season: number; episodes: number }>;
  workNames: string[];
  workYear: number | null;
  cachedHashes: string[] | null;
};

export type EpisodeSizeCore = {
  annotateEpisodeSizes?(input: AnnotateInputNapi): { streams: unknown[] };
};

type GetCore = () => EpisodeSizeCore | null;

type AnnotateOptionsLike = {
  season?: number | null;
  episode?: number | null;
  meta?: { episodes?: Record<string, number> } | null;
  work?: { n: string[]; y: number | null } | null;
  cached?: ReadonlySet<string> | null;
};

let getCore: GetCore | null = null;
let warnedNoFn = false;
let loggedDiffs = 0;

function installEpisodeSizeHook(get: GetCore) {
  getCore = get;
}

function resetEpisodeSizeHook() {
  getCore = null;
  warnedNoFn = false;
  loggedDiffs = 0;
}

export { installEpisodeSizeHook, resetEpisodeSizeHook };

export function episodeSizeMode(): 'off' | 'shadow' | 'on' {
  return config.rustEpisodeSize.mode;
}

/**
 * Monta a entrada do napi: lê os caches `fsz`/`tsz` dos hashes presentes e
 * faz cópia RASA dos streams (o shadow roda depois do `setImmediate`; o que se
 * compara é o estado da hora do agendamento).
 */
export function buildAnnotateInput(
  streams: unknown[],
  options: AnnotateOptionsLike,
): AnnotateInputNapi {
  const filesByHash: Record<string, NapiDebridFileT[]> = {};
  const totalsByHash: Record<string, number> = {};
  const seen = new Set<string>();
  for (const raw of streams) {
    const s = raw as { infoHash?: string } | null;
    const hash = String(s?.infoHash || '').toLowerCase();
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    const files = peekFileSizes(hash);
    if (files) filesByHash[hash] = files.map((f) => ({ path: String(f.path || ''), size: Number(f.size) || 0 }));
    const total = peekTorrentTotal(hash);
    if (total > 0) totalsByHash[hash] = total;
  }
  const meta = options.meta?.episodes || {};
  const episodesMeta = Object.keys(meta)
    .map((season) => ({ season: Number(season), episodes: Number(meta[season]) || 0 }))
    .filter((row) => row.season > 0 && row.episodes > 0);
  return dropNulls({
    streams: streams.map((s) => (s ? { ...(s as Record<string, unknown>) } : null)),
    filesByHash,
    totalsByHash,
    season: options.season ?? null,
    episode: options.episode ?? null,
    episodesMeta,
    workNames: options.work?.n || [],
    workYear: options.work?.y ?? null,
    cachedHashes: options.cached ? [...options.cached] : null,
  });
}

/**
 * O napi-rs só aceita `undefined` (campo omitido) para `Option<f64>`; `null`
 * explícito falha a conversão. Campos nulos são removidos antes da chamada.
 */
function dropNulls<T extends Record<string, unknown>>(input: T): T {
  const out = { ...input };
  for (const k of Object.keys(out)) {
    if (out[k] === null) delete out[k];
  }
  return out;
}

/** JSON canônico (chaves ordenadas) para comparar TS × Rust sem ruído de ordem. */
function canonJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = (v as Record<string, unknown>)[k];
      return out;
    }
    return v;
  });
}

function logDiff(ts: unknown[], rust: unknown[]) {
  metrics.count('rust.episodeSize.divergence');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(
    `[rust] episode-size divergiu: ts=${ts.length} streams rust=${rust.length} streams, `
      + `primeiro ts=${JSON.stringify(ts[0] ?? null)} rust=${JSON.stringify(rust[0] ?? null)}`,
  );
}

/**
 * Caminho `on`: o Rust anota. `null` = off, núcleo ausente ou erro — o
 * chamador segue com o TS (o rust nunca derruba a busca).
 */
export function rustAnnotateEpisodeSizes(
  streams: unknown[],
  options: AnnotateOptionsLike,
): unknown[] | null {
  try {
    if (config.rustEpisodeSize.mode !== 'on' || !getCore) return null;
    const core = getCore();
    if (!core) return null;
    if (typeof core.annotateEpisodeSizes !== 'function') {
      if (!warnedNoFn) {
        warnedNoFn = true;
        log.info('[rust] núcleo sem annotateEpisodeSizes (binário antigo); episode-size segue no TS');
      }
      return null;
    }
    const input = buildAnnotateInput(streams, options);
    metrics.count('rust.episodeSize.calls');
    const out = core.annotateEpisodeSizes(input);
    if (!out || !Array.isArray(out.streams)) throw new Error('annotateEpisodeSizes não devolveu streams');
    return out.streams;
  } catch (err) {
    metrics.count('rust.episodeSize.error');
    log.debug('[rust] episode-size lançou; usando TS:', log.errorMessage(err));
    return null;
  }
}

/** Caminho `shadow`: agenda a comparação FORA do caminho da resposta. */
export function shadowAnnotateEpisodeSizes(
  input: AnnotateInputNapi,
  tsStreams: unknown[],
): void {
  try {
    if (config.rustEpisodeSize.mode !== 'shadow') return;
    const core = getCore?.();
    if (!core) return;
    if (typeof core.annotateEpisodeSizes !== 'function') {
      if (!warnedNoFn) {
        warnedNoFn = true;
        log.info('[rust] núcleo sem annotateEpisodeSizes (binário antigo); sombra do episode-size desligada');
      }
      return;
    }
    const tsFrozen = tsStreams.map((s) => (s ? { ...(s as Record<string, unknown>) } : null));
    const bound = core.annotateEpisodeSizes.bind(core);
    setImmediate(() => {
      try {
        metrics.count('rust.episodeSize.calls');
        const out = bound(input);
        if (!out || !Array.isArray(out.streams)) throw new Error('annotateEpisodeSizes não devolveu streams');
        if (canonJson(tsFrozen) !== canonJson(out.streams)) logDiff(tsFrozen, out.streams);
      } catch (err) {
        metrics.count('rust.episodeSize.error');
        log.debug('[rust] sombra do episode-size lançou:', log.errorMessage(err));
      }
    });
  } catch (err) {
    metrics.count('rust.episodeSize.error');
    log.debug('[rust] sombra do episode-size não agendou:', log.errorMessage(err));
  }
}
