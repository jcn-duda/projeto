/**
 * Sonda em fundo de disponibilidade no Real-Debrid.
 *
 * A API oficial não tem mais `/torrents/instantAvailability`. O Torrentio
 * cobre isso com banco colaborativo; nós medimos na conta do usuário:
 * addMagnet → se vira `downloaded` na hora, é ⚡ de verdade; o torrent da
 * sonda é apagado e a evidência fica no magnetdb.
 *
 * Nunca entra no caminho da resposta. Erro só vira log/métrica.
 */
import config from '../config.js';
import type { Stream } from '../../types/domain.js';
import debrid from '../debrid/index.js';
import * as realdebrid from '../debrid/realdebrid.js';
import * as held from '../debrid/protected.js';
import * as magnetdb from '../utils/magnetdb.js';
import * as cache from '../utils/cache.js';
import { accountScope } from '../utils/request-key.js';
import { capture, run, opts } from '../runtime.js';
import type { RuntimeContext } from '../runtime.js';
import {
  pickBrDubbedCandidates,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
} from '../utils/format.js';
import * as autofetch from './autofetch.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { isRateLimitError, isQuotaError } from '../debrid/common.js';

type ProbeOpts = {
  cached: Set<string>;
  searchKey?: string | null;
  season?: number | null;
  episode?: number | null;
};

const recentMiss = new Map<string, number>();
const hourly: number[] = [];
/** Pausa global após 429 — compartilhada entre buscas deste processo. */
let rateCooldownUntil = 0;

function missKey(account: string, hash: string) {
  return `${account}:${hash}`;
}

function wasRecentMiss(account: string, hash: string) {
  const at = recentMiss.get(missKey(account, hash));
  if (at == null) return false;
  if (Date.now() - at > config.debrid.rdProbeMissTtlMs) {
    recentMiss.delete(missKey(account, hash));
    return false;
  }
  return true;
}

function noteMiss(account: string, hash: string) {
  recentMiss.set(missKey(account, hash), Date.now());
  // Poda preguiçosa: o volume é baixo (teto/hora).
  if (recentMiss.size > 2000) {
    const cutoff = Date.now() - config.debrid.rdProbeMissTtlMs;
    for (const [k, at] of recentMiss) {
      if (at < cutoff) recentMiss.delete(k);
    }
  }
}

function takeHourlySlots(n: number) {
  const now = Date.now();
  const windowStart = now - 3600_000;
  while (hourly.length && hourly[0] < windowStart) hourly.shift();
  const room = Math.max(0, config.debrid.rdProbeMaxHour - hourly.length);
  const take = Math.min(n, room);
  for (let i = 0; i < take; i += 1) hourly.push(now);
  return take;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)).unref());
}

/**
 * Monta a lista de hashes a sondar: BR dublado → dublado global → top swarm.
 * Só entra o que ainda NÃO tem ⚡ (fora de `cached`), não está em hold/autofetch
 * e não errou a sonda há pouco.
 */
export function selectProbeCandidates(
  streams: Stream[],
  cached: Set<string>,
  account: string,
  limit: number,
  apiKey = '',
) {
  const max = Math.max(0, Math.trunc(limit) || 0);
  if (max === 0) return [] as string[];

  const cachedSet = new Set([...cached].map((h) => String(h).toLowerCase()));
  const skip = (hash: string) => {
    const h = hash.toLowerCase();
    if (cachedSet.has(h)) return true;
    if (held.isHeld(h, account)) return true;
    if (cache.get(autofetch.markerKey('realdebrid', account, h))) return true;
    if (wasRecentMiss(account, h)) return true;
    if (apiKey && magnetdb.isBad('realdebrid', apiKey, h)) return true;
    return false;
  };

  const picked: string[] = [];
  const seen = new Set<string>();
  // Oversample: o autofetch segura hold nos melhores BR antes da sonda —
  // pedir só `max` fazia a lista inteira cair no skip e a sonda virar no-op.
  const poolLimit = Math.max(max * 4, max + 8);
  const push = (list: Stream[]) => {
    for (const s of list) {
      const h = String(s.infoHash || '').toLowerCase();
      if (!h || seen.has(h) || skip(h)) continue;
      seen.add(h);
      picked.push(h);
      if (picked.length >= max) return true;
    }
    return false;
  };

  if (push(pickBrDubbedCandidates(streams, cachedSet, poolLimit))) return picked;
  if (push(pickAnyDubbedCandidates(streams, cachedSet, poolLimit))) return picked;
  push(pickTopSeededCandidates(streams, cachedSet, poolLimit, { minSeeders: 1 }));
  return picked;
}

async function runProbeLot(hashes: string[], searchKey: string | null | undefined, ctx: RuntimeContext | null) {
  const body = async () => {
    const apiKey = opts().debridApiKey;
    if (!apiKey) return;
    const account = accountScope(apiKey);

    if (config.debrid.rdProbeInitialDelayMs > 0) {
      await wait(config.debrid.rdProbeInitialDelayMs);
    }
    if (Date.now() < rateCooldownUntil) {
      metrics.count('debrid.rd.probe.cooldown');
      log.info(`[rd-probe] em cooldown de rate-limit por mais ${Math.ceil((rateCooldownUntil - Date.now()) / 1000)}s`);
      return;
    }

    const active = await realdebrid.activeTorrentCount(apiKey);
    if (active && active.limit > 0 && active.nb >= active.limit) {
      metrics.count('debrid.rd.probe.skippedActive');
      log.warn(`[rd-probe] activeCount ${active.nb}/${active.limit}; rodada pulada`);
      return;
    }

    let instant = 0;
    log.info(`[rd-probe] sondando ${hashes.length} hash(es)`);
    for (let i = 0; i < hashes.length; i += 1) {
      const hash = hashes[i];
      try {
        const result = await realdebrid.probeInstant(apiKey, hash);
        if (result.instant) {
          instant += 1;
          magnetdb.markAlive('realdebrid', apiKey, [hash]);
          debrid.noteAvailable(hash);
          log.info(`[rd-probe] ⚡ ${hash.slice(0, 8)} (${result.reason})`);
        } else if (result.reason === 'blocked') {
          magnetdb.markBad('realdebrid', apiKey, hash);
          noteMiss(account, hash);
        } else if (result.reason === 'pending' || result.reason === 'error') {
          noteMiss(account, hash);
        }
        // 'active' / 'memo': sem miss — active pode ficar pronto depois; memo já era ⚡
      } catch (err) {
        if (isRateLimitError(err) || isQuotaError(err)) {
          rateCooldownUntil = Date.now() + config.debrid.rdProbeRateCooldownMs;
          metrics.count('debrid.rd.probe.aborted');
          log.warn(
            `[rd-probe] interrompido (${(err as Error).message || err}); ` +
            `cooldown ${Math.round(config.debrid.rdProbeRateCooldownMs / 1000)}s`,
          );
          break;
        }
        noteMiss(account, hash);
        log.warn(`[rd-probe] falha em ${hash.slice(0, 8)}:`, (err as Error)?.message || err);
      }
      if (i + 1 < hashes.length && config.debrid.rdProbeGapMs > 0) {
        await wait(config.debrid.rdProbeGapMs);
      }
    }

    if (instant > 0 && searchKey) {
      // Próxima abertura reconstrói com isAlive → ⚡. Igual ao recheck do autofetch.
      cache.forget(searchKey);
      metrics.count('debrid.rd.probe.cacheForgot');
      log.info(`[rd-probe] ${instant} instantâneo(s); cache de ${searchKey} invalidado`);
    }
  };
  if (ctx) await run(ctx, body);
  else await body();
}

/**
 * Agenda a sonda fora da resposta. No-op se não for RD, se o kill-switch
 * estiver off, ou se não sobrar candidato/orçamento.
 */
export function queueRdProbe(streams: Stream[], { cached, searchKey }: ProbeOpts) {
  if (!config.debrid.rdProbe) return;
  const adapter = debrid.current();
  if (!adapter || adapter.id !== 'realdebrid') return;
  if (!opts().debridApiKey) return;
  if (Date.now() < rateCooldownUntil) {
    metrics.count('debrid.rd.probe.cooldown');
    return;
  }

  const apiKey = opts().debridApiKey;
  const account = accountScope(apiKey);
  let slots = takeHourlySlots(config.debrid.rdProbeMax);
  if (slots <= 0) {
    metrics.count('debrid.rd.probe.hourlyFull');
    return;
  }

  const hashes = selectProbeCandidates(streams, cached, account, slots, apiKey);
  if (hashes.length === 0) {
    // Devolve os slots não usados à janela (evita contar o ar).
    for (let i = 0; i < slots; i += 1) hourly.pop();
    metrics.count('debrid.rd.probe.noCandidates');
    log.info('[rd-probe] nenhum candidato livre (cache/hold/miss recente)');
    return;
  }
  // Ajustar contagem horária ao que de fato vamos sondar.
  while (hourly.length > 0 && hashes.length < slots) {
    hourly.pop();
    slots -= 1;
  }

  metrics.count('debrid.rd.probe.queued', hashes.length);
  const ctx = capture();
  // Fire-and-forget: rejeição não pode virar unhandledRejection.
  runProbeLot(hashes, searchKey, ctx).catch((err) => {
    log.warn('[rd-probe] lote falhou:', (err as Error)?.message || err);
  });
}
