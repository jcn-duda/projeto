/**
 * Anotação de tamanho de episódio/filme em Rust (`annotateEpisodeSizes`,
 * `rust/crates/adom-napi/src/episode_size.rs`): fill do total do torrent
 * (`tsz`), anotação do episódio/filme pela lista de arquivos (`fsz`), guarda de
 * pack, corte do total em texto, fill de quem veio sem 💾 e dedupe de pack
 * repetido — UMA chamada napi. O TS dessa decisão saiu do branch (o oráculo é
 * o `esm`); o IO continua aqui: o Node lê os caches `fsz`/`tsz`
 * (`file-sizes.ts`) e manda o lote pronto. O Rust não emite os eventos
 * `episodeSize.*` do stageTrace.
 */
import { peekFileSizes, peekTorrentTotal } from '../debrid/file-sizes.js';
import { requireCore } from './rust-core.js';
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
  annotateEpisodeSizes(input: AnnotateInputNapi): { streams: unknown[] };
};

type AnnotateOptionsLike = {
  season?: number | null;
  episode?: number | null;
  meta?: { episodes?: Record<string, number> } | null;
  work?: { n: string[]; y: number | null } | null;
  cached?: ReadonlySet<string> | null;
  stage?: 'build' | 'debrid';
};

/** Monta a entrada do napi: lê os caches `fsz`/`tsz` dos hashes presentes. */
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
    if (files) {
      filesByHash[hash] = files.map((f) => ({ path: String(f.path || ''), size: Number(f.size) || 0 }));
    }
    const total = peekTorrentTotal(hash);
    if (total > 0) {
      totalsByHash[hash] = total;
    }
  }
  const meta = options.meta?.episodes || {};
  const episodesMeta = Object.keys(meta)
    .map((season) => ({ season: Number(season), episodes: Number(meta[season]) || 0 }))
    .filter((row) => row.season > 0 && row.episodes > 0);
  return dropNulls({
    streams,
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

/** Anota no Rust; erro do núcleo sobe (não há implementação TS de reserva). */
export function rustAnnotateEpisodeSizes(streams: unknown[], options: AnnotateOptionsLike): unknown[] {
  metrics.count('rust.episodeSize.calls');
  const core = requireCore() as unknown as EpisodeSizeCore;
  const out = core.annotateEpisodeSizes(buildAnnotateInput(streams, options));
  if (!out || !Array.isArray(out.streams)) throw new Error('annotateEpisodeSizes não devolveu streams');
  return out.streams;
}
