// Colhedor: generalização do warmup. O warmup esquenta títulos curados uma vez
// no boot; o colhedor mantém um ÍNDICE de releases vivo para sempre — fila
// persistente de obras a colher, orçamento largo (ninguém está esperando) e
// freio de atividade em janela deslizante.
//
// Educação com os indexers: o colhedor reduz carga total (a mesma obra deixa
// de ser raspada a cada busca, porque o índice responde), mas não pode virar
// crawler — consulta sequencial, intervalo mínimo entre consultas ao mesmo
// indexer e teto horário. Falha não conta no breaker nem pinta card: o status
// continua sendo o da busca ao vivo do usuário.
import crypto from 'node:crypto';
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as activity from './activity.js';
import jackett from './jackett.js';
import bludv from './bludv.js';
import { getMeta } from '../utils/cinemeta.js';
import * as tmdb from '../utils/tmdb.js';
import { resolveSearchNames, buildSearchQuery, filterRelevantRaw } from '../utils/format.js';
import { ptSweepIndexers, ptSweepQueryFor } from './search-plan.js';
import * as releaseIndex from '../utils/release-index.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import debrid from '../debrid/index.js';
import { notify } from '../utils/notify.js';

type HarvestEntry = {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number | null;
  episode?: number | null;
  reason: string;
  enqueuedAt: number;
};

// A fila inteira vive numa chave só: obras são poucas (teto HARVEST_QUEUE_MAX),
// e ler/escrever um array é atômico dentro do processo — sem scan de chaves,
// que o cache Map não oferece. Persistência best-effort como todo L2.
const QUEUE_KEY = `${prefix('harvest')}q`;

let queue: HarvestEntry[] = [];
let started = false;
let inFlight = false;
let lastRunAt = 0;
let harvested = 0;
const attemptsByObra = new Map<string, number>();
const hourBuckets = new Map<number, number>();
const lastQueryAt = new Map<string, number>();

function obraIdentity(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode'>) {
  return `${entry.imdbId}:${entry.season ?? ''}:${entry.episode ?? ''}`;
}

function loadQueue() {
  const stored = cache.get(QUEUE_KEY);
  if (Array.isArray(stored)) queue = stored.filter((e) => e && /^tt\d+$/.test(String(e.imdbId)));
}

function persistQueue() {
  if (!queue.length) {
    cache.forget(QUEUE_KEY);
    return;
  }
  cache.set(QUEUE_KEY, queue.slice(0, config.harvest.queueMax), config.harvest.entryTtl);
}

/** Marca dedupe por obra com TTL — re-enfileirar a cada busca enchia a fila. */
function recentlyQueued(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode' | 'reason'>) {
  const key = `${prefix('harvest')}seen:${crypto.createHash('sha256').update(`${obraIdentity(entry)}:${entry.reason}`).digest('hex')}`;
  if (cache.get(key) === 1) return true;
  cache.set(key, 1, 12 * 3600);
  return false;
}

/**
 * Enfileira uma obra para colheita em fundo. Alimentado por: busca com lacuna
 * no índice (miss/gap) e episódio seguinte de série assistida. Nunca lança e
 * nunca bloqueia — é fogo-e-esquece por contrato.
 */
function enqueue(entry: Omit<HarvestEntry, 'enqueuedAt'>) {
  if (!config.harvest.enabled || !config.releaseIndex.enabled) return;
  const imdbId = String(entry.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return;
  if (entry.type !== 'movie' && entry.type !== 'series') return;
  const full: HarvestEntry = { ...entry, imdbId, enqueuedAt: Date.now() };
  if (recentlyQueued(full)) return;
  if (queue.some((q) => obraIdentity(q) === obraIdentity(full))) return;
  // Teto da fila: obra nova empurra a mais velha — a fila é oportunidade de
  // colheita, não backlog sagrado.
  while (queue.length >= config.harvest.queueMax) queue.shift();
  queue.push(full);
  persistQueue();
  metrics.count('harvest.enqueued');
}

function queriesThisHour() {
  const hour = Math.floor(Date.now() / 3_600_000);
  for (const bucket of [...hourBuckets.keys()]) {
    if (bucket < hour) hourBuckets.delete(bucket);
  }
  return hourBuckets.get(hour) || 0;
}

function noteQueries(count: number) {
  const hour = Math.floor(Date.now() / 3_600_000);
  hourBuckets.set(hour, (hourBuckets.get(hour) || 0) + count);
}

async function awaitIndexerGap(indexer: string) {
  const gap = Date.now() - (lastQueryAt.get(indexer) || 0);
  if (gap < config.harvest.indexerDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, config.harvest.indexerDelayMs - gap).unref());
  }
}

async function harvestOne(entry: HarvestEntry): Promise<boolean> {
  const startedAt = Date.now();
  const [meta, titles] = await Promise.all([getMeta(entry.type, entry.imdbId), tmdb.getTitles(entry.imdbId)]);
  const searchMeta = resolveSearchNames({ meta, titles, imdbId: entry.imdbId });
  if (!searchMeta?.name) return false;
  const matchContext = {
    names: searchMeta.names,
    year: searchMeta.year,
    isSeries: entry.season != null,
    season: entry.season ?? null,
    episode: entry.episode ?? null,
  };
  const query = buildSearchQuery(searchMeta, { season: entry.season ?? null, episode: entry.episode ?? null });
  const ptQuery = titles?.pt && titles.pt !== titles.original
    ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season: entry.season ?? null, episode: entry.episode ?? null })
    : null;

  const indexers = [...new Set(config.jackett.indexers)];
  let attempted = 0;
  let succeeded = 0;
  const collected: any[] = [];

  for (const indexer of indexers) {
    // Freio de atividade no MEIO da obra também: tráfego chegou, solta o
    // Jackett na hora (o que já foi coletado entra no índice mesmo assim).
    if (activity.recentUserTraffic(config.harvest.idleWindowMs)) break;
    if (queriesThisHour() + attempted >= config.harvest.maxPerHour) {
      log.debug('[harvest] teto horário atingido');
      break;
    }
    // Intervalo mínimo entre consultas ao MESMO indexer: educação básica.
    await awaitIndexerGap(indexer);
    attempted += 1;
    try {
      const items = await jackett.search(query, entry.type, [indexer], {
        matchContext,
        recordStatus: false,
        fallbackQuery: ptQuery || undefined,
      });
      lastQueryAt.set(indexer, Date.now());
      succeeded += 1;
      collected.push(...items.filter((i: any) => !i.fromAccount));
    } catch (err: any) {
      lastQueryAt.set(indexer, Date.now());
      log.warn(`[harvest] ${indexer} falhou para ${entry.imdbId}:`, err?.message || err);
    }
  }

  // Varredura pt-BR nos globais, a mesma da busca ao vivo: o dublado
  // titulado em PT mora em tracker global e a query em inglês não o encontra
  // — sem isto o índice ficava sistematicamente cego para a release que só a
  // varredura acha, e o colhedor não a entregava nunca. Divergência DE
  // PROPÓSITO do caminho ao vivo: aqui o breaker é RESPEITADO (sem
  // ignoreBreaker) — colheita de fundo não precisa acordar indexer
  // recém-derrubado, o dublado raro espera o cooldown.
  const sweepQuery = config.jackett.ptSweepGlobal ? ptSweepQueryFor({ titles }) : null;
  const sweepTargets =
    sweepQuery && !activity.recentUserTraffic(config.harvest.idleWindowMs)
      ? ptSweepIndexers(indexers, config.jackett.ptBrIndexers)
      : [];
  if (sweepQuery && sweepTargets.length > 0) {
    // A varredura agrupada dispara uma consulta HTTP por alvo: conta no teto
    // com a mesma moeda do loop acima, antes de decidir.
    if (queriesThisHour() + attempted + sweepTargets.length >= config.harvest.maxPerHour) {
      log.debug('[harvest] teto horário atingido antes da varredura pt');
    } else {
      for (const target of sweepTargets) {
        await awaitIndexerGap(target);
      }
      attempted += sweepTargets.length;
      metrics.count('harvest.sweep');
      try {
        const items = await jackett.search(sweepQuery, entry.type, sweepTargets, {
          matchContext,
          recordStatus: false,
        });
        for (const target of sweepTargets) {
          lastQueryAt.set(target, Date.now());
        }
        succeeded += sweepTargets.length;
        collected.push(...items.filter((i: any) => !i.fromAccount));
      } catch (err: any) {
        for (const target of sweepTargets) {
          lastQueryAt.set(target, Date.now());
        }
        log.warn('[harvest] varredura pt falhou:', err?.message || err);
      }
    }
  }

  if (config.bludv.enabled && ptQuery) {
    try {
      collected.push(...(await bludv.search(ptQuery)).filter((i: any) => !i.fromAccount));
    } catch (err: any) {
      log.warn('[harvest] bludv falhou:', err?.message || err);
    }
  }

  // O teto horário só fecha a conta se as consultas forem ANOTADAS: este
  // chamado faltava e o acumulador vivia vazio — queriesThisHour() devolvia
  // sempre 0 e HARVEST_MAX_HOUR não segurava nada entre obras (o guard do
  // tick via um balde eternamente limpo). Só consultas ao Jackett contam,
  // na mesma moeda dos guards; uma única anotação no fim cobre loop e
  // varredura.
  noteQueries(attempted);

  const relevant = filterRelevantRaw(collected, matchContext as any);
  const added = releaseIndex.record(entry.imdbId, { season: entry.season, episode: entry.episode }, relevant);
  harvested += 1;
  lastRunAt = Date.now();
  metrics.observe('harvest.ms', Date.now() - startedAt);
  return added > 0 || succeeded > 0;
}

async function checkQuotaWarning() {
  if (!config.notify.enabled || !config.notify.webhookUrl) return;
  const adapter = config.debrid.service ? debrid.BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.accountStatus !== 'function') return;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey) return;
  try {
    const status = await adapter.accountStatus(config.debrid.apiKey);
    if (status && typeof status.magnets === 'number' && status.magnets >= config.notify.magnetsWarn) {
      await notify('debrid_quota_warning', 'warning', `Conta ${adapter.id} atingiu ${status.magnets} magnets (próximo do limite de 1000)`, {
        adapter: adapter.id,
        magnets: status.magnets,
        ready: status.ready,
        active: status.active,
      });
    }
  } catch (err: any) {
    log.debug('[harvest] verificação de quota falhou:', err?.message || err);
  }
}

/**
 * Um passo do ciclo: consome UMA obra da fila. Em produção só o setInterval
 * do start() chama; exportado para o teste cobrir a contabilidade do teto
 * horário sem subir o timer.
 */
async function tick() {
  if (inFlight || activity.recentUserTraffic(config.harvest.idleWindowMs)) return;
  checkQuotaWarning().catch(() => {});
  if (!queue.length) return;
  if (queriesThisHour() >= config.harvest.maxPerHour) return;
  inFlight = true;
  let entry: HarvestEntry | undefined;
  try {
    entry = queue.shift();
    if (!entry) return;
    persistQueue();
    const identity = obraIdentity(entry);
    const ok = await harvestOne(entry);
    attemptsByObra.delete(identity);
    metrics.count(ok ? 'harvest.done' : 'harvest.empty');
  } catch (err: any) {
    metrics.count('harvest.failed');
    if (entry) {
      const tries = (attemptsByObra.get(obraIdentity(entry)) || 0) + 1;
      attemptsByObra.set(obraIdentity(entry), tries);
      // Falha de rede pode ser transitória: volta pro fim da fila até 3 vezes.
      if (tries <= 3) queue.push(entry);
      else attemptsByObra.delete(obraIdentity(entry));
      persistQueue();
    }
    log.warn('[harvest] ciclo falhou:', err?.message || err);
  } finally {
    inFlight = false;
  }
}

function start() {
  if (started) return;
  started = true;
  if (!config.harvest.enabled || !config.releaseIndex.enabled) {
    log.info('[harvest] desativado (colhedor ou índice off)');
    return;
  }
  loadQueue();
  if (queue.length) log.info(`[harvest] fila recuperada do disco: ${queue.length} obra(s)`);
  const timer = setInterval(() => { tick().catch(() => {}); }, config.harvest.intervalMs);
  timer.unref();
}

/** Para o painel: estado do colhedor sem expor nada sensível. */
function status() {
  return {
    enabled: config.harvest.enabled && config.releaseIndex.enabled,
    queueDepth: queue.length,
    queueMax: config.harvest.queueMax,
    harvested,
    queriesThisHour: queriesThisHour(),
    maxPerHour: config.harvest.maxPerHour,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    idleWindowMs: config.harvest.idleWindowMs,
  };
}

export { enqueue, start, status, tick };
export default { enqueue, start, status, tick };
