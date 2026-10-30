/**
 * Efeitos do play da ponte nativa (`rust-remote.ts`), que é o único caminho.
 * A assinatura (infoHash + S/E + dica w) continua na rota, antes do POST.
 * Daqui só sai o que o catch do TypeScript gravaria: magnet, cache, índice
 * e, no Real-Debrid bloqueado, o ledger. 451 nunca vira markBad.
 */
import { applyMagnetEffect } from './rust-resolve-magnet.js';
import { applyCacheEffect } from './rust-resolve-cache.js';
import { applyIndexEffect } from './rust-resolve-index.js';
import * as rdLedger from './rd-ledger.js';
import {
  isBlockedError,
  isDubLieError,
  isEpisodePickError,
  isNoVideoError,
} from './common.js';

export type RustResolveEffect = {
  magnet: { mark: 'bad' | 'lie' | null; unprotect?: boolean };
  cache: { invalidate: 'obra' | 'streams' | 'none' };
  index: { index: 'missing' | 'missing-season' | 'lied' | null };
  noteBlocked: boolean;
};

export type ResolveApplyContext = {
  adapterId: string;
  apiKey: string;
  infoHash: string;
  imdbId: string;
  season: number | null;
  episode: number | null;
  services: {
    cache: { clearNamespace(namespace: string): number };
    metrics: { count(name: string, n?: number): void };
    log: { info(message: string): void; warn(message: string): void };
  };
};

const MAGNET_MARKS = new Set<unknown>(['bad', 'lie', null]);
const CACHE_INVALIDATES = new Set<unknown>(['obra', 'streams', 'none']);
const INDEX_MARKS = new Set<unknown>(['missing', 'missing-season', 'lied', null]);

const OBRA_AFTER = {
  bad: 'torrent sem vídeo',
  lie: 'mentira de áudio',
  missing: 'episódio ausente no pack',
} as const;

/** Só os campos conhecidos. O corpo do POST não fica no erro. */
export function takeResolveEffect(value: unknown): RustResolveEffect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const body = value as {
    magnet?: { mark?: unknown; unprotect?: unknown };
    cache?: { invalidate?: unknown };
    index?: { index?: unknown };
    noteBlocked?: unknown;
  };
  if (!body.magnet || !MAGNET_MARKS.has(body.magnet.mark)) return undefined;
  if (!body.cache || !CACHE_INVALIDATES.has(body.cache.invalidate)) return undefined;
  if (!body.index || !INDEX_MARKS.has(body.index.index)) return undefined;
  const mark = body.magnet.mark as RustResolveEffect['magnet']['mark'];
  const noteBlocked = body.noteBlocked === true;
  return {
    magnet: noteBlocked
      ? { mark: null }
      : { mark, ...(body.magnet.unprotect === true ? { unprotect: true } : {}) },
    cache: { invalidate: body.cache.invalidate as RustResolveEffect['cache']['invalidate'] },
    index: { index: body.index.index as RustResolveEffect['index']['index'] },
    noteBlocked,
  };
}

/**
 * Efeito PLANO de `adom_debrid::resolve_effects::resolve_effect`
 * (`{mark, unprotect, invalidate, index, noteBlocked}`). Sem consumidor em
 * `src/` desde a saída de `/internal/resolve/effects`: o gateway grava os
 * efeitos nos stores nativos (`play_effects_native`). Passa pela mesma validação
 * do formato aninhado: campo desconhecido devolve `undefined`.
 */
export function effectFromRustJson(value: unknown): RustResolveEffect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const flat = value as { mark?: unknown; unprotect?: unknown; invalidate?: unknown; index?: unknown; noteBlocked?: unknown };
  return takeResolveEffect({
    magnet: { mark: flat.mark ?? null, unprotect: flat.unprotect },
    cache: { invalidate: flat.invalidate },
    index: { index: flat.index ?? null },
    noteBlocked: flat.noteBlocked,
  });
}

function evidenceOf(err: unknown): { declaredEpisodes?: unknown } | undefined {
  if (!err || typeof err !== 'object' || !('evidence' in err)) return undefined;
  const evidence = (err as { evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== 'object') return undefined;
  return evidence as { declaredEpisodes?: unknown };
}

function effectFromError(err: unknown, ctx: ResolveApplyContext): RustResolveEffect {
  if (isNoVideoError(err)) {
    return {
      magnet: { mark: 'bad' },
      cache: { invalidate: ctx.imdbId ? 'obra' : 'none' },
      index: { index: null },
      noteBlocked: false,
    };
  }
  if (isBlockedError(err)) {
    return {
      magnet: { mark: null },
      cache: { invalidate: 'streams' },
      index: { index: null },
      noteBlocked: ctx.adapterId === 'realdebrid',
    };
  }
  if (isDubLieError(err)) {
    return {
      magnet: { mark: 'lie', unprotect: true },
      cache: { invalidate: ctx.imdbId ? 'obra' : 'none' },
      index: { index: ctx.imdbId ? 'lied' : null },
      noteBlocked: false,
    };
  }
  if (isEpisodePickError(err)) {
    const evidence = evidenceOf(err);
    const located = Boolean(ctx.imdbId && Number.isFinite(ctx.season) && Number.isFinite(ctx.episode));
    const canMark = Boolean(evidence && located);
    const declared = evidence?.declaredEpisodes;
    const missingSeason = canMark && Array.isArray(declared) && declared.length === 0;
    return {
      magnet: { mark: null },
      cache: { invalidate: canMark ? 'obra' : 'none' },
      index: { index: !canMark ? null : missingSeason ? 'missing-season' : 'missing' },
      noteBlocked: false,
    };
  }
  return {
    magnet: { mark: null },
    cache: { invalidate: 'none' },
    index: { index: null },
    noteBlocked: false,
  };
}

function chosenEffect(source: unknown, ctx: ResolveApplyContext): RustResolveEffect {
  const direct = takeResolveEffect(source);
  if (direct) return direct;
  if (source && typeof source === 'object' && 'effect' in source) {
    const attached = takeResolveEffect((source as { effect?: unknown }).effect);
    if (attached) return attached;
  }
  return effectFromError(source, ctx);
}

function obraReason(effect: RustResolveEffect): keyof typeof OBRA_AFTER | null {
  if (effect.cache.invalidate !== 'obra') return null;
  if (effect.magnet.mark === 'bad') return 'bad';
  if (effect.magnet.mark === 'lie' || effect.index.index === 'lied') return 'lie';
  if (effect.index.index === 'missing' || effect.index.index === 'missing-season') return 'missing';
  return null;
}

/**
 * Erro já tipado, ou o efeito do POST /debrid/resolve quando ele vier no JSON.
 * Magnet, cache e índice rodam uma vez. noteBlocked só no Real-Debrid.
 */
export function applyResolveEffects(source: unknown, ctx: ResolveApplyContext): void {
  const effect = chosenEffect(source, ctx);
  const magnet: RustResolveEffect['magnet'] = effect.noteBlocked ? { mark: null } : effect.magnet;
  applyMagnetEffect(magnet, ctx.adapterId, ctx.apiKey, ctx.infoHash);
  const cleared = applyCacheEffect(effect.cache, ctx.imdbId, {
    cache: ctx.services.cache,
    metrics: ctx.services.metrics,
    log: {
      info: (message) => ctx.services.log.info(message),
      warn: (message) => ctx.services.log.warn(message),
    },
  });
  const reason = obraReason({ ...effect, magnet });
  if (reason && cleared > 0) {
    ctx.services.metrics.count(`resolve.streamsInvalidated.${reason}`);
    ctx.services.log.info(
      `[resolve] invalidou ${cleared} entrada(s) de streams da obra ${ctx.imdbId} após ${OBRA_AFTER[reason]}`,
    );
  }
  applyIndexEffect(
    effect.index,
    ctx.imdbId,
    { season: ctx.season, episode: ctx.episode },
    ctx.infoHash,
  );
  if (effect.noteBlocked && ctx.adapterId === 'realdebrid') rdLedger.noteBlocked(ctx.infoHash);
}
