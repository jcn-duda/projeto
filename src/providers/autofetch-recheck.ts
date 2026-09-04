import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';
import type { TorrentStatusEntry } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import * as held from '../debrid/protected.js';
import { accountScope } from '../utils/request-key.js';
import { run, opts } from '../runtime.js';
import type { RuntimeContext } from '../runtime.js';
import * as autofetch from './autofetch.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { rdGate } from '../debrid/rd-gate.js';
import { isRateLimitError } from '../debrid/common.js';
import * as rdLedger from '../debrid/rd-ledger.js';

export type SeasonHint = { imdbId?: string | null; season?: number | null; isPack?: boolean };
export type RecheckLot = {
  hashes: Set<string>;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  ctx: RuntimeContext;
  deadStreak: Map<string, number>;
  stallStreak: Map<string, number>;
  seasonHints: Map<string, SeasonHint>;
  createdAt: number;
  isSettle: boolean;
  refusals: number;
};

/**
 * Lotes de recheck pós-enfileiramento, por busca: hashes aceitos pelo debrid
 * aguardando ficar tocáveis, detecção de mortos e drenagem da fila.
 */
export const recheckLots = new Map<string, RecheckLot>();

// Índice efêmero: só há consumidor enquanto o recheck vive no processo.
export const seasonSearchKeys = new Map<string, Set<string>>();

export function seasonIndexKey(adapterId: string, account: string, imdbId: string, season: number) {
  return `${adapterId}:${account}:${imdbId}:${season}`;
}

export function registerSeasonSearchKey(
  adapterId: string,
  account: string,
  imdbId: string,
  season: number,
  cacheKey: string,
) {
  const live = autofetchLive.effective();
  const maxSeasons = config.debrid.autoFetchSeasonIndexMax;
  if (!live.autoFetchSeasonFill || maxSeasons <= 0) return;
  const maxKeys = config.debrid.autoFetchSeasonIndexKeys;
  const key = seasonIndexKey(adapterId, account, imdbId, season);
  let keys = seasonSearchKeys.get(key);
  if (!keys) {
    keys = new Set();
    seasonSearchKeys.set(key, keys);
  }
  if (!keys.has(cacheKey) && keys.size >= maxKeys) {
    const oldest = keys.values().next().value;
    if (oldest) keys.delete(oldest);
  }
  keys.add(cacheKey);
  // Map preserva inserção; mover para o fim implementa LRU por temporada.
  seasonSearchKeys.delete(key);
  seasonSearchKeys.set(key, keys);
  while (seasonSearchKeys.size > maxSeasons) {
    const oldest = seasonSearchKeys.keys().next().value;
    if (oldest == null) break;
    seasonSearchKeys.delete(oldest);
  }
}

export function manageSettleLru() {
  const settleLots: Array<{ key: string; createdAt: number; lot: RecheckLot }> = [];
  for (const [k, lot] of recheckLots) {
    if (lot.isSettle) settleLots.push({ key: k, createdAt: lot.createdAt || 0, lot });
  }
  const maxLots = config.debrid.autoFetchSettleMaxLots;
  if (settleLots.length > maxLots) {
    settleLots.sort((a, b) => a.createdAt - b.createdAt);
    for (const { key, lot } of settleLots.slice(0, settleLots.length - maxLots)) {
      if (lot.timer) clearTimeout(lot.timer);
      const account = accountScope(lot.ctx?.opts?.debridApiKey || '');
      for (const h of lot.hashes) held.release(h, account);
      recheckLots.delete(key);
    }
  }
}

export function armRecheck(searchKey: string, lot: RecheckLot) {
  const live = autofetchLive.effective();
  const interval = lot.isSettle ? live.autoFetchSettleMs : live.autoFetchRecheckMs;
  lot.timer = setTimeout(() => runRecheck(searchKey), interval);
  lot.timer.unref();
}

export function scheduleRecheck(
  searchKey: string,
  infoHash: string,
  requestCtx: RuntimeContext | null,
  hint: SeasonHint = {},
) {
  if (!searchKey || !infoHash || !requestCtx) return;
  const live = autofetchLive.effective();
  if (live.autoFetchRecheckMs <= 0 || live.autoFetchRecheckMax <= 0) return;
  let lot = recheckLots.get(searchKey);
  if (!lot) {
    lot = {
      hashes: new Set<string>(), attempts: 0, timer: null, inFlight: false, ctx: requestCtx,
      deadStreak: new Map(), stallStreak: new Map(), seasonHints: new Map(),
      createdAt: Date.now(), isSettle: false, refusals: 0,
    };
    recheckLots.set(searchKey, lot);
  }
  const hash = String(infoHash).toLowerCase();
  lot.hashes.add(hash);
  lot.seasonHints.set(hash, hint);
  lot.ctx = requestCtx;
  if (!lot.timer && !lot.inFlight) armRecheck(searchKey, lot);
}

function cleanLotHash(lot: RecheckLot, hash: string) {
  lot.hashes.delete(hash);
  lot.deadStreak.delete(hash);
  lot.stallStreak.delete(hash);
  lot.seasonHints.delete(hash);
}

export function drainNext(searchKey: string, lot: any) {
  const live = autofetchLive.effective();
  if (!searchKey || !live.autoFetchQueue || autofetchLive.isPaused()) return;
  const queue = autofetch.readQueue(searchKey);
  if (!queue.length) return;
  const adapter = debrid.current();
  if (!adapter) return;
  const account = accountScope(opts().debridApiKey);
  if (autofetch.budgetBlockedUntil(adapter.id, account) > Date.now()) return;
  if (adapter.id === 'realdebrid' && rdGate.isCoolingDown(account)) return;
  if (autofetch.accountGateBlocked(adapter, opts().debridApiKey)) return;

  // Teto de recusas: sem takeNext (sem requeue). A poda de obsoletos do
  // takeNext deixa de rodar enquanto o dreno está travado — roda na próxima passagem.
  if ((lot.refusals || 0) >= config.debrid.autoFetchDrainMaxRefusals) {
    log.warn(`[autofetch] drenagem interrompida após ${lot.refusals} recusas consecutivas`);
    return;
  }

  const { next, remaining } = autofetch.takeNext(queue, (cand) => {
    const h = String(cand.infoHash).toLowerCase();
    return (
      autofetch.isDead(adapter.id, account, h) ||
      Boolean(cache.get(autofetch.markerKey(adapter.id, account, h))) ||
      held.isHeld(h, account) ||
      held.isDurablyProtected(adapter.id, account, h)
    );
  });

  autofetch.writeQueue(searchKey, remaining, config.debrid.autoFetchQueueTtl, adapter.id, account);
  if (!next) return;

  const requeue = () => autofetch.writeQueue(
    searchKey,
    [next, ...remaining],
    config.debrid.autoFetchQueueTtl,
    adapter.id,
    account,
  );

  const h = String(next.infoHash).toLowerCase();
  const mKey = autofetch.markerKey(adapter.id, account, h);
  if (!autofetch.acquire(mKey)) {
    requeue();
    return;
  }

  if (!autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit)) {
    autofetch.release(mKey);
    autofetch.blockBudget(adapter.id, account, config.debrid.autoFetchDrainBackoffMs);
    requeue();
    return;
  }

  held.hold(h, live.autoFetchTtl, account);
  debrid.enqueue(h, { season: next.season, episode: next.episode })
    .then((ok) => {
      autofetch.release(mKey);
      if (ok) {
        cache.set(mKey, autofetch.markerValue(ok), live.autoFetchTtl);
        metrics.count('autofetch.queued');
        metrics.count('autofetch.enqueued');
        if (adapter.id === 'alldebrid' && next.pool === 'br' && Boolean(next.br) && Boolean(next.dubbed)) {
          held.protectBr(adapter.id, account, h);
        }
        lot.hashes.add(h);
        lot.seasonHints.set(h, {
          imdbId: typeof next.imdbId === 'string' ? next.imdbId : undefined,
          season: next.season,
          isPack: next.isPack === true,
        });
        lot.refusals = 0;
        log.info(`[autofetch] ${adapter.label} drenou da fila e baixando: ${next.title || next.name || h}`);
      } else {
        held.release(h, account);
        lot.refusals = (lot.refusals || 0) + 1;
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} recusou dreno de ${h}`);
        if (lot.refusals < config.debrid.autoFetchDrainMaxRefusals) drainNext(searchKey, lot);
      }
    })
    .catch((err) => {
      autofetch.release(mKey);
      held.release(h, account);
      if (adapter.id === 'realdebrid' && isRateLimitError(err)) {
        const current = autofetch.readQueue(searchKey);
        const filtered = [next, ...current.filter((item) => String(item.infoHash).toLowerCase() !== h)];
        autofetch.writeQueue(searchKey, filtered, config.debrid.autoFetchQueueTtl, adapter.id, account);
        metrics.count('autofetch.rdGateRequeued');
        log.info(`[autofetch] cooldown RD abriu durante o dreno; ${h} voltou à frente da fila`);
        return;
      }
      lot.refusals = (lot.refusals || 0) + 1;
      log.warn('[autofetch] falha ao drenar da fila:', err?.message || err);
    });
}

export function runRecheck(searchKey: string) {
  const lot = recheckLots.get(searchKey);
  if (!lot) return;
  lot.timer = null;
  lot.inFlight = true;
  lot.attempts += 1;

  Promise.resolve(run(lot.ctx, async () => {
    const adapter = debrid.current();
    if (!adapter) {
      recheckLots.delete(searchKey);
      return;
    }
    const account = accountScope(opts().debridApiKey);

    let checkResult: { cached: Set<string>; known: boolean } = { cached: new Set(), known: false };
    if (adapter.cacheCheck) {
      try {
        checkResult = await debrid.checkCached([...lot.hashes], { forceFresh: true });
      } catch (err: unknown) {
        log.warn(`[autofetch] falha na checagem de cache em ${adapter.id}:`, log.errorMessage(err));
      }
    }

    let statuses: Record<string, TorrentStatusEntry> = {};
    let statusOk = false;
    if (typeof adapter.torrentStatus === 'function') {
      try {
        // Ponte hash -> id da transferência, do marker que o enqueue gravou.
        // Serviço que não publica o hash na listagem depende dela para ser
        // observável; quem publica ignora o mapa e nada muda.
        const ids: Record<string, string> = {};
        for (const h of lot.hashes) {
          const id = autofetch.markerTransferId(adapter.id, account, h);
          if (id) ids[h] = id;
        }
        statuses = await adapter.torrentStatus(opts().debridApiKey, [...lot.hashes], ids);
        statusOk = true;
      } catch (err: unknown) {
        log.warn(`[autofetch] falha ao consultar torrentStatus em ${adapter.id}:`, log.errorMessage(err));
      }
    }

    for (const hash of [...lot.hashes]) {
      const statusInfo = statuses[hash];
      const isReady = (checkResult.known && checkResult.cached.has(hash)) || statusInfo?.state === 'ready';
      if (isReady) {
        if (adapter.id === 'realdebrid') rdLedger.noteHit([hash]);
        metrics.count('autofetch.ready');
        metrics.observe('autofetch.ready-ms', Date.now() - (lot.createdAt || Date.now()));
        if (adapter.cacheCheck) {
          cache.forget(searchKey);
          debrid.noteAvailable(hash);
          metrics.count('autofetch.ready-note');
          const hint = lot.seasonHints.get(hash);
          const live = autofetchLive.effective();
          if (live.autoFetchSeasonFill && hint?.isPack && hint.imdbId && hint.season != null) {
            const indexKey = seasonIndexKey(adapter.id, account, hint.imdbId, hint.season);
            const keys = [...(seasonSearchKeys.get(indexKey) || [])];
            seasonSearchKeys.delete(indexKey);
            cache.forgetMany(keys);
            metrics.count('autofetch.season-fill', keys.length);
            log.info(`[autofetch] pack S${hint.season} de ${hint.imdbId} pronto; ${keys.length} busca(s) da temporada invalidada(s)`);
          }
          log.info(`[autofetch] download ficou pronto; próxima pergunta de ${searchKey} reconstrói com ⚡`);
        }
        autofetch.dropQueue(searchKey);
        cleanLotHash(lot, hash);
        held.noteReady(adapter.id, account, hash);
        held.release(hash, account);
        continue;
      }

      const live = autofetchLive.effective();
      const isDead = statusInfo?.state === 'dead';
      const stalledHere = statusInfo?.stalled === true && live.autoFetchStallStreak > 0;
      if (isDead || stalledHere) {
        const counter = isDead ? lot.deadStreak : lot.stallStreak;
        const threshold = isDead ? 2 : live.autoFetchStallStreak;
        const streak = (counter.get(hash) || 0) + 1;
        counter.set(hash, streak);
        if (streak >= threshold) {
          metrics.count(isDead ? 'autofetch.dead' : 'autofetch.stalled');
          autofetch.blacklist(adapter.id, account, hash);
          held.unprotect(adapter.id, account, hash);
          held.release(hash, account);
          // A ponte pelo id expõe de uma vez transferências que a remoção
          // automática NUNCA alcançou (58 de 60 na conta medida). Ligar visão e
          // destruição no mesmo deploy faria a primeira rodada apagar um acervo
          // inteiro sem ninguém ter olhado — então a remoção por via `id` nasce
          // DESLIGADA e o que ela faria vira contador. O resto (blacklist,
          // soltar holds, drenar fila) é local e roda igual: impede a fila de
          // crescer sem apagar nada da conta.
          const podeRemover = statusInfo.via !== 'id' || config.debrid.removeById;
          if (!podeRemover) {
            metrics.count(isDead ? 'autofetch.dead.suppressed' : 'autofetch.stalled.suppressed');
          } else if (typeof adapter.removeTorrent === 'function' && statusInfo.id != null) {
            adapter.removeTorrent(opts().debridApiKey, statusInfo.id).catch(() => {});
          }
          cleanLotHash(lot, hash);
          const destino = podeRemover ? 'removendo e drenando fila' : 'drenando fila (remoção por id desligada)';
          log.info(`[autofetch] torrent ${hash} detectado como ${isDead ? 'morto' : 'parado'} (${streak} rechecks consecutivos); ${destino}`);
          drainNext(searchKey, lot);
        }
      } else if (statusOk && statusInfo) {
        lot.deadStreak.set(hash, 0);
        lot.stallStreak.set(hash, 0);
      } else {
        // Sem resposta não há prova de vida nem morte — rodada neutra.
        metrics.count('autofetch.status-unknown');
      }
    }

    lot.inFlight = false;
    if (lot.hashes.size === 0) {
      recheckLots.delete(searchKey);
      return;
    }

    const liveAfter = autofetchLive.effective();
    if (!lot.isSettle && lot.attempts >= liveAfter.autoFetchRecheckMax) {
      lot.isSettle = true;
      manageSettleLru();
      armRecheck(searchKey, lot);
    } else if (lot.isSettle && (Date.now() - (lot.createdAt || 0)) >= liveAfter.autoFetchTtl * 1000) {
      metrics.count('autofetch.expired-unready', lot.hashes.size);
      if (typeof adapter.removeTorrent === 'function') {
        for (const h of lot.hashes) {
          const sid = statuses[h]?.id;
          if (sid != null) adapter.removeTorrent(opts().debridApiKey, sid).catch(() => {});
        }
      }
      for (const h of lot.hashes) {
        cache.forget(autofetch.markerKey(adapter.id, account, h));
        held.unprotect(adapter.id, account, h);
        held.release(h, account);
      }
      recheckLots.delete(searchKey);
    } else {
      armRecheck(searchKey, lot);
    }
  })).catch((err) => {
    lot.inFlight = false;
    log.warn('[autofetch] recheck falhou:', err?.message || err);
    if (lot.hashes.size > 0) armRecheck(searchKey, lot);
    else recheckLots.delete(searchKey);
  });
}
