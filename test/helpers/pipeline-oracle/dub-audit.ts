// ORÁCULO CONGELADO — NÃO É CÓDIGO DE PRODUÇÃO.
//
// Cópia fiel de `src/providers/dub-audit.ts` no commit dff6ed73 (branch rust),
// congelada em `test/helpers/pipeline-oracle/` no momento em que o T3-L7a
// levou o interrogatório de áudio para o gateway Rust. O pipeline congelado
// (`debrid-pipeline.ts`) continua enfileirando por aqui para que o oráculo do
// `applyDebrid` siga reproduzindo o comportamento de antes do corte. Não edite
// para "acompanhar" produção: o comportamento novo é validado no núcleo Rust
// (`adom-server::dub_audit`); este arquivo só preserva o passado.
import config from '../../../src/config.js';
import type { DebridAdapter, Stream, WorkHint } from '../../../types/domain.js';
import { parseTitleSeasonEpisode } from '../../../src/utils/format.js';
import debrid from '../../../src/debrid/index.js';
import * as magnetdb from '../../../src/utils/magnetdb.js';
import * as releaseIndex from '../../../src/utils/release-index.js';
import * as log from '../../../src/utils/logger.js';
import * as metrics from '../../../src/utils/metrics.js';
import * as cache from '../../../src/utils/cache.js';
import { opts } from '../../../src/runtime.js';
import { accountScope } from '../../../src/utils/request-key.js';
import * as protectedApi from '../../../src/debrid/protected.js';
import { isDubLieError, isEpisodePickError } from '../../../src/debrid/common.js';
import { invalidateStreamsForObra } from '../../../src/utils/br-gap.js';
import type { ApplyDebridOptions } from '../../../src/providers/debrid-apply-types.js';

type DubAuditCandidate = {
  hash: string;
  season: number | null;
  episode: number | null;
  imdbId: string | null;
  work?: WorkHint;
  dubbed: boolean;
  needsPromote?: boolean;
  key?: string | null;
  extraKeys?: string[];
};
// Lido aqui, e não de `config`: o knob saiu do TS junto com a fila (o gateway
// o lê em `dub_audit.rs::DubAuditConfig::from_env`). Mesmo default, mesma env.
const TAIL_MAX = Number(process.env.DEBRID_DUB_AUDIT_MAX ?? 2);
const dubAuditPending: DubAuditCandidate[] = [];

export function collectAuditCandidates(
  list: Stream[],
  cached: Set<string>,
  { season, episode, imdbId, workHint }: Pick<ApplyDebridOptions, 'season' | 'episode' | 'imdbId' | 'workHint'>,
) {
  const work = (s: Stream): WorkHint | undefined => (workHint ? { names: workHint.n, year: workHint.y, pack: Boolean(s._multiWork) } : undefined);
  const byHash = new Map<string, DubAuditCandidate>();
  for (const s of list) {
    if (s._fromFallback) continue;
    if (!s.infoHash || !(s._dubbed || s._dubClaim) || !cached.has(s.infoHash)) continue;
    byHash.set(String(s.infoHash), {
      hash: String(s.infoHash),
      season: season ?? null,
      episode: episode ?? null,
      imdbId: imdbId || null,
      work: work(s),
      dubbed: true,
      needsPromote: Boolean(s._dubClaim && !s._dubbed),
    });
  }
  if (season != null && episode != null) {
    for (const s of list) {
      if (s._fromFallback) continue;
      if (!s.infoHash || !cached.has(s.infoHash)) continue;
      const hash = String(s.infoHash);
      if (byHash.has(hash)) continue;
      if (nomeiaEpisodio(s.title || s.name || '', season, episode)) continue;
      byHash.set(hash, {
        hash,
        season,
        episode,
        imdbId: imdbId || null,
        work: work(s),
        dubbed: false,
      });
    }
  }
  return [...byHash.values()];
}

export function queueDubAudit(adapterId: string, apiKey: string, candidates: DubAuditCandidate[], searchKey: string | null = null) {
  if (!config.audioAudit.enabled || TAIL_MAX <= 0) return;
  let added = false;
  for (const cand of candidates) {
    if (magnetdb.isLie(adapterId, apiKey, cand.hash)) continue;
    const candHash = String(cand.hash || '').toLowerCase();
    const prev = dubAuditPending.find((p) => String(p.hash || '').toLowerCase() === candHash
      && p.season === cand.season && p.episode === cand.episode);
    if (prev) {
      if (cand.key && prev.key && cand.key !== prev.key) {
        prev.extraKeys = prev.extraKeys || [];
        if (!prev.extraKeys.includes(cand.key)) prev.extraKeys.push(cand.key);
      }
      continue;
    }
    if (cand.imdbId && cand.season != null && cand.episode != null
      && releaseIndex.isMissing(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash)) continue;
    dubAuditPending.push({ ...cand, key: searchKey });
    added = true;
  }
  if (dubAuditPending.length > 50) dubAuditPending.splice(0, dubAuditPending.length - 50);
  if (added) {
    const handle = setImmediate(async () => {
      try {
        const r = await runDubAudit();
        if (r.audited > 0) log.info(`[audit] tail: ${r.audited} candidato(s) provado(s), ${r.lies} mentira(s), ${r.wrongEpisodes} episódio(s) errado(s)`);
      } catch (err) {
        log.warn('[audit] drenagem falhou:', err?.message || err);
      }
    });
    handle.unref?.();
  }
}

export async function runDubAudit(limit = TAIL_MAX) {
  const batch = dubAuditPending.splice(0, Math.max(0, Math.trunc(Number(limit) || 0)));
  let lies = 0;
  let wrongEpisodes = 0;
  const liedKeys = new Set<string>();
  const okKeys = new Set<string>();
  const okImdb = new Set<string>();
  for (const cand of batch) {
    try {
      await debrid.resolveLink(cand.hash, { season: cand.season, episode: cand.episode, work: cand.work, dubbed: Boolean(cand.dubbed) });
      if (cand.dubbed && cand.needsPromote) {
        if (cand.key) okKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) okKeys.add(extra);
        if (cand.imdbId) okImdb.add(cand.imdbId);
      }
    } catch (err) {
      if (isDubLieError(err)) {
        lies += 1;
        const adapter = debrid.current() as DebridAdapter | null;
        if (adapter) magnetdb.markLie(adapter.id, opts().debridApiKey, cand.hash);
        if (adapter) {
          protectedApi.unprotect(adapter.id, accountScope(opts().debridApiKey), cand.hash);
        }
        if (cand.imdbId) releaseIndex.markLied(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash);
        if (cand.key) liedKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) liedKeys.add(extra);
        if (cand.imdbId) okImdb.add(cand.imdbId);
        metrics.count('debrid.audit.lie.tail');
        log.warn(`[audit] tail provou mentira ${String(cand.hash).slice(0, 8)}${err.evidence?.matchedGroup ? ` (${err.evidence.matchedGroup})` : ''}`);
      } else if (isEpisodePickError(err)) {
        if (!err.evidence) {
          log.warn(
            `[audit] tail: episódio não identificado em ${String(cand.hash).slice(0, 8)} (ambiguidade, sem prova)` +
            `${err.context ? ` — ${err.context.videoCount} vídeo(s): ${err.context.samples.join(' | ')}` : ''}`,
          );
          continue;
        }
        wrongEpisodes += 1;
        metrics.count('debrid.audit.episode');
        if (cand.imdbId && cand.season != null && cand.episode != null) {
          releaseIndex.markMissing(cand.imdbId, { season: cand.season, episode: cand.episode }, cand.hash);
          if (err.evidence.declaredEpisodes.length === 0) {
            releaseIndex.markMissingSeason(cand.imdbId, cand.season, cand.hash);
          }
        }
        if (cand.key) liedKeys.add(cand.key);
        for (const extra of cand.extraKeys || []) if (extra) liedKeys.add(extra);
        if (cand.imdbId) okImdb.add(cand.imdbId);
        log.warn(`[audit] tail provou episódio errado ${String(cand.hash).slice(0, 8)} (declara S${err.evidence.declaredSeasons.join(',') || '?'}E${err.evidence.declaredEpisodes.join(',') || '?'})`);
      }
    }
  }
  for (const key of liedKeys) cache.forget(key);
  for (const key of okKeys) cache.forget(key);
  for (const imdb of okImdb) invalidateStreamsForObra(imdb);
  return { audited: batch.length, lies, wrongEpisodes };
}

export function nomeiaEpisodio(title: string, season: number, episode: number) {
  const { seasons, episodes } = parseTitleSeasonEpisode(String(title || ''));
  return episodes.includes(episode) && (seasons.length === 0 || seasons.includes(season));
}
