import crypto from 'node:crypto';
import config from '../config.js';
import type { DebridAdapter, Stream } from '../../types/domain.js';
import {
  markDebridName,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  canAutoFetchBr,
  isSeasonPackFillEligible,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import * as held from '../debrid/protected.js';
import { accountScope } from '../utils/request-key.js';
import { capture, run, opts } from '../runtime.js';
import * as autofetch from './autofetch.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';

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
  if (!canAutoFetchBr({ autoFetchBr }, adapter)) return [];
  const account = accountScope(debridApiKey);

  // Torrent morto na blacklist é ignorado antes de montar os pools
  const liveStreams = streams.filter((s) => !s.infoHash || !autofetch.isDead(adapter!.id, account, s.infoHash));

  const queueDepth = config.debrid.autoFetchQueue ? config.debrid.autoFetchQueueDepth : 0;
  const totalMax = config.debrid.autoFetchMax + queueDepth;

  let candidates = pickBrDubbedCandidates(liveStreams, new Set(), totalMax, { season });
  let pool = 'br';
  const dubbedGlobal = candidates.length === 0
    ? pickAnyDubbedCandidates(liveStreams, new Set(), totalMax, { season })
    : [];
  if (dubbedGlobal.length > 0) {
    if (!config.debrid.autoFetchAnyDubbed) return [];
    candidates = dubbedGlobal;
    pool = 'any';
    metrics.count('autofetch.any-dubbed');
  }
  if (candidates.length === 0 && config.debrid.autoFetchTopSeeds) {
    candidates = pickTopSeededCandidates(liveStreams, new Set(), config.debrid.autoFetchTopSeedsMax + queueDepth, {
      season, minSeeders: config.debrid.autoFetchMinSeeders,
    });
    pool = 'seeds';
    if (candidates.length > 0) metrics.count('autofetch.top-seeded');
  }
  if (candidates.length === 0) metrics.count('autofetch.no-candidate');

  const immediateLimit = pool === 'seeds' ? config.debrid.autoFetchTopSeedsMax : config.debrid.autoFetchMax;
  const immediate = candidates.slice(0, immediateLimit);
  const queued = candidates.slice(immediateLimit);

  // Hold apenas nos candidatos imediatos que serão disparados
  for (const candidate of immediate) {
    held.hold(String(candidate.infoHash), config.debrid.autoFetchTtl, account);
  }

  // Candidatos excedentes vão para a fila persistente (latest-writer)
  if (config.debrid.autoFetchQueue && searchKey) {
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
          config.debrid.autoFetchSeasonFill && adapter?.cacheCheck && isSeasonPackFillEligible(s, season ?? null),
        ),
      })),
      config.debrid.autoFetchQueueTtl,
      adapter!.id,
      account,
    );
  }

  return immediate.map((stream) => ({ stream, account, pool }));
}

export function releaseAllHolds(candidates: any[]) {
  for (const { stream, account } of candidates) held.release(stream.infoHash, account);
}

/** Enfileira UM candidato de forma fire-and-forget, com marker, orçamento e vaga por busca. */
export function enqueueAutofetch({ stream, account, pool }: any, { cached, season, episode, imdbId, searchKey }: any) {
  const adapter = debrid.current() as DebridAdapter;
  const requestCtx = capture();
  const h = String(stream.infoHash || '').toLowerCase();

  if (autofetch.isDead(adapter.id, account, h)) {
    held.release(stream.infoHash, account);
    return;
  }

  if (cached.has(h)) {
    held.release(stream.infoHash, account);
    return;
  }

  const key = autofetch.markerKey(adapter.id, account, stream.infoHash);
  if (cache.get(key)) {
    return;
  }
  if (!autofetch.acquire(key)) return;

  if (searchKey && !autofetch.acquireSearchSlot(searchKey, config.debrid.autoFetchMax)) {
    autofetch.release(key);
    held.release(stream.infoHash, account);
    return;
  }

  if (!autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit)) {
    autofetch.release(key);
    if (searchKey) autofetch.releaseSearchSlot(searchKey);
    held.release(stream.infoHash, account);
    return;
  }

  const label = String(stream.title || stream.name || '').split('\n')[0].slice(0, 70);
  const qStr = stream._quality || 'N/A';
  const seedsStr = stream._seeders != null ? ` · 👤 ${stream._seeders}` : '';
  debrid
    .enqueue(stream.infoHash, { season, episode })
    .then((ok) => {
      autofetch.release(key);
      if (ok) {
        cache.set(key, 1, config.debrid.autoFetchTtl);
        metrics.count('autofetch.enqueued');
        const poolLabel = pool === 'any'
          ? 'dublada global (sem BR na busca)'
          : pool === 'seeds'
            ? 'melhor swarm (nada dublado na busca)'
            : 'fonte BR dublada';
        log.info(`[autofetch] ${adapter.label} baixando ${poolLabel}: ${label} (${qStr}${seedsStr})`);
        scheduleRecheck(searchKey, stream.infoHash, requestCtx, {
          imdbId,
          season,
          isPack: Boolean(
            config.debrid.autoFetchSeasonFill && adapter.cacheCheck && isSeasonPackFillEligible(stream, season),
          ),
        });
      } else {
        if (searchKey) autofetch.releaseSearchSlot(searchKey);
        held.release(stream.infoHash, account);
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} não aceitou ${stream.infoHash}`);
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

/**
 * Lotes de recheck pós-enfileiramento, por busca: hashes aceitos pelo debrid
 * aguardando ficar tocáveis, detecção de mortos e drenagem da fila.
 */
const recheckLots = new Map<string, any>();

// Índice efêmero: só há consumidor enquanto o recheck vive no processo. A
// conta E o serviço entram na chave: a mesma apiKey em dois debrids tem cache
// e disponibilidade distintos, e um pack pronto num não invalida o outro.
const seasonSearchKeys = new Map<string, Set<string>>();

function seasonIndexKey(adapterId: string, account: string, imdbId: string, season: number) {
  return `${adapterId}:${account}:${imdbId}:${season}`;
}

export function registerSeasonSearchKey(
  adapterId: string,
  account: string,
  imdbId: string,
  season: number,
  cacheKey: string,
) {
  const maxSeasons = config.debrid.autoFetchSeasonIndexMax;
  if (!config.debrid.autoFetchSeasonFill || maxSeasons <= 0) return;
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

function manageSettleLru() {
  const settleLots: Array<{ key: string; createdAt: number; lot: any }> = [];
  for (const [k, lot] of recheckLots) {
    if (lot.isSettle) settleLots.push({ key: k, createdAt: lot.createdAt || 0, lot });
  }
  const maxLots = config.debrid.autoFetchSettleMaxLots;
  if (settleLots.length > maxLots) {
    settleLots.sort((a, b) => a.createdAt - b.createdAt);
    const excess = settleLots.slice(0, settleLots.length - maxLots);
    for (const { key, lot } of excess) {
      if (lot.timer) clearTimeout(lot.timer);
      const account = accountScope(lot.ctx?.opts?.debridApiKey || '');
      for (const h of lot.hashes) held.release(h, account);
      recheckLots.delete(key);
    }
  }
}

function armRecheck(searchKey: string, lot: any) {
  const interval = lot.isSettle ? config.debrid.autoFetchSettleMs : config.debrid.autoFetchRecheckMs;
  lot.timer = setTimeout(() => runRecheck(searchKey), interval);
  lot.timer.unref();
}

export function scheduleRecheck(
  searchKey: string,
  infoHash: string,
  requestCtx: any,
  hint: { imdbId?: string; season?: number | null; isPack?: boolean } = {},
) {
  if (!searchKey || !infoHash || !requestCtx) return;
  if (config.debrid.autoFetchRecheckMs <= 0 || config.debrid.autoFetchRecheckMax <= 0) return;
  let lot = recheckLots.get(searchKey);
  if (!lot) {
    lot = {
      hashes: new Set<string>(),
      attempts: 0,
      timer: null,
      inFlight: false,
      ctx: requestCtx,
      deadStreak: new Map<string, number>(),
      stallStreak: new Map<string, number>(),
      seasonHints: new Map<string, { imdbId?: string; season?: number | null; isPack?: boolean }>(),
      createdAt: Date.now(),
      isSettle: false,
      refusals: 0,
    };
    recheckLots.set(searchKey, lot);
  }
  const hash = String(infoHash).toLowerCase();
  lot.hashes.add(hash);
  lot.seasonHints.set(hash, hint);
  lot.ctx = requestCtx;
  if (lot.timer || lot.inFlight) return;
  armRecheck(searchKey, lot);
}

export function drainNext(searchKey: string, lot: any) {
  if (!searchKey || !config.debrid.autoFetchQueue) return;
  const queue = autofetch.readQueue(searchKey);
  if (!queue.length) return;
  const adapter = debrid.current();
  if (!adapter) return;
  const account = accountScope(opts().debridApiKey);
  if (autofetch.budgetBlockedUntil(adapter.id, account) > Date.now()) return;

  const { next, remaining } = autofetch.takeNext(queue, (cand) => {
    const h = String(cand.infoHash).toLowerCase();
    return (
      autofetch.isDead(adapter.id, account, h) ||
      Boolean(cache.get(autofetch.markerKey(adapter.id, account, h))) ||
      held.isHeld(h, account)
    );
  });

  autofetch.writeQueue(searchKey, remaining, config.debrid.autoFetchQueueTtl, adapter.id, account);
  if (!next) return;

  if ((lot.refusals || 0) >= config.debrid.autoFetchDrainMaxRefusals) {
    log.warn(`[autofetch] drenagem interrompida após ${lot.refusals} recusas consecutivas`);
    return;
  }

  const h = String(next.infoHash).toLowerCase();
  const mKey = autofetch.markerKey(adapter.id, account, h);
  if (!autofetch.acquire(mKey)) return;

  if (!autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit)) {
    autofetch.release(mKey);
    // Orçamento cheio não torna este torrent ruim. Rodar a cabeça evita
    // reprocessar para sempre o mesmo item quando a fila for acordada de novo.
    autofetch.blockBudget(adapter.id, account, config.debrid.autoFetchDrainBackoffMs);
    autofetch.writeQueue(searchKey, [...remaining, next], config.debrid.autoFetchQueueTtl, adapter.id, account);
    return;
  }

  held.hold(h, config.debrid.autoFetchTtl, account);
  debrid.enqueue(h, { season: next.season, episode: next.episode })
    .then((ok) => {
      autofetch.release(mKey);
      if (ok) {
        cache.set(mKey, 1, config.debrid.autoFetchTtl);
        metrics.count('autofetch.queued');
        metrics.count('autofetch.enqueued');
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
        if (lot.refusals < config.debrid.autoFetchDrainMaxRefusals) {
          drainNext(searchKey, lot);
        }
      }
    })
    .catch((err) => {
      autofetch.release(mKey);
      held.release(h, account);
      lot.refusals = (lot.refusals || 0) + 1;
      log.warn('[autofetch] falha ao drenar da fila:', err?.message || err);
    });
}

function runRecheck(searchKey: string) {
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
      } catch (err: any) {
        log.warn(`[autofetch] falha na checagem de cache em ${adapter.id}:`, err?.message || err);
      }
    }

    let statuses: Record<string, { state: 'ready' | 'downloading' | 'dead' | 'unknown'; stalled?: boolean; id?: any }> = {};
    if (typeof adapter.torrentStatus === 'function') {
      try {
        statuses = await adapter.torrentStatus(opts().debridApiKey, [...lot.hashes]);
      } catch (err: any) {
        log.warn(`[autofetch] falha ao consultar torrentStatus em ${adapter.id}:`, err?.message || err);
      }
    }

    for (const hash of [...lot.hashes]) {
      const statusInfo = statuses[hash];
      const isReady = (checkResult.known && checkResult.cached.has(hash)) || statusInfo?.state === 'ready';
      if (isReady) {
        metrics.count('autofetch.ready');
        if (adapter.cacheCheck) {
          cache.forget(searchKey);
          const hint = lot.seasonHints.get(hash);
          if (
            config.debrid.autoFetchSeasonFill &&
            hint?.isPack &&
            hint.imdbId &&
            hint.season != null
          ) {
            const indexKey = seasonIndexKey(adapter.id, account, hint.imdbId, hint.season);
            const keys = [...(seasonSearchKeys.get(indexKey) || [])];
            // O índice só serve a este lote vivo. Próximas buscas se registram
            // de novo, sem re-invalidar para sempre uma temporada já promovida.
            seasonSearchKeys.delete(indexKey);
            cache.forgetMany(keys);
            debrid.noteAvailable(hash);
            metrics.count('autofetch.season-fill', keys.length);
            log.info(
              `[autofetch] pack S${hint.season} de ${hint.imdbId} pronto; ` +
              `${keys.length} busca(s) da temporada invalidada(s)`,
            );
          }
          log.info(`[autofetch] download ficou pronto; próxima pergunta de ${searchKey} reconstrói com ⚡`);
        }
        autofetch.dropQueue(searchKey);
        lot.hashes.delete(hash);
        lot.deadStreak.delete(hash);
        lot.stallStreak.delete(hash);
        lot.seasonHints.delete(hash);
        held.release(hash, account);
        continue;
      }

      // Um dead colapsa aos 2 rechecks; um parado (`stalled`) merece limiar
      // PRÓPRIO (`autoFetchStallStreak`): a falta de pares pode ser transitória
      // e matar na 1ª observação descartaria um download que ainda esquentava.
      // Ambos partilham o mesmo desfecho final (blacklist + remoção + dreno da
      // fila), mas os CONTADORES são separados: o contrato é "N observações
      // consecutivas do mesmo tipo". Compartilhar deixaria um stall prévio
      // contar como primeira observação de morte — um dead transitório único
      // derrubaria download ainda recuperável. `0` desliga o stall: parado
      // nunca mais derruba o download.
      const isDead = statusInfo?.state === 'dead';
      const stalledHere = statusInfo?.stalled === true && config.debrid.autoFetchStallStreak > 0;
      if (isDead || stalledHere) {
        const counter = isDead ? lot.deadStreak : lot.stallStreak;
        const threshold = isDead ? 2 : config.debrid.autoFetchStallStreak;
        const streak = (counter.get(hash) || 0) + 1;
        counter.set(hash, streak);
        if (streak >= threshold) {
          metrics.count(isDead ? 'autofetch.dead' : 'autofetch.stalled');
          autofetch.blacklist(adapter.id, account, hash);
          held.release(hash, account);
          if (typeof adapter.removeTorrent === 'function' && statusInfo.id != null) {
            adapter.removeTorrent(opts().debridApiKey, statusInfo.id).catch(() => {});
          }
          lot.hashes.delete(hash);
          lot.deadStreak.delete(hash);
          lot.stallStreak.delete(hash);
          lot.seasonHints.delete(hash);
          log.info(
            `[autofetch] torrent ${hash} detectado como ${isDead ? 'morto' : 'parado'} ` +
            `(${streak} rechecks consecutivos); removendo e drenando fila`,
          );
          drainNext(searchKey, lot);
        }
      } else {
        // Movimento (progresso > 0 / estado que não é dead nem parado): zera as
        // DUAS contagens. Um único recheck com avanço apaga o histórico.
        lot.deadStreak.set(hash, 0);
        lot.stallStreak.set(hash, 0);
      }
    }

    lot.inFlight = false;
    if (lot.hashes.size === 0) {
      recheckLots.delete(searchKey);
      return;
    }

    if (!lot.isSettle && lot.attempts >= config.debrid.autoFetchRecheckMax) {
      lot.isSettle = true;
      manageSettleLru();
      armRecheck(searchKey, lot);
    } else if (lot.isSettle) {
      const ageMs = Date.now() - (lot.createdAt || 0);
      if (ageMs >= config.debrid.autoFetchTtl * 1000) {
        // Settle expirado
        if (typeof adapter.removeTorrent === 'function') {
          for (const h of lot.hashes) {
            const sid = statuses[h]?.id;
            if (sid != null) adapter.removeTorrent(opts().debridApiKey, sid).catch(() => {});
          }
        }
        for (const h of lot.hashes) held.release(h, account);
        recheckLots.delete(searchKey);
      } else {
        armRecheck(searchKey, lot);
      }
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

export function autoFetchBrDubbed(streams: any[], candidates: any[], { cached, known, season, episode, imdbId, searchKey }: any) {
  if (!candidates || candidates.length === 0) return 0;

  if (!known) {
    releaseAllHolds(candidates);
    return 0;
  }

  const stop = candidates[0].pool === 'any' || candidates[0].pool === 'seeds'
    ? cached.size > 0 : hasCachedBrDubbed(streams, cached);
  if (stop) {
    releaseAllHolds(candidates);
    return 0;
  }

  let enqueued = 0;
  for (const selected of candidates) {
    enqueued += enqueueAutofetch(selected, { cached, season, episode, imdbId, searchKey }) ? 1 : 0;
  }
  return enqueued;
}

/** Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário. */
export function autofetchRunnerStatus() {
  const now = Date.now();
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
  };
}
