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
import * as suppressed from './autofetch-suppressed.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { rdGate } from '../debrid/rd-gate.js';
import { isRateLimitError } from '../debrid/common.js';
import * as rdLedger from '../debrid/rd-ledger.js';
import { recordAutofetchRelease } from './autofetch-index.js';
import * as releaseIndex from '../utils/release-index.js';
import { manageSettleLru } from './autofetch-settle.js';
import { takeDrainCandidate } from './autofetch-drain.js';
import { commitObra, releaseObra, forgetObraHash } from './autofetch-obra.js';
import { seasonSearchKeys, seasonIndexKey, registerSeasonSearchKey } from './autofetch-season-index.js';
export type SeasonHint = { imdbId?: string | null; season?: number | null; episode?: number | null; isPack?: boolean };
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
/** Lotes aceitos aguardando ficar tocáveis, morrer ou drenar a fila. */
export const recheckLots = new Map<string, RecheckLot>();
// Índice de temporadas do Season Pack Fill extraído para
// autofetch-season-index.ts (catraca de linhas); reexportado para os
// consumidores históricos que importavam daqui.
export { seasonSearchKeys, seasonIndexKey, registerSeasonSearchKey };

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

// Devolve `true` apenas quando um candidato foi de fato iniciado (hold +
// `enqueue` disparado); bloqueios (pausa, orçamento, gate de conta, cooldown
// RD, lock, fila vazia) devolvem `false` — nenhum chamador pode tratar bloqueio
// transitório como dreno consumado.
export function drainNext(searchKey: string, lot: any): boolean {
  const live = autofetchLive.effective();
  if (!searchKey || !live.autoFetchQueue || autofetchLive.isPaused()) return false;
  const queue = autofetch.readQueue(searchKey);
  if (!queue.length) return false;
  const adapter = debrid.current();
  if (!adapter) return false;
  const account = accountScope(opts().debridApiKey);
  if (autofetch.budgetBlockedUntil(adapter.id, account) > Date.now()) return false;
  if (adapter.id === 'realdebrid' && rdGate.isCoolingDown(account)) return false;
  if (autofetch.accountGateBlocked(adapter, opts().debridApiKey)) return false;

  // Teto de recusas: sem takeNext (sem requeue). A poda de obsoletos do
  // takeNext deixa de rodar enquanto o dreno está travado — roda na próxima passagem.
  if ((lot.refusals || 0) >= config.debrid.autoFetchDrainMaxRefusals) {
    log.warn(`[autofetch] drenagem interrompida após ${lot.refusals} recusas consecutivas`);
    return false;
  }

  // Seleção + reserva do teto por OBRA (Fase 2): obsoletos saem da fila,
  // holds transitórios são adiados e o candidato que o cap fecha nesta janela é
  // descartado — a seleção segue para o próximo elegível. A fila remanescente
  // já sai gravada pela própria seleção.
  const { next, remaining, lease } = takeDrainCandidate(searchKey, adapter, account);
  if (!next) return false;

  const requeue = () => {
    // Desistência posterior (lock/orçamento/cooldown) devolve a reserva — ela só
    // vale para o enqueue que ia acontecer agora.
    releaseObra(lease);
    autofetch.writeQueue(
      searchKey,
      [next, ...remaining],
      config.debrid.autoFetchQueueTtl,
      adapter.id,
      account,
    );
  };

  const h = String(next.infoHash).toLowerCase();
  const mKey = autofetch.markerKey(adapter.id, account, h);
  if (!autofetch.acquire(mKey)) {
    requeue();
    return false;
  }

  if (!autofetch.checkAndRecordBudget(adapter.id, account, adapter.enqueueHourlyLimit)) {
    autofetch.release(mKey);
    autofetch.blockBudget(adapter.id, account, config.debrid.autoFetchDrainBackoffMs);
    requeue();
    return false;
  }

  held.hold(h, live.autoFetchTtl, account);
  debrid.enqueue(h, { season: next.season, episode: next.episode })
    .then((ok) => {
      autofetch.release(mKey);
      if (ok) {
        cache.set(mKey, autofetch.markerValue(ok), live.autoFetchTtl);
        // Aceite confirmado: entrada durável do teto por obra (Fase 2), com o
        // pool REAL do candidato — seeds nunca consome vaga br.
        commitObra(lease, {
          hash: h,
          pool: String(next.pool || ''),
          title: String(next.title || next.name || '').split('\n')[0].slice(0, 120),
          br: Boolean(next.br),
          dubbed: Boolean(next.dubbed),
          ...(typeof ok === 'string' && ok ? { id: ok } : {}),
        });
        metrics.count('autofetch.queued');
        metrics.count('autofetch.enqueued');
        recordAutofetchRelease(next.imdbId, next);
        if (adapter.id === 'alldebrid' && next.pool === 'br' && Boolean(next.br) && Boolean(next.dubbed)) {
          held.protectBr(adapter.id, account, h);
        }
        lot.hashes.add(h);
        lot.seasonHints.set(h, {
          imdbId: typeof next.imdbId === 'string' ? next.imdbId : undefined,
          season: next.season,
          episode: next.isPack === true ? null : (next.episode ?? null),
          isPack: next.isPack === true,
        });
        lot.refusals = 0;
        log.info(`[autofetch] ${adapter.label} drenou da fila e baixando: ${next.title || next.name || h}`);
      } else {
        releaseObra(lease);
        held.release(h, account);
        lot.refusals = (lot.refusals || 0) + 1;
        metrics.count('autofetch.refused');
        log.warn(`[autofetch] ${adapter.label} recusou dreno de ${h}`);
        if (lot.refusals < config.debrid.autoFetchDrainMaxRefusals) drainNext(searchKey, lot);
      }
    })
    .catch((err) => {
      autofetch.release(mKey);
      releaseObra(lease);
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
  return true;
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

    // Atraso represado: com o knob ligado, apaga o que o gate barrou enquanto
    // ele estava desligado. No-op barato quando desligado (o default).
    await suppressed.drainSuppressed(adapter, opts().debridApiKey, account);

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
        cleanLotHash(lot, hash);
        // Só descarta a fila quando o lote inteiro assentou. Um 720p ready
        // não pode apagar o backup do 1080p ainda stallado — era exatamente
        // o que esvaziava a reposição inteligente no meio do caminho.
        if (lot.hashes.size === 0) autofetch.dropQueue(searchKey);
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
          releaseIndex.forgetAutofetchHash(lot.seasonHints.get(hash)?.imdbId, hash);
          held.unprotect(adapter.id, account, hash);
          held.release(hash, account);
          // A ponte pelo id expõe de uma vez transferências que a remoção
          // automática NUNCA alcançou (58 de 60 na conta medida). Ligar visão e
          // destruição no mesmo deploy faria a primeira rodada apagar um acervo
          // inteiro sem ninguém ter olhado — então a remoção por via `id` nasce
          // DESLIGADA.
          //
          // O que suprimir NÃO faz: conter o tamanho da conta. A blacklist só
          // impede que ESTE hash volte, e o `drainNext` logo abaixo submete o
          // próximo candidato — o saldo de transferências fica igual ou +1. O
          // registro em `noteSuppressed` existe para que ligar o knob depois
          // alcance o que ficou para trás; sem ele o hash sai do lote aqui e
          // nunca mais é revisitado.
          //
          // `via` descreve o CANAL de identificação, não a confiança: o `id`
          // vem do nosso próprio marker de enqueue e é prova de primeira mão.
          // O gate abaixo é um freio de ROLLOUT, não um juízo sobre o id — a
          // fila represada existe para o atraso ser cobrado depois sem ligar o
          // knob (leitura: countSuppressed/countAllSuppressed; dreno: drainSuppressed).
          const podeRemover = statusInfo.via !== 'id' || config.debrid.removeById;
          if (!podeRemover) {
            metrics.count(isDead ? 'autofetch.dead.suppressed' : 'autofetch.stalled.suppressed');
            suppressed.noteSuppressed(adapter.id, account, hash, statusInfo.id);
          } else if (typeof adapter.removeTorrent === 'function' && statusInfo.id != null) {
            adapter.removeTorrent(opts().debridApiKey, statusInfo.id).catch(() => {});
          }
          // Hash TERMINAL (morto/parado) libera a vaga da obra ANTES do dreno: a
          // reposição SAME POOL precisa caber ainda na janela, sem esperar a
          // eviction (F6). Ready NÃO passa por aqui — segue contando pelo TTL.
          const obraHint = lot.seasonHints.get(hash);
          forgetObraHash({
            adapterId: adapter.id,
            account,
            imdbId: obraHint?.imdbId ?? null,
            season: obraHint?.season ?? null,
            episode: obraHint?.isPack ? null : (obraHint?.episode ?? null),
            isPack: obraHint?.isPack === true,
            searchKey,
            hash,
          });
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
    if (lot.isSettle && (Date.now() - (lot.createdAt || 0)) >= liveAfter.autoFetchTtl * 1000) {
      metrics.count('autofetch.expired-unready', lot.hashes.size);
      // Exceção deliberada do gate (cabeçalho de autofetch-suppressed.ts):
      // remove por id DIRETO, sem podeRemover/noteSuppressed — é o que expira
      // no settle (download que o PRÓPRIO addon subiu), não acervo represado.
      if (typeof adapter.removeTorrent === 'function') {
        for (const h of lot.hashes) {
          const sid = statuses[h]?.id;
          if (sid != null) adapter.removeTorrent(opts().debridApiKey, sid).catch(() => {});
        }
      }
      for (const h of lot.hashes) {
        releaseIndex.forgetAutofetchHash(lot.seasonHints.get(h)?.imdbId, h);
        cache.forget(autofetch.markerKey(adapter.id, account, h));
        held.unprotect(adapter.id, account, h);
        held.release(h, account);
      }
      recheckLots.delete(searchKey);
    } else {
      if (!lot.isSettle && lot.attempts >= liveAfter.autoFetchRecheckMax) {
        lot.isSettle = true;
        manageSettleLru(recheckLots);
      }
      // Política da Fase 0 (Chupim 2.0): ENTRAR em settle sem evidência
      // dead/stalled NÃO drena fila alguma. Drenar sem prova de colapso submete
      // fallback sem necessidade e gasta orçamento da conta; a reposição de
      // serviços sem sinal de `stalled` (AllDebrid) fica para a futura F3.
      armRecheck(searchKey, lot);
    }
  })).catch((err) => {
    lot.inFlight = false;
    log.warn('[autofetch] recheck falhou:', err?.message || err);
    if (lot.hashes.size > 0) armRecheck(searchKey, lot);
    else recheckLots.delete(searchKey);
  });
}
