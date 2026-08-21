import crypto from 'node:crypto';
import config from '../config.js';
import type { DebridAdapter, MatchContext, Stream } from '../../types/domain.js';
import * as demo from './demo.js';
import jackett from './jackett.js';
import prowlarr from './prowlarr.js';
import bludv from './bludv.js';
import * as account from './account.js';
import { getMeta } from '../utils/cinemeta.js';
import {
  parseStremioId,
  buildSearchQuery,
  toStremioStream,
  sortAndLimit,
  resolveSearchNames,
  matchesEpisode,
  limitReservingBr,
  UNKNOWN_QUALITY,
  markDebridName,
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasExplicitForeignAudio,
  hasCachedBrDubbed,
  canAutoFetchBr,
  filterKnownCache,
  filterRelevantRaw,
  isMultiWorkCollection,
  extractInfoHash,
  isSeasonPackFillEligible,
} from '../utils/format.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import * as held from '../debrid/protected.js';
import * as tmdb from '../utils/tmdb.js';
import { signResolve } from '../utils/sign.js';
import { accountScope, streamsCacheKey } from '../utils/request-key.js';
import { createLatestWriter } from '../utils/latest-writer.js';
import { planJackettQueries, ptSweepIndexers, ptSweepQueryFor } from './search-plan.js';
import { collectWithinWindow } from './collection-window.js';
import { raceWithDeadline, remainingCheckBudget } from '../utils/deadline.js';
import * as autofetch from './autofetch.js';
import * as magnetdb from '../utils/magnetdb.js';
import { opts, prefix, capture, run, origin } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { noteUserRequest } from './activity.js';

const SAFE_INDEXER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
function autoFetchCandidates(
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

function releaseAllHolds(candidates: any[]) {
  for (const { stream, account } of candidates) held.release(stream.infoHash, account);
}

/** Enfileira UM candidato de forma fire-and-forget, com marker, orçamento e vaga por busca. */
function enqueueAutofetch({ stream, account, pool }: any, { cached, season, episode, imdbId, searchKey }: any) {
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

function registerSeasonSearchKey(
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

function scheduleRecheck(
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

function drainNext(searchKey: string, lot: any) {
  if (!searchKey || !config.debrid.autoFetchQueue) return;
  const queue = autofetch.readQueue(searchKey);
  if (!queue.length) return;
  const adapter = debrid.current();
  if (!adapter) return;
  const account = accountScope(opts().debridApiKey);

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
    autofetch.writeQueue(searchKey, [next, ...remaining], config.debrid.autoFetchQueueTtl, adapter.id, account);
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

function autoFetchBrDubbed(streams: any[], candidates: any[], { cached, known, season, episode, imdbId, searchKey }: any) {
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

/**
 * Marca quais streams já estão cacheados no debrid e troca o infoHash por um
 * link de play que passa pela nossa rota /resolve.
 */
async function applyDebrid(streams: any[], { season, episode, imdbId, searchKey, deadlineAt, onCacheResult, workHint }: any) {
  const adapter = debrid.current();
  if (!adapter || streams.length === 0) return streams;

  const {
    debridCachedOnly: cachedOnly,
    showUncachedBr,
    brReservedSlots,
  } = opts();
  const { publicUrl } = config.debrid;

  // Banco de magnets + blacklist do autofetch: o que já PROVOU estar quebrado
  // sai ANTES da checagem — não se gasta lote (nem upload, na AllDebrid) com
  // fracasso conhecido. Só histórico desta conta: cache do debrid pertence a
  // ela, e um morto aqui pode estar vivo em outro serviço.
  const trustApiKey = opts().debridApiKey;
  const trustScope = accountScope(trustApiKey);
  const beforeTrust = streams.length;
  streams = streams.filter((s: any) => !(s.infoHash && (
    magnetdb.isBad(adapter.id, trustApiKey, s.infoHash) ||
    autofetch.isDead(adapter.id, trustScope, s.infoHash)
  )));
  if (streams.length < beforeTrust) {
    metrics.count('magnetdb.dropped', beforeTrust - streams.length);
    log.info(`[debrid] ${beforeTrust - streams.length} magnet(s) com histórico ruim descartado(s) antes da checagem`);
  }
  if (streams.length === 0) return streams;

  // Só quem ainda é torrent tem hash pra consultar; stream já resolvido não entra no lote.
  const hashes = streams.map((s: any) => s.infoHash).filter(Boolean);
  if (hashes.length === 0) return streams;

  // A escolha dos candidatos vem antes da checagem (cada hold protege o hash da
  // limpeza); o disparo, depois — só aí sabemos se falta dublado em cache.
  const candidates = autoFetchCandidates(streams, { season, imdbId, searchKey });
  const checkStarted = Date.now();
  // Teto dinâmico: o que resta do REPLY_DEADLINE menos margem para serialização.
  // null = sem teto (passe tardio usa o timeout completo do adaptador).
  // <=0 degrada na hora para known:false sem rede.
  const timeoutMs = remainingCheckBudget(
    deadlineAt,
    checkStarted,
    config.debrid.checkFormatMargin,
  );
  const { cached, known, unusable } = await debrid.checkCached(
    hashes,
    timeoutMs != null ? { timeoutMs } : {},
  );
  const checkMs = Date.now() - checkStarted;
  const needsFullRefresh = adapter.cacheCheck && !known && !unusable;
  // Chave recusada ou conta cheia: a lista inteira sairia como `[AD download]`
  // apontando para o /resolve, e TODO play morreria lá — os dois casos barram o
  // upload, que é como o serviço resolve. Como torrent puro ela ao menos toca.
  // O autofetch também não roda: enfileirar download numa conta que recusa
  // upload só gera erro em série.
  if (unusable) {
    // Conta cheia ou chave recusada: ninguém será baixado — enfileirar download
    // numa conta que recusa upload só gera erro em série. Libera todos os holds
    // para que os hashes voltem à limpeza normal.
    releaseAllHolds(candidates);
    if (onCacheResult) onCacheResult({ known, needsFullRefresh: false, autofetchCount: 0 });
    log.warn(
      `[debrid] ${adapter.label} indisponível (${unusable.reason}); ` +
        `${streams.length} stream(s) devolvido(s) como P2P (sem ⚡)`,
    );
    return streams;
  }

  // Dedupe por inventário para adaptadores sem cacheCheck (Real-Debrid / Debrid-Link)
  let cachedForAutofetch = cached;
  let knownForAutofetch = known;
  if (!adapter.cacheCheck && adapter.autofetchSource) {
    const peek = debrid.inventoryPeek(adapter, opts().debridApiKey);
    if (peek) {
      cachedForAutofetch = new Set(peek.map((i) => String(i.infoHash || '').toLowerCase()));
      knownForAutofetch = true;
    } else {
      knownForAutofetch = false;
      debrid.inventory().catch((err: any) =>
        log.warn(`[${adapter.id}] aquecimento de inventário em fundo falhou:`, err?.message || err),
      );
    }
  }

  const autofetchCount = autoFetchBrDubbed(streams, candidates, {
    cached: cachedForAutofetch,
    known: knownForAutofetch,
    season,
    episode,
    imdbId,
    searchKey,
  });
  if (onCacheResult) onCacheResult({
    known,
    needsFullRefresh,
    ...(autofetchCount ? { autofetchCount } : {}),
  });
  const ep = season != null && episode != null ? `?s=${season}&e=${episode}` : '';
  const viaDebrid = (s: any, instant: boolean) => {
    // Pack multi-obra: o /resolve precisa saber que aqui NÃO vale cair no maior
    // arquivo. Vai dentro da dica, então está coberto pela assinatura.
    const hint = workHint && s._multiWork ? { ...workHint, p: 1 } : workHint;
    const hintJson = hint ? JSON.stringify(hint) : '';
    // Assinatura cobre hash + temporada/episódio + dica: sem ela o /resolve
    // rejeita, então conhecer a PUBLIC_URL e um hash não basta pra gastar o
    // debrid — nem pra adulterar a escolha de arquivo.
    const sig = signResolve(s.infoHash, ep, hintJson);
    return {
      ...s,
      // Formato do Torrentio: [AD⚡] toca na hora, [AD download] ainda baixa.
      name: markDebridName(s.name, adapter.short || adapter.id, instant),
      url:
        `${publicUrl}${prefix()}/resolve/${s.infoHash}${ep}${ep ? '&' : '?'}` +
        `${hintJson ? `w=${encodeURIComponent(hintJson)}&` : ''}sig=${sig}`,
      infoHash: undefined,
      sources: undefined,
    };
  };

  // Serviço que não sabe informar cache (Real-Debrid, Debrid-Link) ou resposta
  // incompleta (lote perdido no timeout): filtrar por "somente em cache"
  // esconderia a lista inteira. Mandamos tudo pelo debrid — a resolução no play
  // dirá se toca ou não. O ⚡ vai só em quem foi confirmado: numa resposta
  // parcial os demais são "não perguntei", não "não tem", e viram "download".
  if (!known) {
    // Antes só virava log: o contador é o que deixa a degradação visível no
    // /metrics.json sem precisar reler saída do container.
    metrics.count('debrid.check.unknown');
    const tetoInfo = timeoutMs != null ? `, teto ${timeoutMs}ms` : '';
    log.info(
      `[debrid] ${adapter.label} sem resposta completa de cache em ${checkMs}ms${tetoInfo}; ${streams.length} stream(s) via debrid` +
        (cached.size ? ` (${cached.size} confirmado(s) em cache)` : ''),
    );
    return streams.map((s: any) => viaDebrid(s, cached.has(s.infoHash)));
  }

  // O tempo entra no log porque ele é o que decide o teto: a checagem divide o
  // REPLY_DEADLINE com a coleta e disputa o event loop com os resolvedores BR,
  // que rodam neste mesmo processo.
  const tetoInfo = timeoutMs != null ? `, teto ${timeoutMs}ms` : '';
  log.info(`[debrid] ${cached.size}/${streams.length} em cache no ${adapter.label} (${checkMs}ms${tetoInfo})`);
  const filtered = filterKnownCache(streams, cached, {
    cachedOnly,
    showUncachedBr,
    brReservedSlots,
  });
  const { visibleBr } = filtered;
  if (visibleBr.size) {
    log.info(`[debrid] ${visibleBr.size} fonte(s) BR fora do cache mantida(s) como P2P`);
  }
  const out: Stream[] = [];
  for (const s of filtered.streams) {
    if (s.infoHash && cached.has(s.infoHash)) {
      out.push(viaDebrid(s, true));
      continue;
    }
    // Fora do cache o padrão é devolver o torrent puro: não gasta a conta do
    // usuário sem ele pedir. Só que cliente que não toca infoHash descarta
    // esses streams, e num título sem nada em cache a lista inteira some da
    // tela. Com resolveUncached eles saem pelo /resolve, marcados
    // "[AD download]" — o play é quem adiciona o magnet.
    if (config.debrid.resolveUncached) {
      out.push(viaDebrid(s, false));
      continue;
    }
    out.push(s);
  }
  return out;
}

// Buscas idênticas simultâneas (Stremio pede stream de vários clientes) compartilham a mesma promise.
const inFlight = new Map();

// Refresh de fundo do stale-while-revalidate: mapa PRÓPRIO, separado do
// inFlight — a revalidação não coalesce com a busca síncrona do cliente nem a
// impede de começar; e uma busca síncrona em voo já reescreve o cache fresco.
const refreshing = new Map();

/**
 * A lista tem play de verdade: pelo menos um stream com url ou infoHash. O
 * item de aviso carrega só name + externalUrl. O `complete` do finish e a
 * elegibilidade do SWR usam o MESMO teste, senão os critérios divergem e o
 * stale serviria uma lista que nunca deveria ter sido promovida a completa.
 */
function hasPlayableStream(streams: any[]) {
  return Array.isArray(streams) && streams.some((s) => s && (s.url || s.infoHash));
}

async function collectRaw(
  query: string,
  type: string,
  imdbId: string,
  ptQuery: string | null,
  matchContext: MatchContext,
  onLate: ((items: any[], grew: boolean, partial?: boolean) => any) | null,
  sweepQuery: string | null = null,
) {
  const { providers } = opts();
  const mode = providers.includes('both') ? 'both' : providers[0] || config.provider;
  const tasks: { promise: Promise<any>; priority: boolean }[] = [];
  const addTask = (promise: Promise<any>, priority = false) => tasks.push({ promise, priority });
  let sweepInline = false;

  if (mode === 'demo') {
    return {
      items: await demo.search({ type, imdbId }), partial: false, completion: Promise.resolve(), sweepInline: false,
    };
  }

  const wants = (name: string) => mode === 'both' || providers.includes(name);
  const selectedIndexers: string[] = [...new Set((opts().jackettIndexers || []).filter((id: any) =>
    SAFE_INDEXER_ID.test(String(id)),
  ))].map(String);

  // demo sempre disponível como fallback de teste se quiser both+demo — aqui só jackett/prowlarr
  if (wants('jackett')) {
    if (selectedIndexers.length === 0) {
      addTask(jackett.search(query, type));
    } else {
      const plan = planJackettQueries(
        query,
        ptQuery,
        selectedIndexers,
        config.jackett.ptBrIndexers,
        config.jackett.slowIndexers,
        sweepQuery,
      );
      for (const planned of plan) {
        const priority = planned.indexers.some((indexer) =>
          config.jackett.ptBrIndexers.includes(indexer),
        );
        const inlineSweep = Boolean(sweepQuery) && sweepQuery !== query && planned.query === sweepQuery;
        if (inlineSweep) sweepInline = true;
        addTask(jackett.search(planned.query, type, planned.indexers, {
          fallbackQuery: planned.fallback,
          variantQuery: planned.variant,
          matchContext,
          // A mesma busca principal atualiza o status deste indexer. Falha da
          // variante pt-BR não pode sobrescrever aquele resultado como offline.
          recordStatus: inlineSweep ? false : undefined,
        }), priority);
      }
    }
  }
  if (wants('prowlarr')) {
    addTask(prowlarr.search(query));
  }

  // Se misconfigurou PROVIDER, tenta jackett
  const validProvider = providers.some((name: string) => ['jackett', 'prowlarr', 'demo', 'both'].includes(name));
  if (tasks.length === 0 && providers.length > 0 && !validProvider) {
    addTask(jackett.search(query, type));
  }

  // Fonte BR dublada, independente do PROVIDER: entra no mesmo allSettled,
  // então se o site cair ou demorar, o resto da busca sai normalmente.
  if (config.bludv.enabled) {
    // Sites BR indexam por título pt-BR ("Coringa", não "Joker").
    addTask(bludv.search(ptQuery || query), true);
  }

  // A conta do debrid como fonte: o que já está pronto lá entra com ⚡ sem
  // indexer nenhum. Teto curto dentro da própria tarefa (ver account.js)
  // para a primeira leitura não segurar a resposta.
  if (config.debrid.inventorySource && debrid.current()) {
    addTask(account.search(matchContext));
  }

  // Orçamento menor que o deadline da resposta: o resto do tempo é da checagem
  // no debrid, que ainda precisa rodar em cima do que foi coletado.
  const budget = Math.max(1000, config.replyDeadline - config.debridReserve);
  // A graça sai da reserva, mas nunca invade o piso configurado pro debrid. No
  // caso
  // medido de Disclosure Day, a primeira fonte BR chegava pouco depois dos 5s;
  // sem esta janela a UI ficava para sempre com os 11 globais do passe parcial.
  // Série também precisa dela (medido em A Casa do Dragão: os BR terminavam a
  // 5,9-8,7s e o E01 dublado nunca entrava na primeira resposta), mas SÓ com
  // itens no balde: balde vazio cai no fallback de pack, e consumir a graça
  // nessa hora roubaria o tempo dele.
  const priorityGrace = Math.min(
    config.brPartialGrace,
    Math.max(0, config.debridReserve - config.debridCheckFloor),
  );
  let watchLate = false;
  let firstLateBatch = false;
  let lateQueue = Promise.resolve();
  const collected = await collectWithinWindow(tasks, {
    budgetMs: budget,
    priorityGraceMs: priorityGrace,
    graceRequiresItems: type !== 'movie',
    onError: (err) => log.warn('[search] provider falhou:', err?.message || err),
    onBatch: (batch, allItems) => {
      if (!watchLate || firstLateBatch || !batch.length || !onLate) return;
      firstLateBatch = true;
      const snapshot = [...allItems];
      log.info(`[search] primeira fonte tardia chegou; recacheando ${snapshot.length} resultado(s)`);
      // Atualiza cedo a lista que o cliente está repetindo, mas mantém partial:
      // outros indexers ainda trabalham e a promoção definitiva vem abaixo.
      lateQueue = Promise.resolve(onLate(snapshot, true, true)).catch((err) => {
        log.warn('[search] passe tardio intermediário falhou:', err?.message || err);
      });
    },
  });
  const bucket = collected.items;
  const done = collected.done;
  let completion = collected.completion;

  if (!done) {
    if (collected.prioritySeen && priorityGrace) {
      log.info(`[search] primeira fonte BR incluída na janela extra de até ${priorityGrace}ms`);
    }
    log.warn(`[search] orçamento de ${budget}ms esgotado; seguindo com ${bucket.length} resultado(s) parcial(is)`);
    // Os providers continuam trabalhando depois que a resposta sai. Quem paga
    // esse atraso são justamente as fontes BR (raspam WordPress e ainda seguem
    // protetor de link): descartar o que elas trouxeram atrasadas obrigava o
    // usuário a fechar e reabrir a lista pra vê-las. Aqui o resultado completo
    // reescreve o cache, então a próxima chamada do Stremio já vem cheia.
    const soFar = bucket.length;
    if (onLate) {
      watchLate = true;
      completion = collected.completion
        .then(() => lateQueue)
        .then(() => {
          const grew = bucket.length > soFar;
          if (grew) {
            log.info(`[search] fontes lentas chegaram: ${soFar} → ${bucket.length} resultado(s); recacheando`);
          }
          // Mesmo sem nada novo o passe tardio precisa avisar: a lista servida
          // saiu marcada como parcial (cacheMaxAge 0) e, sem esta chamada, ela
          // ficava parcial até o TTL expirar — o cliente repergunta em loop e
          // nunca recebe uma resposta que possa guardar.
          return onLate(bucket, grew, false);
        })
        .catch((err) => log.warn('[search] passe tardio falhou:', err?.message || err));
    }
  }
  // `partial` acompanha o lote até a resposta HTTP: quem recebe uma lista
  // incompleta não pode cacheá-la por 15 minutos (ver o handler em addon.js).
  return { items: bucket, partial: !done, completion, sweepInline };
}

async function findStreams({ type, id, background }: { type: string; id: string; background?: boolean }) {
  if (!background) {
    noteUserRequest();
  }
  if (!id || !String(id).startsWith('tt')) {
    return { streams: [], partial: false };
  }
  if (!background) {
    metrics.count('stream.request');
  } else {
    metrics.count('autofetch.prefetch');
  }

  // A config do usuário entra na chave: dois install URLs com qualidades ou
  // debrid diferentes não podem compartilhar o mesmo resultado cacheado.
  // A URL de play leva a configuração e a assinatura da conta que construiu o
  // stream. Compartilhar cache entre duas API keys entregaria a URL (e a conta)
  // do primeiro usuário ao segundo; o digest isola sem persistir a credencial.
  // É configuração do operador, mas muda url/infoHash de cada stream e por
  // isso precisa fazer parte do shape persistido como as opções da instalação.
  const requestOpts = opts();
  const cacheKey = streamsCacheKey(type, id, { ...requestOpts, resolveUncached: config.debrid.resolveUncached });
  if (type === 'series' && requestOpts.debridApiKey) {
    const { imdbId, season } = parseStremioId(id);
    const adapter = debrid.current();
    if (season != null && adapter) {
      registerSeasonSearchKey(adapter.id, accountScope(requestOpts.debridApiKey), imdbId, season, cacheKey);
    }
  }
  // getWithStale em vez de get(): o get() APAGA a entrada expirada, e é
  // justamente ela que o SWR quer servir enquanto o refresh de fundo roda.
  // Graça 0 restaura a semântica dura anterior (kill-switch).
  const grace = config.streamStaleGrace;
  const hit = grace > 0
    ? cache.getWithStale(cacheKey, grace)
    : (() => {
        const value = cache.get(cacheKey);
        return value ? { value, stale: false } : null;
      })();
  if (hit) {
    const cached = hit.value;
    // O cache em SQLite sobrevive ao deploy, e a versão anterior gravava só o
    // array de streams. Sem esta linha, a primeira subida serviria `undefined`
    // por até 15 minutos em cima das entradas antigas.
    if (Array.isArray(cached)) {
      if (background && (!cached.length || onlyNotice(cached))) metrics.count('autofetch.prefetch.empty');
      return { streams: cached, partial: false };
    }
    if (!hit.stale) {
      if (background && (!cached?.streams?.length || onlyNotice(cached?.streams))) {
        metrics.count('autofetch.prefetch.empty');
      }
      return cached;
    }
    // Expirada DENTRO da janela de graça: responde na hora e revalida em
    // fundo. Só entra lista completa com debrid conferido e stream tocável —
    // aviso e parcial estenderiam o estado ruim em vez de consertá-lo.
    if (staleRefreshEligible(cached)) {
      metrics.count('search.swr.served');
      scheduleStaleRefresh(cacheKey, { type, id }, capture());
      if (background && (!cached?.streams?.length || onlyNotice(cached?.streams))) {
        metrics.count('autofetch.prefetch.empty');
      }
      return cached;
    }
    // Inelegível: cai na busca síncrona abaixo; a entrada velha fica no cache
    // até a reescrita (getWithStale não apaga).
  }

  // deadlineAt é compartilhado entre o passo de resposta e a checagem de cache:
  // a coleta não pode consumir tudo e deixar zero pro debrid. Passado adiante
  // como parte do input do builder, só o passo de resposta carrega — o passe
  // tardio (late/onBatch) chama finish sem deadlineAt e usa o timeout completo.
  const deadlineAt = Date.now() + config.replyDeadline;

  let task = inFlight.get(cacheKey);
  if (!task) {
    // Mede até a RESPOSTA — que é onde `doSearch` resolve. A coleta pode
    // continuar depois disso (fontes BR não cabem no orçamento), e esse rabo é
    // medido separado, em `search.late`: juntar os dois num número só faria a
    // busca fria parecer lenta e a quente parecer rápida pelo motivo errado.
    const done = metrics.timed('search.response');
    task = doSearch({ type, id, cacheKey, deadlineAt }).finally(() => {
      inFlight.delete(cacheKey);
      done();
    });
    // Se ninguém estiver ouvindo quando ela terminar, o resultado ainda vai pro cache;
    // o catch evita unhandled rejection depois que o deadline devolveu [].
    task.catch((err: any) => log.warn('[search] falhou em background:', err.message));
    inFlight.set(cacheKey, task);
  } else {
    metrics.count('stream.coalesced');
  }

  // O cliente Stremio aborta em 10s. Devolvemos vazio antes disso em vez de
  // estourar o timeout dele — a busca continua e popula o cache pra próxima.
  const res: any = await raceWithDeadline(task, config.replyDeadline, () => {
    // Contador separado do timer: a busca que estoura o prazo termina depois e
    // entra no p95 como sucesso lento. Só isto conta quantas vezes o CLIENTE
    // recebeu lista parcial.
    metrics.count('search.deadline');
    log.warn(`[search] deadline de ${config.replyDeadline}ms atingido para ${id}; segue em background`);
    // Quarto estado do aviso, e o único que NÃO sai do buildStreams: aqui a busca
    // nem terminou, enquanto os outros três explicam uma lista que ficou vazia
    // depois de buscar. Vale para filme também — a coleta segue para os dois, e a
    // próxima pergunta pega o cache já preenchido.
    const streams = config.search.noticeStream
      ? [{ name: 'Procurando fontes — reabra em instantes', notice: true }]
      : [];
    return { streams, partial: true };
  });

  if (background && (!res?.streams?.length || onlyNotice(res.streams))) {
    metrics.count('autofetch.prefetch.empty');
  }
  return res;
}

/**
 * O refresh sem teto só pode ser dispensado quando a entrada cacheada nasceu de
 * uma checagem de cache CONFIÁVEL. `partial:false` sozinho não prova isso: ele
 * diz que a coleta acabou, não que alguém perguntou ao debrid.
 *
 * A diferença aparecia inteira na AllDebrid, cuja consulta disputa o prazo sem
 * poder ser abortada (o /magnet/instant morreu; checar é dar upload). Quando a
 * corrida perdia, a busca respondia sem ⚡ e o passe tardio promovia essa mesma
 * lista a completa; o refresh — que existe justamente pra
 * recuperar o ⚡ — desistia ao ver `partial:false`. Resultado: raio nenhum, e a
 * lista sem raio cacheada como boa por CACHE_TTL.
 *
 * Entrada antiga (gravada antes deste campo existir) não tem `debridKnown`:
 * cai em `false` de propósito, paga UMA checagem tardia e se corrige sozinha.
 */
function debridRefreshSatisfied(entry: any) {
  return Boolean(entry && entry.partial === false && entry.debridKnown === true);
}

/** SWR só serve o que o finish promoveria a completa + checagem confiável. */
function staleRefreshEligible(entry: any) {
  return debridRefreshSatisfied(entry) && hasPlayableStream(entry?.streams);
}

/**
 * Resposta já saiu; a revalidação roda em fundo sem prazo de cliente. Erro
 * só vira log — nunca afeta quem recebeu a lista stale.
 */
function scheduleStaleRefresh(cacheKey: string, { type, id }: { type: string; id: string }, requestCtx: any) {
  if (refreshing.has(cacheKey)) return;
  // Busca síncrona da mesma chave já em voo reescreve o cache fresco: o
  // refresh seria trabalho duplicado.
  if (inFlight.has(cacheKey)) return;
  refreshing.set(cacheKey, true);
  metrics.count('search.swr.scheduled');
  // Fora do AsyncLocalStorage da requisição: sem restaurar o contexto,
  // opts() leria os defaults do .env e o refresh regravaria o cache com a
  // config ERRADA — mesmo padrão do runRecheck. Sem contexto capturado,
  // roda com os defaults mesmo (caso de teste/chamada fora de request).
  const ctx = requestCtx || { opts: opts(), encoded: '' };
  Promise.resolve(run(ctx, async () => {
    // Revalida antes de pagar a busca: passe tardio, recheck do autofetch ou
    // outra requisição podem ter reescrito a entrada fresca nesse meio tempo.
    const current = cache.getWithStale(cacheKey, config.streamStaleGrace);
    if (current && !current.stale) return;
    const started = Date.now();
    // Sem deadlineAt encurtado: passe de fundo tem o orçamento completo.
    await doSearch({ type, id, cacheKey, deadlineAt: Date.now() + config.replyDeadline });
    metrics.observe('search.swr', Date.now() - started);
  }))
    .catch((err) => log.warn('[search] refresh SWR falhou:', err?.message || err))
    .finally(() => refreshing.delete(cacheKey));
}

async function doSearch({ type, id, cacheKey, deadlineAt }: { type: string; id: string; cacheKey: string; deadlineAt: number }) {
  const isDemo = opts().providers.includes('demo');
  const { imdbId, season, episode } = parseStremioId(id);
  // Cinemeta e TMDB em paralelo: o título pt-BR não pode atrasar a busca.
  const [meta, titles] = await Promise.all([getMeta(type, imdbId), tmdb.getTitles(imdbId)]);
  // Cinemeta é a fonte preferida, mas ele volta 404 em título obscuro/regional
  // ou lançamento novo demais — ver `resolveSearchNames`.
  const searchMeta = resolveSearchNames({ meta, titles, imdbId });
  const query = buildSearchQuery(searchMeta, { season, episode });

  // Só vale uma query separada quando o título PT difere do original.
  const ptQuery =
    titles?.pt && titles.pt !== titles.original
      ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season, episode })
      : null;
  const providerMode = opts().providers.includes('both') ? 'both' : opts().providers[0] || config.provider;
  const wantsJackettSweep =
    providerMode !== 'demo' && (providerMode === 'both' || opts().providers.includes('jackett'));
  const sweepQuery = config.jackett.ptSweepGlobal && wantsJackettSweep
    ? ptSweepQueryFor({ titles })
    : null;
  // Refresh de debrid e varredura pt-BR compartilham uma fila tardia para não
  // executar applyDebrid/upload concorrentes na mesma chave.
  let tail = Promise.resolve();
  const enqueueTail = (task: () => any) => {
    tail = tail.then(() => new Promise((resolve) => {
      const handle = setImmediate(async () => {
        try {
          await task();
        } catch (err) {
          // A fila é genérica: um task sem try/catch próprio derrubaria o processo.
          log.warn('[search] tarefa tardia falhou:', err?.message || err);
        } finally {
          resolve();
        }
      });
      handle.unref();
    }));
    return tail;
  };

  log.info(
    `[search] ${type} ${id} → "${query}"${ptQuery ? ` | pt-BR: "${ptQuery}"` : ''} via ${opts().providers.join('+')}`,
  );

  // Fecha o pipeline sobre um lote de resultados brutos. É chamado duas vezes na
  // busca fria: com o que chegou dentro do prazo e, depois, com o lote completo
  // quando as fontes lentas terminam (aí só pra reescrever o cache).
  const finish = createLatestWriter(
    async ({ items, partial, deadlineAt: inputDeadline }) => {
      let needsDebridRefresh = false;
      let autofetchCount = 0;
      const streams = await buildStreams(items, {
        meta, titles, imdbId, season, episode, isDemo, searchKey: cacheKey,
        deadlineAt: inputDeadline,   // presente SÓ no passo de resposta
         onDebridResult: (result: any) => {
           needsDebridRefresh = needsDebridRefresh || result.needsFullRefresh;
           autofetchCount += result.autofetchCount || 0;
         },
      });
      return { streams, partial, needsDebridRefresh, autofetchCount };
    },
    ({ streams, partial, needsDebridRefresh }) => {
      // Resultado vazio pode ser indexer temporariamente fora — cacheia por pouco
      // tempo. Lote parcial idem: o passe tardio reescreve, mas se ele falhar o
      // TTL curto evita servir a lista sem as fontes BR por 15 minutos.
      const complete = hasPlayableStream(streams) && !partial && !needsDebridRefresh;
      // `debridKnown` registra se ESTA lista nasceu de uma checagem de cache
      // confiável. Sem ele, `partial:false` era usado como prova de "já
      // processado" — e o passe tardio promove a entrada SEM refazer a
      // checagem, o que congelava a lista sem ⚡ pelo TTL inteiro.
      cache.set(
        cacheKey,
        { streams, partial, debridKnown: !needsDebridRefresh },
        complete ? config.cacheTtl : Math.min(config.cacheTtl, 60),
      );
      log.info(`[search] ${streams.length} stream(s)${partial ? ' (parcial)' : ''} para ${id}`);
    },
    (value) => Array.isArray(value?.streams) && value.streams.length > 0,
  );

  /**
   * Fim da coleta. Se as fontes lentas trouxeram algo, reconstrói tudo; se não
   * trouxeram, só promove a entrada do cache a completa — sem refazer a
   * checagem no debrid, que é a parte cara e não mudaria de resposta.
   */
  const late = (items: any[], grew: boolean, phase: any, partial = false) => {
    if (grew) return finish({ items, partial }, phase);
    if (partial) return undefined;
    // Fase diferente = o fallback de pack assumiu; promover o lote antigo aqui
    // marcaria como pronta uma busca que ainda está em andamento.
    if (phase !== finish.phase()) return undefined;
    const hit = cache.get(cacheKey);
    if (!hit?.partial) return undefined;
    // Promover NÃO refaz a checagem de cache, então `debridKnown` é copiado
    // como está: promessa de completude da COLETA não é promessa de ⚡.
    const debridKnown = hit.debridKnown === true;
    cache.set(
      cacheKey,
      { streams: hit.streams, partial: false, debridKnown },
      debridKnown ? config.cacheTtl : Math.min(config.cacheTtl, 60),
    );
    log.info(`[search] coleta encerrada sem novidade; ${hit.streams.length} stream(s) para ${id}`);
    return undefined;
  };

  const matchContext = {
    names: searchMeta.names,
    year: searchMeta.year,
    isSeries: season != null,
    season,
    episode,
  };
  const episodePhase = finish.phase();
  let raw = await collectRaw(query, type, imdbId, ptQuery, matchContext, (items: any[], grew: boolean, partial?: boolean) =>
    late(items, grew, episodePhase, partial),
    sweepQuery,
  );

  // Série sem candidato útil por episódio tenta o pack. Lote parcial não-vazio
  // ainda pode receber a fonte BR no passe tardio; só ampliamos o gatilho antigo
  // quando a coleta terminou e o filtro compartilhado provou que tudo era lixo.
  const relevant = filterRelevantRaw(raw.items, matchContext);
  // Fraqueza do episodio: ninguem alcanca o piso de seeders. Avaliada sobre o
  // lote informado; no gatilho TARDIO ela e recalculada depois da coleta
  // fechar, porque um lote parcial ainda pode receber a release saudavel.
  //
  // Idioma estrangeiro explicito NAO conta como saudavel: medido em Lost Girl
  // S01E01, um "FRENCH HDTV" de 12 seeders passava do piso sozinho e desligava
  // a busca de pack, deixando o usuario com frances, holandes e 272p. A guarda
  // poupa MULTI/DUAL (carregam a faixa original) e qualquer marca PT. Isso muda
  // so o GATILHO: a release estrangeira continua saindo na lista, porque em
  // titulo sem mais nada ela ainda e a unica opcao.
  const isHealthy = (item: any) => {
    const title = item.title || item.Title || '';
    return Number(item.seeders ?? item.Seeders ?? 0) >= config.search.packMinSeeders &&
      !hasExplicitForeignAudio(title);
  };
  const episodeIsWeak = (items: any[]) => {
    const rel = items === raw.items ? relevant : filterRelevantRaw(items, matchContext);
    return rel.length > 0 && !rel.some(isHealthy);
  };
  const needsPack = raw.items.length === 0 || (!raw.partial && relevant.length === 0);
  let usedPackFallback = false;
  if (needsPack && season != null && !isDemo) {
    usedPackFallback = true;
    // O passe tardio da busca por episódio não pode sobrescrever o pack que
    // estamos prestes a buscar. `advance` invalida qualquer escrita antiga,
    // inclusive uma build que já começou e ainda está no debrid.
    const packPhase = finish.advance();
    const s = String(season).padStart(2, '0');
    // Mesmo fallback da query principal: sem Cinemeta o pack virava "tt123 S01".
    const packQuery = `${searchMeta.name} S${s}`;
    // O fallback também precisa do título pt-BR: é justamente aqui, quando a
    // busca por episódio falhou, que as fontes BR (que só publicam pack de
    // temporada) teriam algo — e elas não indexam pelo nome em inglês.
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    log.info(
      `[search] sem resultados; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`,
    );
    raw = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, (items: any[], grew: boolean, partial?: boolean) =>
      late(items, grew, packPhase, partial),
      sweepQuery,
    );
  }

  const responsePhase = finish.phase();
  if (raw.sweepInline) metrics.count('search.pt-sweep.inline');
  const result = await finish({ ...raw, deadlineAt }, responsePhase);

  // O episódio fraco já ocupou o caminho crítico; o pack é uma segunda busca
  // complementar no tail. Mesclar, em vez de substituir, preserva releases do
  // episódio e permite ao autofetch escolher o swarm saudável do pack.
  if (config.search.packTail && !usedPackFallback && season != null && !isDemo) {
    const s = String(season).padStart(2, '0');
    const packQuery = `${searchMeta.name} S${s}`;
    const ptPackQuery = ptQuery && titles?.pt ? `${titles.pt} S${s}` : null;
    enqueueTail(async () => {
      const started = Date.now();
      try {
        // Lote parcial nao decide nada: com Jackett frio a coleta estoura o
        // orcamento e a release saudavel pode chegar depois da resposta. Quem
        // julga e o balde ja estabilizado — mesmo padrao da varredura pt-BR.
        if (raw.partial && raw.completion) await raw.completion;
        if (!episodeIsWeak(raw.items)) return;
        metrics.count('search.pack-tail.run');
        log.info(`[search] sem candidato saudável; tentando pack "${packQuery}"${ptPackQuery ? ` | pt-BR: "${ptPackQuery}"` : ''}`);
        const pack = await collectRaw(packQuery, type, imdbId, ptPackQuery, matchContext, null, sweepQuery);
        if (pack.partial && pack.completion) await pack.completion;
        const known = new Set(raw.items.map((item) => extractInfoHash(item.infoHash || item.magnet)).filter(Boolean));
        const fresh = pack.items.filter((item) => {
          const hash = extractInfoHash(item.infoHash || item.magnet);
          return hash && !known.has(hash);
        });
        if (!fresh.length) return;
        raw.items.push(...fresh);
        metrics.count('search.pack-tail.hit');
        log.info(`[search] pack tardio trouxe ${fresh.length} resultado(s) novo(s); recacheando`);
        await finish({ items: raw.items, partial: false }, responsePhase);
      } finally {
        metrics.observe('search.pack-tail', Date.now() - started);
      }
    });
  }

  // Quanto a coleta ainda levou DEPOIS de responder. É o número que diz se o
  // passe tardio virou a regra — e ele só existe quando a resposta saiu
  // parcial, então a contagem de `search.late` também é a contagem de buscas
  // que não couberam no orçamento.
  if (raw.partial && raw.completion) {
    const tailStarted = Date.now();
    raw.completion
      .then(() => metrics.observe('search.late', Date.now() - tailStarted))
      // A conclusão que falha já é logada por quem a criou; aqui ela só não
      // pode virar rejeição não tratada.
      .catch(() => {});
  }
  if (result.needsDebridRefresh) {
    // A primeira lista já pode sair como "download" dentro do prazo. Repetimos
    // o mesmo pós-processamento sem teto depois que a resposta foi liberada para
    // recuperar ⚡/cachedOnly no cache, mesmo se nenhum provider trouxer item novo.
    enqueueTail(async () => {
      try {
        // Se a coleta ainda estava aberta, esperamos o balde estabilizar. Assim
        // a checagem completa já grava partial:false e não pode rebaixar uma
        // promoção concorrente feita pelo callback de conclusão.
        if (raw.partial && raw.completion) await raw.completion;
        const refreshed = cache.get(cacheKey);
        // O passe tardio pode já ter reconstruído a mesma lista. Não
        // repetimos a consulta cara (e, na AllDebrid, o upload) sem necessidade.
        if (debridRefreshSatisfied(refreshed)) return;
        await finish({ items: raw.items, partial: false }, responsePhase);
      } catch (err) {
        log.warn('[search] atualização completa do debrid falhou:', err?.message || err);
      }
    });
  }

  // Varredura pt-BR nos indexers GLOBAIS: tracker global hospeda bastante
  // dublado titulado em português ("Jornada Nas Estrelas … Dublado") que a
  // query em inglês não encontra. Roda FORA do caminho da resposta (nunca
  // disputa o orçamento), com `recordStatus:false` para a segunda consulta
  // não poluir o card de status, e `ignoreBreaker:true` para consultar
  // mesmo indexer recém-derrubado — o dublado raro mora justamente ali.
  // Só adiciona hashes novos: título pt para hash já listado é assunto do
  // merge, não da varredura.
  const configuredIndexers = opts().jackettIndexers?.length ? opts().jackettIndexers : config.jackett.indexers;
  const sweepSelectedIndexers: string[] = [...new Set((configuredIndexers || []).filter((idx: any) =>
    SAFE_INDEXER_ID.test(String(idx)),
  ))].map(String);
  // A query já foi anexada ao plano crítico: título pt-BASE para filme e série,
  // sem subtítulo, ano ou SxxEyy. Os globais publicam episódios como
  // "T01 E004"; o matchContext faz o corte preciso depois da coleta.
  if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepQuery && sweepSelectedIndexers.length > 0) {
    const sweepTargets = ptSweepIndexers(sweepSelectedIndexers, config.jackett.ptBrIndexers);
    if (sweepTargets.length > 0) {
      if (raw.partial || !raw.sweepInline) enqueueTail(async () => {
        metrics.count('search.pt-sweep.run');
        const sweepStarted = Date.now();
        try {
          // Se a coleta ainda estava aberta, espera o balde estabilizar para o
          // inventário de hashes conhecidos não sair incompleto.
          if (raw.partial && raw.completion) await raw.completion;
          const found = await jackett.search(sweepQuery, type, sweepTargets, {
            matchContext,
            recordStatus: false,
            ignoreBreaker: true,
          });
          metrics.count('search.pt-sweep.found', found.length);
          if (!found.length) return;
          const known = new Set(
            raw.items.map((item) => extractInfoHash(item.infoHash || item.magnet)).filter(Boolean),
          );
          const fresh = found.filter((item: any) => {
            const h = extractInfoHash(item.infoHash || item.magnet);
            return h && !known.has(h);
          });
          if (!fresh.length) {
            // Achou, mas tudo já era conhecido: a métrica distingue "não
            // achou" de "achou e já tínhamos" — juntar os dois escondia o
            // caso real de "varredura está caindo cedo demais".
            metrics.count('search.pt-sweep.known');
            log.info(`[search] varredura pt-BR: ${found.length} resultado(s), nenhum novo (query "${sweepQuery}")`);
            return;
          }
          raw.items.push(...fresh);
          metrics.count('search.pt-sweep.hit');
          log.info(`[search] varredura pt-BR nos globais trouxe ${fresh.length} resultado(s) novo(s) (query "${sweepQuery}"); recacheando`);
          await finish({ items: raw.items, partial: false }, responsePhase);
        } catch (err) {
          log.warn('[search] varredura pt-BR nos globais falhou:', err?.message || err);
        } finally {
          metrics.observe('search.pt-sweep', Date.now() - sweepStarted);
        }
      });
    } else {
      log.debug('[search] varredura pt-BR não executada: nenhum indexer global selecionado');
    }
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && !sweepQuery) {
    log.debug('[search] varredura pt-BR não executada: não há query localizada ativa');
  } else if (config.jackett.ptSweepGlobal && wantsJackettSweep && sweepSelectedIndexers.length === 0) {
    log.debug('[search] varredura pt-BR não executada: nenhum indexer selecionado');
  }
  return result;
}

/**
 * Bruto dos providers → streams do Stremio: corte por título, por episódio,
 * ordenação, debrid e limite final.
 * @returns {Promise<import('../../types/domain').Stream[]>}
 */
async function buildStreams(
  rawInput: any[],
  { meta, titles, imdbId, season, episode, isDemo, searchKey, deadlineAt, onDebridResult }: any,
) {
  let raw = rawInput;
  let autofetchCount = 0;

  // No modo demo, se não for BBB, lista vazia (esperado)
  if (isDemo && raw.length === 0) {
    log.info('[search] modo demo: só tt1254207 (Big Buck Bunny) tem stream de teste');
  }

  // Aceita qualquer um dos nomes: release BR vem como "Coringa", a do Jackett
  // como "Joker" — filtrar só pelo inglês jogaria fora a fonte dublada.
  // As releases BR passam pelo filtro mais estrito (`matchesBrTitle`): os
  // buscadores WordPress devolvem posts "parecidos" ("Missão: Impossível –
  // Efeito Fallout" numa busca por "Fallout") que disputavam as vagas
  // reservadas com a fonte real.
  //
  // O gate é a existência de ALGUM nome, não do Cinemeta: quando ele volta 404
  // mas o TMDB responde, os nomes estão ali e o filtro precisa rodar. Preso a
  // `meta?.name` ele se desligava inteiro e a lista saía sem corte nenhum.
  const { names, year: catalogYear } = resolveSearchNames({ meta, titles });
  if (names.length && !isDemo) {
    const before = raw.length;
    // Itens do inventário da conta já passaram pelo filtro DELES no provider
    // (estrito + exceção de franquia, `filterInventoryRelevant`): re-aplicar
    // o estrito aqui mataria justamente o pack de franquia que a exceção
    // deixou passar ("FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS" para Star
    // Trek). Os nomes são os mesmos do matchContext que filtrou lá.
    const fromAccount = raw.filter((r: any) => r.fromAccount);
    const titleCtx = { names, year: catalogYear, isSeries: season != null };
    raw = fromAccount.length
      ? [...fromAccount, ...filterRelevantRaw(raw.filter((r: any) => !r.fromAccount), titleCtx)]
      : filterRelevantRaw(raw, titleCtx);
    if (before !== raw.length) log.info(`[search] ${before - raw.length} resultado(s) fora do título descartado(s)`);
  }

  // Guarda de coleção: pack multi-obra ("Todos os filmes 1979-2016") só é
  // oferecido quando alguém sabe escolher o arquivo certo dentro dele. Com
  // debrid, a dica de obra viaja assinada na URL e o pickFile escolhe; em P2P
  // o cliente baixaria o torrent inteiro e tocaria o MAIOR arquivo — quase
  // sempre o filme errado. Sem escolha por arquivo, o pack fica de fora.
  // Sem ano de catálogo, a dica assinada não consegue selecionar uma obra
  // dentro de uma coleção mesmo com debrid; retenha o pack nesse caso também.
  if (season == null && !isDemo && (!debrid.current() || !catalogYear)) {
    const beforePack = raw.length;
    raw = raw.filter((r: any) => !isMultiWorkCollection(r.title || r.Title || ''));
    if (beforePack !== raw.length) {
      log.info(`[search] ${beforePack - raw.length} pack(s) multi-obra retido(s) sem escolha por arquivo`);
    }
  }

  // Dica de obra para o pickFile no play (só filme): nomes + ano limpo. O ano
  // do catálogo vem sujo ("2024–" para série em andamento); sem extrair o
  // primeiro token de 4 dígitos a dica levaria NaN e o casamento falharia.
  const workHint = season == null && names.length
    ? {
      n: names.slice(0, 4),
      y: Number(String(catalogYear || '').match(/(?:19|20)\d{2}/)?.[0] || 0) || null,
    }
    : null;

  // Série: o indexer responde a "Nome S01E01" com a temporada inteira, então
  // sem este corte a lista do E01 vinha cheia de E03/E04/E09. Packs (título com
  // a temporada e sem episódio) passam — o debrid escolhe o arquivo no play.
  if (season != null && episode != null && !isDemo) {
    const before = raw.length;
    raw = raw.filter((r: any) => matchesEpisode(r.title || r.Title || '', { season, episode }));
    if (before !== raw.length) {
      log.info(`[search] ${before - raw.length} resultado(s) de outro episódio descartado(s)`);
    }
  }

  // Pool maior que MAX_RESULTS: o corte final é DEPOIS do debrid, senão fontes
  // sem seeders publicados (BLUDV) e não-cacheados ocupariam as vagas e sumiriam.
  const {
    minSeeders,
    maxResults,
    qualities,
    preferDubbed,
    excludeCam,
    maxSizeGb,
    max2160p,
    max1080p,
    max720p,
    max480p,
    maxSd,
    maxUnknown,
    maxPerIndexer,
    indexerLimits,
    brReservedSlots,
    brOnly,
    brFirst,
    indexerPriority,
  } = opts();
  const safeIndexerPriority = indexerPriority
    .filter((id: any) => SAFE_INDEXER_ID.test(String(id)))
    .slice(0, 100);
  const safeIndexerLimits: Record<string, number> = {};
  for (const [rawId, rawLimit] of Object.entries(indexerLimits || {}).slice(0, 100)) {
    const id = String(rawId).toLowerCase();
    if (!SAFE_INDEXER_ID.test(id)) continue;
    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) continue;
    safeIndexerLimits[id] = Math.min(20, Math.max(0, Math.trunc(limit)));
  }
  const qualityLimits = {
    '2160p': max2160p,
    '1080p': max1080p,
    '720p': max720p,
    '480p': max480p,
    SD: maxSd,
    // Balde separado do SD: as fontes BR não publicam resolução e zerar SD não
    // pode desligar a prioridade brasileira junto.
    [UNKNOWN_QUALITY]: maxUnknown,
  };
  // Tipado como Stream[] de propósito: é este array que `applyNoticeOrigin`
  // fecha como item de aviso e entrega ao Stremio. Um item sem `url`/`infoHash`/
  // `externalUrl` (e sem a marca interna `notice`) morre fora da união — o que
  // deixa explícito na origem o aviso que nenhum cliente renderizava.
  const mappedStreams = raw.map(toStremioStream);
  // Histórico durável do banco de magnets: quem o debrid desta conta comprovou
  // como play instantâneo ganha desempate acima dos seeders no sort.
  const aliveAdapter = debrid.current();
  const aliveApiKey = opts().debridApiKey;
  // `toStremioStream` devolve NULL para item sem infoHash (link que nenhum
  // resolvedor abriu), e `sortAndLimit` recebe `(Stream | null)[]` de propósito
  // — o buraco tem que ser filtrado ANTES do acesso, senão um único resultado
  // sem hash derruba a lista inteira com TypeError.
  const instantSet = aliveAdapter && aliveApiKey
    ? new Set(mappedStreams.map((s: any) => s?.infoHash).filter(Boolean)
        .filter((h: string) => magnetdb.isAlive(aliveAdapter.id, aliveApiKey, h)))
    : null;
  let streams: Stream[] = sortAndLimit(mappedStreams, {
    minSeeders,
    maxResults: maxResults * config.candidatePoolFactor,
    qualityFilter: qualities,
    season,
    episode,
    preferDubbed,
    excludeCam,
    maxSizeGb,
    qualityLimits,
    brReservedSlots,
    candidateFactor: config.candidatePoolFactor,
    brFirst,
    indexerPriority: safeIndexerPriority,
    instant: instantSet ? (h: string) => instantSet.has(String(h).toLowerCase()) : undefined,
  });

  // Contagem ANTES do debrid: `applyDebrid` já devolve a lista pós-cachedOnly,
  // então usar o retorno dele para decidir o aviso era medir depois do corte —
  // no caso que motivou o aviso (nada em cache) ele volta VAZIO e a condição
  // nunca ligava.
  const candidatesBeforeDebrid = streams.length;
  const beforeCut = await applyDebrid(streams, {
    season,
    episode,
    imdbId,
    searchKey,
    deadlineAt,
    onCacheResult: (result: any) => {
      autofetchCount += result.autofetchCount || 0;
      if (onDebridResult) onDebridResult(result);
    },
    workHint,
  });
  streams = limitReservingBr(beforeCut, {
    brReservedSlots,
    maxResults,
    brOnly,
    qualityLimits,
    brFirst,
    maxPerIndexer,
    indexerLimits: safeIndexerLimits,
  });

  // Tres estados, nesta ordem de precisao: ja mandamos baixar / achamos mas o
  // cachedOnly cortou / nao achamos nada ainda. O terceiro so vale para SERIE,
  // que e onde a busca tardia de pack roda de verdade — prometer "reabra em
  // instantes" num filme sem resultado seria mentira.
  const noticeText = () => {
    if (autofetchCount > 0) return '⏳ Baixando no debrid — reabra em alguns minutos';
    if (candidatesBeforeDebrid > 0) {
      return `Nenhuma fonte pronta — ${candidatesBeforeDebrid} resultado(s) fora do cache`;
    }
    if (season != null) return 'Nada pronto ainda — procurando a temporada; reabra em instantes';
    return null;
  };
  // Só o TEXTO nasce aqui: ele depende da busca (autofetch, cortados pelo
  // cachedOnly, temporada) e viaja para o cache junto com a lista. O link sai no
  // `applyNoticeOrigin`, na resposta — ver lá por que ele não pode ser montado
  // neste ponto.
  if (config.search.noticeStream && streams.length === 0) {
    const name = noticeText();
    if (name) streams = [{ name, notice: true }];
  }

  // "A dublada não ficou em cima" é a queixa mais comum e tem três causas
  // distintas (não veio da fonte / veio mas foi cortada / veio e ficou abaixo).
  // Sem este log as três são indistinguíveis a partir da lista final, porque o
  // corte apaga os campos internos que responderiam a pergunta.
  const brIn = beforeCut.filter((s: any) => s._br);
  const dubIn = brIn.filter((s: any) => s._dubbed);
  const head = streams.slice(0, 3).map((s) => (s.name || '').split('\n')[1] || '?').join(' / ');
  log.info(
    `[search] entrada do corte: ${beforeCut.length} stream(s), ${brIn.length} BR (${dubIn.length} dublada(s))` +
      ` | brFirst=${brFirst} preferDubbed=${preferDubbed} | topo: ${head}`,
  );

  return streams;
}

// `buildStreams` sai exportado pelo mesmo motivo do `applyDebrid`: e o unico
// jeito de testar o item de aviso sem subir uma busca inteira com Jackett.
/**
 * Fecha o aviso de lista vazia na RESPOSTA, com o origin de quem está
 * perguntando agora. O texto é conteúdo da busca e fica no cache; o link não
 * pode: `streamsCacheKey` não carrega o origin, então montá-lo dentro do
 * `buildStreams` gravava na entrada compartilhada o endereço do primeiro
 * cliente — a TV que chama 192.168.0.23 deixava esse link para o celular que
 * chama pelo domínio, e um `Host` forjado envenenava a entrada para o próximo.
 *
 * PUBLIC_URL (endereço público) tem precedência; sem ela vale o origin da
 * requisição, que por definição é um endereço que aquele cliente alcança.
 *
 * Sem origin nenhum (chamada interna, teste sem req) o item é DESCARTADO: sem
 * `url`/`infoHash`/`externalUrl` nenhum cliente Stremio renderiza a linha, então
 * ela só ocuparia a resposta e sumiria na tela — foi o que deixou o app com
 * "Nenhum stream disponível" enquanto a busca já tinha resultado.
 */
function applyNoticeOrigin(streams: Stream[] = []) {
  if (!streams.some((stream) => stream?.notice)) return streams;
  const base = (config.debrid.publicUrl || origin() || '').replace(/\/$/, '');
  const link = base ? `${base}${prefix()}/configure` : '';
  return streams.flatMap((stream) => {
    if (!stream?.notice) return [stream];
    if (!link) return [];
    // `notice` é marca interna: não faz parte do objeto que o Stremio recebe.
    const { notice, ...rest } = stream;
    return [{ ...rest, externalUrl: link }];
  });
}

/** A lista não tem resultado nenhum — só o aviso. */
function onlyNotice(streams: Stream[] = []) {
  return streams.length > 0 && streams.every((stream) => stream?.notice);
}

/** Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário. */
function autofetchStatus() {
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
    searchesInFlight: inFlight.size,
  };
}

export {
  findStreams, applyDebrid, buildStreams, debridRefreshSatisfied, applyNoticeOrigin, onlyNotice,
  autofetchStatus,
};
