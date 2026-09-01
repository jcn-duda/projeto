import crypto from 'node:crypto';
import config from '../config.js';
import autofetchLive from '../utils/autofetch-live.js';
import type { DebridAdapter, Stream, TorrentStatusEntry } from '../../types/domain.js';
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
import type { RuntimeContext } from '../runtime.js';
import * as autofetch from './autofetch.js';
import { classifyEnqueue, ENQUEUE_ROLLBACK, noteSkip, skipCountsSnapshot, warnAccountGated } from './autofetch-gates.js';
import type { SkipReason } from './autofetch-gates.js';
import * as autofetchTrace from '../utils/autofetch-trace.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { rdGate } from '../debrid/rd-gate.js';
import { isRateLimitError } from '../debrid/common.js';
import * as rdLedger from '../debrid/rd-ledger.js';

type AutoFetchStream = Stream & { infoHash: string };
type AutoFetchCandidate = { stream: AutoFetchStream; account: string; pool: string };
type AutoFetchRequest = {
  cached: Set<string>;
  season?: number | null;
  episode?: number | null;
  imdbId?: string | null;
  searchKey?: string | null;
};
type SeasonHint = { imdbId?: string | null; season?: number | null; isPack?: boolean };
type RecheckLot = {
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

  let candidates = pickBrDubbedCandidates(liveStreams, new Set(), totalMax, { season }).filter(isAutoFetchStream);
  let pool = 'br';
  const dubbedGlobal = candidates.length === 0
    ? pickAnyDubbedCandidates(liveStreams, new Set(), totalMax, { season }).filter(isAutoFetchStream)
    : [];
  if (dubbedGlobal.length > 0) {
    if (!live.autoFetchAnyDubbed) return [];
    candidates = dubbedGlobal;
    pool = 'any';
    metrics.count('autofetch.any-dubbed');
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
    trySlot: () => !searchKey || autofetch.acquireSearchSlot(searchKey, live.autoFetchMax),
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
        cache.set(key, 1, live.autoFetchTtl);
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

/**
 * Lotes de recheck pós-enfileiramento, por busca: hashes aceitos pelo debrid
 * aguardando ficar tocáveis, detecção de mortos e drenagem da fila.
 */
const recheckLots = new Map<string, RecheckLot>();

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

function manageSettleLru() {
  const settleLots: Array<{ key: string; createdAt: number; lot: RecheckLot }> = [];
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

function armRecheck(searchKey: string, lot: RecheckLot) {
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
      hashes: new Set<string>(),
      attempts: 0,
      timer: null,
      inFlight: false,
      ctx: requestCtx,
      deadStreak: new Map<string, number>(),
      stallStreak: new Map<string, number>(),
      seasonHints: new Map<string, SeasonHint>(),
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
  const live = autofetchLive.effective();
  if (!searchKey || !live.autoFetchQueue || autofetchLive.isPaused()) return;
  const queue = autofetch.readQueue(searchKey);
  if (!queue.length) return;
  const adapter = debrid.current();
  if (!adapter) return;
  const account = accountScope(opts().debridApiKey);
  if (autofetch.budgetBlockedUntil(adapter.id, account) > Date.now()) return;
  // O gate nega background durante cooldown. Verificar antes de `takeNext`
  // mantém a cabeça persistente, em vez de removê-la para falhar em seguida.
  if (adapter.id === 'realdebrid' && rdGate.isCoolingDown(account)) return;
  // Mesmo padrão da pausa por orçamento: a cabeça fica na fila intacta, sem
  // girar, até a conta voltar abaixo do limiar de ocupação.
  if (autofetch.accountGateBlocked(adapter, opts().debridApiKey)) return;

  const { next, remaining } = autofetch.takeNext(queue, (cand) => {
    const h = String(cand.infoHash).toLowerCase();
    return (
      autofetch.isDead(adapter.id, account, h) ||
      Boolean(cache.get(autofetch.markerKey(adapter.id, account, h))) ||
      held.isHeld(h, account) ||
      // Já está duravelmente protegido (no acervo): não há o que baixar de novo.
      held.isDurablyProtected(adapter.id, account, h)
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

  held.hold(h, live.autoFetchTtl, account);
  debrid.enqueue(h, { season: next.season, episode: next.episode })
    .then((ok) => {
      autofetch.release(mKey);
      if (ok) {
        cache.set(mKey, 1, live.autoFetchTtl);
        metrics.count('autofetch.queued');
        metrics.count('autofetch.enqueued');
        // Dreno da fila: proteção durável só quando o item de fila é o pool BR
        // com `br` e `dubbed` reais — o contrato de retenção do acervo.
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
        if (lot.refusals < config.debrid.autoFetchDrainMaxRefusals) {
          drainNext(searchKey, lot);
        }
      }
    })
    .catch((err) => {
      autofetch.release(mKey);
      held.release(h, account);
      if (adapter.id === 'realdebrid' && isRateLimitError(err)) {
        // O cooldown pode abrir entre o `takeNext` e a admissão no gate. O
        // candidato não foi recusado pelo torrent: volta para a FRENTE e a
        // próxima drenagem só acontece depois do cooldown.
        const current = autofetch.readQueue(searchKey);
        autofetch.writeQueue(
          searchKey,
          [next, ...current.filter((item) => String(item.infoHash).toLowerCase() !== h)],
          config.debrid.autoFetchQueueTtl,
          adapter.id,
          account,
        );
        metrics.count('autofetch.rdGateRequeued');
        log.info(`[autofetch] cooldown RD abriu durante o dreno; ${h} voltou à frente da fila`);
        return;
      }
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
      } catch (err: unknown) {
        log.warn(`[autofetch] falha na checagem de cache em ${adapter.id}:`, log.errorMessage(err));
      }
    }

    let statuses: Record<string, TorrentStatusEntry> = {};
    if (typeof adapter.torrentStatus === 'function') {
      try {
        statuses = await adapter.torrentStatus(opts().debridApiKey, [...lot.hashes]);
      } catch (err: unknown) {
        log.warn(`[autofetch] falha ao consultar torrentStatus em ${adapter.id}:`, log.errorMessage(err));
      }
    }

    for (const hash of [...lot.hashes]) {
      const statusInfo = statuses[hash];
      const isReady = (checkResult.known && checkResult.cached.has(hash)) || statusInfo?.state === 'ready';
      if (isReady) {
        // `torrentStatus: ready` no RD é confirmação do cache GLOBAL. O
        // ranking ainda não lê este ledger nesta fase; só preservamos a prova.
        if (adapter.id === 'realdebrid') rdLedger.noteHit([hash]);
        metrics.count('autofetch.ready');
        // Quanto tempo o download levou do enfileiramento ao pronto (hit-rate).
        // Duração é observe (janela com percentil), não somatório de count.
        metrics.observe('autofetch.ready-ms', Date.now() - (lot.createdAt || Date.now()));
        if (adapter.cacheCheck) {
          cache.forget(searchKey);
          // I2 — o hash pronto semeia o positivo do davail (⚡ na reabertura sem
          // repetir a consulta ao debrid) para QUALQUER obra, filme ou episódio,
          // não só pack. Fica DENTRO do `cacheCheck` de propósito: só quem
          // confere cache provou ready; RD/DL sem ledger não têm essa prova e
          // não semeiam (contrato T4a). `ready-note` conta o ready que semeia.
          debrid.noteAvailable(hash);
          metrics.count('autofetch.ready-note');
          const hint = lot.seasonHints.get(hash);
          const live = autofetchLive.effective();
          if (
            live.autoFetchSeasonFill &&
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
        // Confirmou PRONTO: assenta o registro durável (renova/grava readyAt)
        // e libera apenas o hold volátil — a proteção durável continua de pé.
        held.noteReady(adapter.id, account, hash);
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
          // Estado terminal (morto/parado) retira o BR do acervo retido:
          // sem unprotect, a proteção durável seguraria um hash que a conta
          // vai remover — resíduo que depois o wipe limpa.
          held.unprotect(adapter.id, account, hash);
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

    const liveAfter = autofetchLive.effective();
    if (!lot.isSettle && lot.attempts >= liveAfter.autoFetchRecheckMax) {
      lot.isSettle = true;
      manageSettleLru();
      armRecheck(searchKey, lot);
    } else if (lot.isSettle) {
      const ageMs = Date.now() - (lot.createdAt || 0);
      if (ageMs >= liveAfter.autoFetchTtl * 1000) {
        // Settle expirado: o download nunca ficou tocável dentro do prazo.
        metrics.count('autofetch.expired-unready', lot.hashes.size);
        if (typeof adapter.removeTorrent === 'function') {
          for (const h of lot.hashes) {
            const sid = statuses[h]?.id;
            if (sid != null) adapter.removeTorrent(opts().debridApiKey, sid).catch(() => {});
          }
        }
        // Settle expirado: o download nunca tocou dentro do prazo — sai junto a
        // proteção durável e o MARCADOR (H2): sem isso, um hash que nunca ficou
        // pronto bloqueava retentativa por até 6h — e ficava órfão até o TTL
        // se o processo reiniciasse no meio (medido: reason=marker em produção).
        for (const h of lot.hashes) {
          cache.forget(autofetch.markerKey(adapter.id, account, h));
          held.unprotect(adapter.id, account, h);
          held.release(h, account);
        }
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
  if (!candidates || candidates.length === 0) {
    noteSkip('no-candidates', null, debrid.current()?.id || '', '');
    return 0;
  }

  if (!known) {
    noteSkip('unknown-cache', candidates[0]?.stream, debrid.current()?.id || '', candidates[0]?.pool);
    releaseAllHolds(candidates);
    return 0;
  }

  const stop = candidates[0].pool === 'any' || candidates[0].pool === 'seeds'
    ? cached.size > 0 : hasCachedBrDubbed(streams, cached);
  if (stop) {
    // `hasCachedBrDubbed` para o Chupim se QUALQUER item do pool brDubbed
    // estiver cacheado — e o pool aceita BR sem tag de dublado. Um legendado
    // mal classificado parava o Chupim antes de ele olhar o candidato, sem
    // rastro; o trace deixa o motivo visível.
    noteSkip('stop-has-br', candidates[0]?.stream, debrid.current()?.id || '', candidates[0]?.pool);
    releaseAllHolds(candidates);
    return 0;
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
