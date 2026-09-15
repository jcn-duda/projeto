import crypto from 'node:crypto';
import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';
import type { DebridAdapter } from '../../types/domain.js';
import {
  hasCachedBrDubbed,
  hasCachedAnyDubbed,
  cachedBrDubbedTargetQualities,
  isAutofetchTargetQuality,
  isSeasonPackFillEligible,
  streamQuality,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import * as held from '../debrid/protected.js';
import { accountScope } from '../utils/request-key.js';
import { capture, opts } from '../runtime.js';
import * as autofetch from './autofetch.js';
import { classifyEnqueue, rollbackEnqueue, noteSkip, skipCountsSnapshot, warnAccountGated } from './autofetch-gates.js';
import { reserveObra, commitObra, releaseObra, type ObraLease } from './autofetch-obra.js';
import { applySeedsStopGate, purgeSeedsQueue } from './autofetch-seeds-pool.js';
import { seedsPolicyConfig } from './autofetch-candidates.js';
import type { AutoFetchCandidate, AutoFetchRequest } from './autofetch-candidates.js';
import * as autofetchTrace from '../utils/autofetch-trace.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import {
  scheduleRecheck,
  drainNext,
  registerSeasonSearchKey,
  recheckLots,
  seasonSearchKeys,
  type SeasonHint,
  type RecheckLot,
} from './autofetch-recheck.js';
import { recordAutofetchRelease } from './autofetch-index.js';

// Seleção (autoFetchCandidates) e política do pool seeds vivem em módulos
// próprios; aqui ficam o disparo (enqueueAutofetch), o despacho pós-cache
// (autoFetchBrDubbed) e o estado operacional do processo.
export { autoFetchCandidates } from './autofetch-candidates.js';
export type { AutoFetchCandidate, AutoFetchRequest } from './autofetch-candidates.js';

export function releaseAllHolds(candidates: AutoFetchCandidate[]) {
  for (const { stream, account } of candidates) held.release(String(stream.infoHash || ''), account);
}

/** Enfileira UM candidato de forma fire-and-forget, com marker, orçamento e vaga por busca. */
export function enqueueAutofetch({ stream, account, pool, slotLimit, rare }: AutoFetchCandidate, { cached, season, episode, imdbId, searchKey }: AutoFetchRequest) {
  const adapter = debrid.current() as DebridAdapter;
  const requestCtx = capture();
  const h = String(stream.infoHash || '').toLowerCase();
  if (!h) return;

  const live = autofetchLive.effective();
  const key = autofetch.markerKey(adapter.id, account, h);
  // Reserva do teto por OBRA (Fase 2). Fica numa variável própria porque os
  // portões POSTERIORES (account-gate/budget) precisam devolvê-la no rollback.
  let obraLease: ObraLease | null = null;
  // Pack de temporada: identidade por TEMPORADA (episódio nulo). O mesmo
  // predicado alimenta o hint do recheck, que é quem libera a vaga do hash
  // terminal com a identidade certa.
  const isPack = Boolean(live.autoFetchSeasonFill && adapter.cacheCheck && isSeasonPackFillEligible(stream, season ?? null));
  // Portões em UM ponto: checagens injetadas na ordem exata, rollback pela
  // tabela, e a desistência deixa rastro (contador + trace) em vez de um return mudo.
  const reason = classifyEnqueue({
    isPaused: () => autofetchLive.isPaused(),
    isDead: () => autofetch.isDead(adapter.id, account, h),
    isCached: () => cached.has(h),
    markerActive: () => Boolean(cache.get(key)),
    tryLock: () => autofetch.acquire(key),
    // Vaga compartilhada entre passe parcial e tardio pelo mesmo searchKey;
    // se pools diferentes, o teto efetivo é o do pool que pediu por último.
    trySlot: () => !searchKey || autofetch.acquireSearchSlot(
      searchKey, slotLimit ?? (pool === 'seeds' ? live.autoFetchTopSeedsMax : live.autoFetchMax)),
    // Teto por obra: reserva SÍNCRONA antes de qualquer await, para duas buscas
    // concorrentes da MESMA obra enxergarem a vaga uma da outra.
    tryObraCap: () => {
      obraLease = reserveObra({
        adapterId: adapter.id, account, imdbId, season, episode: isPack ? null : episode, isPack, searchKey,
        pool, hash: h, rare, slotLimit,
      });
      return obraLease != null;
    },
    accountBlocked: () => autofetch.accountGateBlocked(adapter, opts().debridApiKey),
    tryBudget: () => autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit),
  });
  if (reason) {
    noteSkip(reason, stream, adapter.id, pool);
    rollbackEnqueue(reason, { lockKey: key, searchKey, holdHash: stream.infoHash, account, obraLease });
    if (reason === 'account-gate') warnAccountGated(adapter, account);
    return;
  }

  const label = String(stream.title || stream.name || '').split('\n')[0].slice(0, 70);
  const qStr = stream._quality || 'N/A';
  const seedsStr = stream._seeders != null ? ` · 👤 ${stream._seeders}` : '';
  debrid
    .enqueue(h, { season, episode })
    .then((ok) => {
      autofetch.release(key);
      if (ok) {
        cache.set(key, autofetch.markerValue(ok), live.autoFetchTtl);
        // Aceite confirmado: o hash vira entrada durável do teto da obra (o que
        // o F6 vai ler). Reserva recusada nunca é persistida.
        commitObra(obraLease, {
          hash: h,
          pool,
          title: String(stream.title || stream.name || '').split('\n')[0].slice(0, 120),
          br: Boolean(stream._br),
          dubbed: Boolean(stream._dubbed),
          ...(typeof ok === 'string' && ok ? { id: ok } : {}),
        });
        metrics.count('autofetch.enqueued');
        recordAutofetchRelease(imdbId, {
          ...stream,
          season,
          episode,
          imdbId,
          pool,
        });
        // Proteção durável SÓ no pool BR do AllDebrid com flags reais (não
        // `_lied`): é o acervo que o usuário quer retido. `any`/`seeds` não
        // passam — dublagem global ou melhor swarm não viram acervo a reter.
        if (adapter.id === 'alldebrid' && pool === 'br' && Boolean(stream._br) && Boolean(stream._dubbed) && !stream._lied) {
          held.protectBr(adapter.id, account, h);
        }
        const poolLabel = pool === 'any'
          ? 'dublada global (sem BR na busca)'
          : pool === 'seeds'
            ? 'melhor swarm (nada dublado na busca)'
            : 'fonte BR dublada';
        log.info(`[autofetch] ${adapter.label} baixando ${poolLabel}: ${label} (${qStr}${seedsStr})`);
        scheduleRecheck(searchKey || '', h, requestCtx, {
          imdbId,
          season,
          episode: isPack ? null : episode,
          isPack,
        });
      } else {
        releaseObra(obraLease);
        if (searchKey) autofetch.releaseSearchSlot(searchKey);
        held.release(h, account);
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} não aceitou ${h}`);
      }
    })
    .catch((err) => {
      autofetch.release(key);
      releaseObra(obraLease);
      if (searchKey) autofetch.releaseSearchSlot(searchKey);
      held.release(stream.infoHash, account);
      log.warn('[autofetch] falhou:', err?.message || err);
    });
  return true;
}

export { registerSeasonSearchKey, scheduleRecheck, drainNext, type SeasonHint, type RecheckLot };

export function autoFetchBrDubbed(streams: any[], candidates: any[], { cached, known, season, episode, imdbId, searchKey }: any) {
  const adapter = debrid.current() as DebridAdapter;
  if (!candidates || candidates.length === 0) {
    noteSkip('no-candidates', null, debrid.current()?.id || '', '');
    return 0;
  }

  if (!known) {
    noteSkip('unknown-cache', candidates[0]?.stream, debrid.current()?.id || '', candidates[0]?.pool);
    releaseAllHolds(candidates);
    return 0;
  }

  const poolName = candidates[0].pool;
  if (poolName === 'any') {
    // Dublado tocável (BR ou global) para o any. Gringo ⚡ (REMUX Kickass/TPB)
    // não substitui a dublada — o cached.size antigo abortava o aquecimento.
    if (hasCachedBrDubbed(streams, cached) || hasCachedAnyDubbed(streams, cached)) {
      noteSkip('stop-has-br', candidates[0]?.stream, debrid.current()?.id || '', poolName);
      releaseAllHolds(candidates);
      return 0;
    }
  } else if (poolName === 'seeds') {
    // Terceiro nível: parada por cache e exceção do título raro vivem na
    // política (decideSeedsStop) + applySeedsStopGate. A purga da fila remove
    // SÓ entradas seeds — a reposição br/any não é assunto deste pool.
    const live = autofetchLive.effective();
    const policy = seedsPolicyConfig();
    const purgeSeeds = () => {
      if (!live.autoFetchQueue || !searchKey) return;
      purgeSeedsQueue(searchKey, {
        ttl: config.debrid.autoFetchQueueTtl,
        adapterId: adapter.id,
        account: candidates[0]?.account || accountScope(opts().debridApiKey),
      });
    };
    if (policy.dubbedOnly) {
      noteSkip('dubbed-only', candidates[0]?.stream, adapter.id, poolName);
      purgeSeeds();
      releaseAllHolds(candidates);
      return 0;
    }
    const gate = applySeedsStopGate(candidates, {
      rare: Boolean(candidates[0]?.rare),
      rareThreshold: live.autoFetchRareThreshold,
      adapterCacheCheck: adapter.cacheCheck === true,
      cached,
      hasCachedDubbed: hasCachedBrDubbed(streams, cached) || hasCachedAnyDubbed(streams, cached),
      rareOverCached: config.debrid.autoFetchRareOverCached,
      queue: live.autoFetchQueue && searchKey
        ? { searchKey, ttl: config.debrid.autoFetchQueueTtl, adapterId: adapter.id,
            account: candidates[0]?.account || accountScope(opts().debridApiKey) }
        : null,
    });
    if (gate.stop) {
      noteSkip(gate.stop, candidates[0]?.stream, adapter.id, poolName);
      purgeSeeds();
      releaseAllHolds(candidates);
      return 0;
    }
    candidates = gate.candidates;
  } else {
    // Pool br: cobertura POR qualidade-alvo. 720 Dual ⚡ não mata o 1080/4K.
    // Unknown/SD: se já há QUALQUER BR dublado em cache, para (fallback).
    const covered = cachedBrDubbedTargetQualities(streams, cached, { season });
    const remaining: typeof candidates = [];
    for (const selected of candidates) {
      const q = streamQuality(selected.stream);
      const drop = isAutofetchTargetQuality(q)
        ? covered.has(q)
        : hasCachedBrDubbed(streams, cached);
      if (drop) {
        // A cobertura pode vir de OUTRO hash da mesma obra/faixa que o índice
        // recolocou no lote. O skip é por cache já tocável, não por igualdade
        // de hash — é assim que buscas repetidas deixam de baixar duplicatas.
        noteSkip('already-cached', selected.stream, debrid.current()?.id || '', poolName);
        // Hold foi adquirido ANTES do checkCached — liberar um a um os que
        // a cobertura já resolveu, senão o hash fica imune ao dropUncached.
        held.release(String(selected.stream.infoHash || ''), selected.account);
        continue;
      }
      remaining.push(selected);
    }
    if (remaining.length === 0) {
      noteSkip('stop-has-br', candidates[0]?.stream, debrid.current()?.id || '', poolName);
      return 0;
    }
    candidates = remaining;
  }

  let enqueued = 0;
  for (const selected of candidates) {
    enqueued += enqueueAutofetch(selected, { cached, season, episode, imdbId, searchKey }) ? 1 : 0;
  }
  return enqueued;
}

export function setPaused(paused: boolean): boolean {
  return autofetchLive.setPaused(paused);
}

export function isPaused(): boolean {
  return autofetchLive.isPaused();
}

/** Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário. */
export function autofetchRunnerStatus() {
  const now = Date.now();
  const live = autofetchLive.snapshot();
  const lots = [...recheckLots.entries()].map(([searchKey, lot]) => ({
    id: crypto.createHash('sha256').update(searchKey).digest('hex').slice(0, 12),
    hashes: lot.hashes?.size || 0,
    attempts: Number(lot.attempts || 0),
    isSettle: Boolean(lot.isSettle),
    ageMs: Math.max(0, now - Number(lot.createdAt || now)),
    refusals: Number(lot.refusals || 0),
    inFlight: Boolean(lot.inFlight),
  }));
  return {
    recheckLots: recheckLots.size,
    settleLots: lots.filter((lot) => lot.isSettle).length,
    lots,
    seasonSearchKeys: seasonSearchKeys.size,
    paused: live.paused,
    pausedSince: live.pausedSince,
    // Por que o Chupim desistiu: contagem por motivo + últimos registros do trace.
    skips: skipCountsSnapshot(),
    lastSkips: autofetchTrace.lastSkips(20),
  };
}
