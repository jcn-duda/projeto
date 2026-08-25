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
  markDebridName,
} from '../utils/format.js';
import * as autofetch from './autofetch.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { isRateLimitError, isQuotaError } from '../debrid/common.js';
import { rdGate } from '../debrid/rd-gate.js';
import * as rdLedger from '../debrid/rd-ledger.js';

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
/** No máximo UMA sonda em voo: parcial + passe tardio enfileiravam 3×4 addMagnet. */
let probeInFlight = false;

function missKey(account: string, hash: string) {
  return `${account}:${hash}`;
}

function wasRecentMiss(account: string, hash: string) {
  if (config.debrid.rdLedger.enabled && rdLedger.peek(hash) === 'miss') return true;
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

/** Extrai infoHash de uma URL /resolve/... gravada na lista cacheada. */
function hashFromResolveUrl(url: string): string | null {
  const m = String(url || '').match(/\/resolve\/([a-fA-F0-9]{40})\b/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Reescreve nomes [RD download] → [RD⚡] na entrada streams:v6 atual.
 * Devolve quantos itens promoveu; 0 se não havia cache.
 */
function promoteCachedBolts(searchKey: string, instantHashes: string[]): number {
  const entry = cache.get(searchKey) as { streams?: Stream[]; partial?: boolean; debridKnown?: boolean } | undefined;
  if (!entry || !Array.isArray(entry.streams) || instantHashes.length === 0) return 0;
  const want = new Set(instantHashes.map((h) => h.toLowerCase()));
  let promoted = 0;
  const streams = entry.streams.map((s) => {
    const hash = hashFromResolveUrl(String((s as any).url || ''));
    if (!hash || !want.has(hash)) return s;
    const raw = String(s.name || '');
    if (raw.includes('\u26a1')) return s;
    const without = raw.replace(/^\[[^\]]+\]\s*/, '');
    promoted += 1;
    return { ...s, name: markDebridName(without, 'RD', true) };
  });
  if (!promoted) return 0;
  const remainingMs = cache.peekRemaining(searchKey);
  const ttlSeconds = remainingMs != null && remainingMs > 0
    ? Math.max(1, Math.ceil(remainingMs / 1000))
    : config.cacheTtl;
  cache.set(searchKey, { ...entry, streams }, ttlSeconds);
  return promoted;
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
    // O ledger é por serviço: hit/blocked também não precisam de nova sonda.
    // Miss usa o backoff durável; com o kill-switch, wasRecentMiss preserva o
    // mapa por conta que existia antes desta fase.
    if (config.debrid.rdLedger.enabled && (rdLedger.isHit(h) || rdLedger.peek(h) === 'blocked')) return true;
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
    if (!config.debrid.rdGate.enabled && Date.now() < rateCooldownUntil) {
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
    const instantHashes: string[] = [];
    log.info(`[rd-probe] sondando ${hashes.length} hash(es)`);
    for (let i = 0; i < hashes.length; i += 1) {
      const hash = hashes[i];
      try {
        const result = await realdebrid.probeInstant(apiKey, hash);
        if (result.instant) {
          instant += 1;
          instantHashes.push(hash);
          magnetdb.markAlive('realdebrid', apiKey, [hash]);
          rdLedger.noteHit([hash]);
          debrid.noteAvailable(hash);
          log.info(`[rd-probe] ⚡ ${hash.slice(0, 8)} (${result.reason})`);
        } else if (result.reason === 'blocked') {
          magnetdb.markBad('realdebrid', apiKey, hash);
          rdLedger.noteBlocked(hash);
          noteMiss(account, hash);
        } else if (result.reason === 'pending' || result.reason === 'error') {
          noteMiss(account, hash);
        }
        // 'active' / 'memo': sem miss — active pode ficar pronto depois; memo já era ⚡
      } catch (err) {
        if (isRateLimitError(err) || isQuotaError(err)) {
          if (!config.debrid.rdGate.enabled) {
            rateCooldownUntil = Date.now() + config.debrid.rdProbeRateCooldownMs;
          }
          metrics.count('debrid.rd.probe.aborted');
          const cooldownText = config.debrid.rdGate.enabled
            ? `cooldown do gate ${Math.ceil(rdGate.cooldownRemainingMs(account) / 1000)}s`
            : `cooldown ${Math.round(config.debrid.rdProbeRateCooldownMs / 1000)}s`;
          log.warn(`[rd-probe] interrompido (${(err as Error).message || err}); ${cooldownText}`);
          break;
        }
        noteMiss(account, hash);
        log.warn(`[rd-probe] falha em ${hash.slice(0, 8)}:`, (err as Error)?.message || err);
      }
      // Com o gate ligado, o gap adaptativo já separa os jobs compostos. O
      // intervalo legado só existe no kill-switch para reproduzir 9c9c714.
      if (!config.debrid.rdGate.enabled && i + 1 < hashes.length && config.debrid.rdProbeGapMs > 0) {
        await wait(config.debrid.rdProbeGapMs);
      }
    }

    if (instant > 0 && searchKey) {
      // Preferir reescrever a entrada atual: forget sozinho falha se o passe
      // tardio gravou outra chave, e a próxima abertura serviria nomes velhos
      // [RD download]. O hash está no path do /resolve.
      const promoted = promoteCachedBolts(searchKey, instantHashes);
      if (!promoted) {
        cache.forget(searchKey);
        metrics.count('debrid.rd.probe.cacheForgot');
        log.info(`[rd-probe] ${instant} instantâneo(s); cache esquecido (sem entrada pra reescrever)`);
      } else {
        metrics.count('debrid.rd.probe.cachePromoted', promoted);
        log.info(`[rd-probe] ${instant} instantâneo(s); ${promoted} stream(s) promovido(s) a ⚡ no cache`);
      }
    }
  };
  // Teto do lote inteiro: se a API do RD pendurar (throttle sem 429), a sonda
  // nao pode segurar probeInFlight para sempre e calar as buscas seguintes.
  const lotBudgetMs = config.debrid.rdProbeInitialDelayMs
    + (hashes.length * (config.debrid.timeout + config.debrid.rdProbeGapMs + 2000))
    + 5000;
  try {
    const runBody = ctx ? run(ctx, body) : body();
    await settleProbeLot(runBody, lotBudgetMs);
  } finally {
    probeInFlight = false;
  }
}

/**
 * Com o gate ligado, o teto vira só telemetria: liberar o lote antes do body
 * deixaria a próxima sonda criar waiters enquanto a anterior ainda executa.
 * O risco de probeInFlight ficar preso é aceito: AbortSignal.timeout das
 * chamadas HTTP continua sendo a rede de baixo. O kill-switch preserva o
 * Promise.race legado de 9c9c714.
 */
export async function settleProbeLot(runBody: Promise<void>, lotBudgetMs: number): Promise<void> {
  const timeout = async () => {
    await wait(lotBudgetMs);
    metrics.count('debrid.rd.probe.lotTimeout');
    log.warn(`[rd-probe] lote excedeu ${Math.round(lotBudgetMs / 1000)}s${config.debrid.rdGate.enabled ? '; aguardando término real' : '; abandonando'}`);
  };
  if (!config.debrid.rdGate.enabled) {
    await Promise.race([runBody, timeout()]);
    return;
  }
  let done = false;
  void wait(lotBudgetMs).then(() => {
    if (done) return;
    metrics.count('debrid.rd.probe.lotTimeout');
    log.warn(`[rd-probe] lote excedeu ${Math.round(lotBudgetMs / 1000)}s; aguardando término real`);
  });
  try {
    await runBody;
  } finally {
    done = true;
  }
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
  const apiKey = opts().debridApiKey;
  const account = accountScope(apiKey);
  if (
    (!config.debrid.rdGate.enabled && Date.now() < rateCooldownUntil) ||
    (config.debrid.rdGate.enabled && rdGate.isCoolingDown(account))
  ) {
    metrics.count('debrid.rd.probe.cooldown');
    return;
  }
  if (probeInFlight) {
    metrics.count('debrid.rd.probe.busy');
    return;
  }

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
  probeInFlight = true;
  const ctx = capture();
  // Fire-and-forget: rejeição não pode virar unhandledRejection.
  runProbeLot(hashes, searchKey, ctx).catch((err) => {
    probeInFlight = false;
    log.warn('[rd-probe] lote falhou:', (err as Error)?.message || err);
  });
}
