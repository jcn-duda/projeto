import crypto from 'node:crypto';
import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';
import type { DebridAdapter, Stream } from '../../types/domain.js';
import {
  pickBrDubbedByTargetQualities,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  cachedBrDubbedTargetQualities,
  isAutofetchTargetQuality,
  canAutoFetchBr,
  isSeasonPackFillEligible,
  streamQuality,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import * as held from '../debrid/protected.js';
import { accountScope } from '../utils/request-key.js';
import { capture, opts } from '../runtime.js';
import * as autofetch from './autofetch.js';
import { classifyEnqueue, ENQUEUE_ROLLBACK, noteSkip, skipCountsSnapshot, warnAccountGated } from './autofetch-gates.js';
import type { SkipReason } from './autofetch-gates.js';
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

type AutoFetchStream = Stream & { infoHash: string };
type AutoFetchCandidate = { stream: AutoFetchStream; account: string; pool: string };
type AutoFetchRequest = {
  cached: Set<string>;
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
};

function isAutoFetchStream(stream: Stream): stream is AutoFetchStream {
  return typeof stream.infoHash === 'string' && stream.infoHash.length > 0;
}

/**
 * Sem fonte BR dublada tocável, manda o debrid baixar as melhores — o play passa
 * a funcionar minutos depois, sem o usuário pedir. Roda em TODA busca, então as
 * travas importam mais que a funcionalidade:
 *
 * - desligável (`autoFetchBr`), e desligado junto quando não há debrid;
 * - exige `known`: sem saber o que está em cache não há como saber o que falta,
 *   e sairíamos enfileirando torrent às cegas (Real-Debrid e Debrid-Link caem
 *   aqui — neles o /resolve do play já adiciona o magnet de qualquer forma);
 * - ATÉ `autoFetchMax` torrents por busca, com uma vaga por candidato
 *   compartilhada entre o passe parcial e o tardio (acquireSearchSlot);
 * - marca o hash no cache ANTES de chamar a API: a mesma busca é repetida pelo
 *   Stremio e ainda passa pelo passe tardio, e sem isso cada repetição mandaria
 *   o mesmo torrent de novo;
 * - nunca entra no caminho da resposta: erro só vira log.
 */
export function autoFetchCandidates(
  streams: Stream[],
  { season, imdbId, searchKey }: { season?: number | null; imdbId?: string; searchKey?: string } = {},
) {
  const { autoFetchBr, debridApiKey } = opts();
  const adapter = debrid.current();
  if (!canAutoFetchBr({ autoFetchBr }, adapter)) {
    noteSkip('disabled', streams[0] || null, adapter?.id || '', '');
    return [];
  }
  const account = accountScope(debridApiKey);

  // Torrent morto na blacklist é ignorado antes de montar os pools
  const liveStreams = streams.filter((s) => !s.infoHash || !autofetch.isDead(adapter!.id, account, s.infoHash));
  const live = autofetchLive.effective();

  const queueDepth = live.autoFetchQueue ? live.autoFetchQueueDepth : 0;
  const totalMax = live.autoFetchMax + queueDepth;

  // Cascata br → any → seeds: no pool BR pega 1 por qualidade-alvo
  // (720/1080/4K); recusar o nível `any` não pode abortar a busca inteira —
  // o corte antigo (`return []`) matava o terceiro nível justamente quando
  // o operador pediu só a rede de segurança de swarm.
  let candidates = pickBrDubbedByTargetQualities(liveStreams, new Set(), totalMax, { season }).filter(isAutoFetchStream);
  let pool = 'br';
  const dubbedGlobal = candidates.length === 0
    ? pickAnyDubbedCandidates(liveStreams, new Set(), totalMax, { season }).filter(isAutoFetchStream)
    : [];
  if (dubbedGlobal.length > 0) {
    if (live.autoFetchAnyDubbed) {
      candidates = dubbedGlobal;
      pool = 'any';
      metrics.count('autofetch.any-dubbed');
    } else {
      metrics.count('autofetch.any-dubbed-skipped');
    }
  }
  if (candidates.length === 0 && live.autoFetchTopSeeds) {
    candidates = pickTopSeededCandidates(liveStreams, new Set(), live.autoFetchTopSeedsMax + queueDepth, {
      season, minSeeders: live.autoFetchMinSeeders,
      ptFirst: live.autoFetchSeedsPtFirst,
    }).filter(isAutoFetchStream);
    pool = 'seeds';
    if (candidates.length > 0) metrics.count('autofetch.top-seeded');
  }
  if (candidates.length === 0) {
    metrics.count('autofetch.no-candidate');
    noteSkip('no-candidate', liveStreams[0] || null, adapter?.id || '', pool);
  }

  const immediateLimit = pool === 'seeds' ? live.autoFetchTopSeedsMax : live.autoFetchMax;
  const immediate = candidates.slice(0, immediateLimit);
  const queued = candidates.slice(immediateLimit);

  // Hold apenas nos candidatos imediatos que serão disparados
  for (const candidate of immediate) {
    held.hold(String(candidate.infoHash), live.autoFetchTtl, account);
  }

  // Candidatos excedentes vão para a fila persistente (latest-writer)
  if (live.autoFetchQueue && searchKey) {
    autofetch.writeQueue(
      searchKey,
      queued.map((s) => ({
        infoHash: String(s.infoHash || '').toLowerCase(),
        name: s.name,
        title: s.title,
        quality: s._quality,
        seeders: s._seeders,
        br: s._br,
        dubbed: s._dubbed,
        pool,
        imdbId,
        season,
        episode: null,
        isPack: Boolean(
          live.autoFetchSeasonFill && adapter?.cacheCheck && isSeasonPackFillEligible(s, season ?? null),
        ),
      })),
      config.debrid.autoFetchQueueTtl,
      adapter!.id,
      account,
    );
  }

  return immediate.map((stream) => ({ stream, account, pool }));
}

export function releaseAllHolds(candidates: AutoFetchCandidate[]) {
  for (const { stream, account } of candidates) held.release(String(stream.infoHash || ''), account);
}

/**
 * Libera o que a desistência adquiriu — a tabela diz o quê, na ordem dos
 * returns de hoje (marker/in-flight não liberam nada, de propósito).
 */
function rollbackEnqueue(reason: SkipReason, r: { lockKey: string; searchKey: string | null | undefined; holdHash: string | null | undefined; account: string }) {
  for (const action of ENQUEUE_ROLLBACK[reason] || []) {
    if (action === 'lock') autofetch.release(r.lockKey);
    else if (action === 'slot') { if (r.searchKey) autofetch.releaseSearchSlot(r.searchKey); }
    else held.release(String(r.holdHash || ''), r.account);
  }
}

/** Enfileira UM candidato de forma fire-and-forget, com marker, orçamento e vaga por busca. */
export function enqueueAutofetch({ stream, account, pool }: AutoFetchCandidate, { cached, season, episode, imdbId, searchKey }: AutoFetchRequest) {
  const adapter = debrid.current() as DebridAdapter;
  const requestCtx = capture();
  const h = String(stream.infoHash || '').toLowerCase();
  if (!h) return;

  const live = autofetchLive.effective();
  const key = autofetch.markerKey(adapter.id, account, h);
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
      searchKey, pool === 'seeds' ? live.autoFetchTopSeedsMax : live.autoFetchMax),
    accountBlocked: () => autofetch.accountGateBlocked(adapter, opts().debridApiKey),
    tryBudget: () => autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit),
  });
  if (reason) {
    noteSkip(reason, stream, adapter.id, pool);
    rollbackEnqueue(reason, { lockKey: key, searchKey, holdHash: stream.infoHash, account });
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
        metrics.count('autofetch.enqueued');
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
          isPack: Boolean(
            live.autoFetchSeasonFill && adapter.cacheCheck && isSeasonPackFillEligible(stream, season ?? null),
          ),
        });
      } else {
        if (searchKey) autofetch.releaseSearchSlot(searchKey);
        held.release(h, account);
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} não aceitou ${h}`);
      }
    })
    .catch((err) => {
      autofetch.release(key);
      if (searchKey) autofetch.releaseSearchSlot(searchKey);
      held.release(stream.infoHash, account);
      log.warn('[autofetch] falhou:', err?.message || err);
    });
  return true;
}

export { registerSeasonSearchKey, scheduleRecheck, drainNext, type SeasonHint, type RecheckLot };


export function autoFetchBrDubbed(streams: any[], candidates: any[], { cached, known, season, episode, imdbId, searchKey }: any) {
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
  if (poolName === 'any' || poolName === 'seeds') {
    if (cached.size > 0) {
      noteSkip('stop-has-br', candidates[0]?.stream, debrid.current()?.id || '', poolName);
      releaseAllHolds(candidates);
      return 0;
    }
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
