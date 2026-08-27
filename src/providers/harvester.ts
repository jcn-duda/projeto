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
import {
  resolveSearchNames,
  buildSearchQuery,
  filterRelevantRaw,
  extractInfoHash,
  looksPtBr,
  audioFromTitle,
  explicitPtAudio,
} from '../utils/format.js';
import { ptSweepIndexers, ptSweepQueryFor } from './search-plan.js';
import * as releaseIndex from '../utils/release-index.js';
import { nextSeeds } from './imdb-seed.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import debrid from '../debrid/index.js';
import { notify } from '../utils/notify.js';
import rdWarmer from './rd-warmer.js';
import * as harvesterLive from '../utils/harvester-live.js';

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
// Pausa é operacional e deliberadamente não persiste: após restart o operador
// volta ao comportamento configurado no .env, sem uma ação temporária virar
// desligamento esquecido.
let paused = false;
let lastRunAt = 0;
let harvested = 0;
type RecentWork = Pick<HarvestEntry, 'imdbId' | 'type' | 'season' | 'episode'> & { at: number; recorded: number };
const recentWorks: RecentWork[] = [];
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
  const live = harvesterLive.effective();
  cache.set(QUEUE_KEY, queue.slice(0, live.harvestQueueMax), live.harvestEntryTtl);
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
  const live = harvesterLive.effective();
  if (!live.harvestEnabled || !config.releaseIndex.enabled) return;
  const imdbId = String(entry.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return;
  if (entry.type !== 'movie' && entry.type !== 'series') return;
  const full: HarvestEntry = { ...entry, imdbId, enqueuedAt: Date.now() };
  if (recentlyQueued(full)) return;
  if (queue.some((q) => obraIdentity(q) === obraIdentity(full))) return;
  // Teto da fila: obra nova empurra a mais velha — a fila é oportunidade de
  // colheita, não backlog sagrado.
  while (queue.length >= live.harvestQueueMax) queue.shift();
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
  const delay = harvesterLive.effective().harvestIndexerDelayMs;
  if (gap < delay) {
    // SEM unref, diferente do wait() do common.ts: aquele só roda dentro de uma
    // requisição, onde o servidor segura o event loop. Este roda no colhedor,
    // trabalho de FUNDO — com unref o Node encerra o loop com a promise ainda
    // pendente e o await nunca volta, travando a obra no meio. O preço é o
    // shutdown esperar no máximo um indexerDelayMs.
    await new Promise((resolve) => setTimeout(resolve, delay - gap));
  }
}

async function harvestOne(entry: HarvestEntry): Promise<{ ok: boolean; capped: boolean }> {
  const startedAt = Date.now();
  const [meta, titles] = await Promise.all([getMeta(entry.type, entry.imdbId), tmdb.getTitles(entry.imdbId)]);
  const searchMeta = resolveSearchNames({ meta, titles, imdbId: entry.imdbId });
  if (!searchMeta?.name) return { ok: false, capped: false };
  const matchContext = {
    names: searchMeta.names,
    year: searchMeta.year,
    // Pelo TIPO, não pela temporada: obra semeada pela lista de populares
    // entra sem temporada, e `isSeries: false` aplicaria a precisão de título
    // de FILME numa série. Para quem já vinha com temporada, é equivalente.
    isSeries: entry.type === 'series',
    season: entry.season ?? null,
    episode: entry.episode ?? null,
  };
  const query = buildSearchQuery(searchMeta, { season: entry.season ?? null, episode: entry.episode ?? null });
  const ptQuery = titles?.pt && titles.pt !== titles.original
    ? buildSearchQuery({ name: titles.pt, year: titles.year }, { season: entry.season ?? null, episode: entry.episode ?? null })
    : null;

  const indexers = [...new Set(config.jackett.indexers)];
  let attempted = 0;
  let capped = false;
  let succeeded = 0;
  const collected: any[] = [];

  // Varredura pt-BR nos globais, ANTES do laço de propósito: é a consulta de
  // maior valor por unidade (uma chamada agrupada que acha o dublado titulado
  // em PT, que a query em inglês nunca encontra), então quando o teto horário
  // cortar, quem fica pelo caminho é a cauda do laço — não ela. Na ordem
  // antiga o guard somava as consultas do laço e a varredura era a primeira
  // sacrificada: com 19 indexers e 12 alvos contra teto de 30, ela NUNCA
  // rodava.
  //
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
    if (queriesThisHour() + sweepTargets.length >= config.harvest.maxPerHour) {
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
      } catch (err: unknown) {
        for (const target of sweepTargets) {
          lastQueryAt.set(target, Date.now());
        }
        log.warn('[harvest] varredura pt falhou:', log.errorMessage(err));
      }
    }
  }

  for (const indexer of indexers) {
    // Freio de atividade no MEIO da obra também: tráfego chegou, solta o
    // Jackett na hora (o que já foi coletado entra no índice mesmo assim).
    if (activity.recentUserTraffic(config.harvest.idleWindowMs)) break;
    if (queriesThisHour() + attempted >= config.harvest.maxPerHour) {
      // A obra sai DAQUI pela metade: quem a desenfileirou precisa saber, senão
      // ela é dada por colhida com meia dúzia de indexers e nunca mais volta.
      capped = true;
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
    } catch (err: unknown) {
      lastQueryAt.set(indexer, Date.now());
      log.warn(`[harvest] ${indexer} falhou para ${entry.imdbId}:`, log.errorMessage(err));
    }
  }

  if (config.bludv.enabled && ptQuery) {
    try {
      collected.push(...(await bludv.search(ptQuery)).filter((i: any) => !i.fromAccount));
    } catch (err: unknown) {
      log.warn('[harvest] bludv falhou:', log.errorMessage(err));
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
  if (config.debrid.rdWarm.enabled && rdWarmer.rdInPlay() && relevant.length) {
    const topReleases = relevant
      .map((r: any) => {
        const title = String(r.title || r.Title || '');
        const hash = String(extractInfoHash(r.infoHash || r.magnet || r.MagnetUri || r.Guid || r.hash) || '').toLowerCase();
        const isBr = Boolean(r.isBr) || looksPtBr(title);
        const audio = audioFromTitle(title);
        const dubbed = Boolean(r.dubbed) || ['Dublado', 'Dual', 'Nacional'].includes(String(audio)) || explicitPtAudio(title);
        const score = isBr && dubbed ? 80 : (dubbed ? 40 : 5);
        return { hash, score };
      })
      .filter((r: any) => /^[a-f0-9]{40}$/.test(r.hash));
    for (const item of topReleases.slice(0, 10)) {
      rdWarmer.enqueue([item.hash], item.score);
    }
  }
  harvested += 1;
  lastRunAt = Date.now();
  if (config.harvest.dashboardLastWorks > 0) {
    recentWorks.unshift({
      at: lastRunAt,
      imdbId: entry.imdbId,
      type: entry.type,
      season: entry.season ?? null,
      episode: entry.episode ?? null,
      recorded: added,
    });
    recentWorks.length = Math.min(recentWorks.length, config.harvest.dashboardLastWorks);
  }
  metrics.observe('harvest.ms', Date.now() - startedAt);
  return { ok: added > 0 || succeeded > 0, capped };
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
  } catch (err: unknown) {
    log.debug('[harvest] verificação de quota falhou:', log.errorMessage(err));
  }
}

/**
 * Um passo do ciclo: consome UMA obra da fila. Em produção só o setInterval
 * do start() chama; exportado para o teste cobrir a contabilidade do teto
 * horário sem subir o timer.
 */
async function tick() {
  const live = harvesterLive.effective();
  if (!live.harvestEnabled || paused || harvesterLive.isPaused() || inFlight || activity.recentUserTraffic(live.harvestIdleWindowMs)) return;
  try { cache.maintain(); } catch {}
  checkQuotaWarning().catch(() => {});
  // Semente: descobre obra popular que o índice ainda não conhece. Fora do
  // await de propósito — a rede da RapidAPI não pode atrasar a colheita, e o
  // cooldown do próprio módulo evita repetir no tick seguinte.
  nextSeeds()
    .then((obras) => obras.forEach((obra) => enqueue(obra as any)))
    .catch((err: unknown) => log.debug('[seed] ciclo falhou:', log.errorMessage(err)));
  if (!queue.length) return;
  if (queriesThisHour() >= live.harvestMaxPerHour) return;
  inFlight = true;
  let entry: HarvestEntry | undefined;
  try {
    entry = queue.shift();
    if (!entry) return;
    persistQueue();
    const identity = obraIdentity(entry);
    const { ok, capped } = await harvestOne(entry);
    metrics.count(ok ? 'harvest.done' : 'harvest.empty');
    if (capped) {
      // Obra cortada no meio pelo teto volta para a FRENTE da fila: terminar o
      // que já começou vale mais que abrir obra nova, porque um registro
      // parcial no índice já conta como cobertura para o idxPoolCovered — a
      // busca passaria a ser servida de uma lista incompleta. O contador de
      // tentativas evita que uma obra cara segure a fila para sempre.
      const tries = (attemptsByObra.get(identity) || 0) + 1;
      attemptsByObra.set(identity, tries);
      if (tries <= 3) {
        metrics.count('harvest.capped');
        queue.unshift(entry);
        persistQueue();
      } else {
        attemptsByObra.delete(identity);
      }
    } else {
      attemptsByObra.delete(identity);
    }
  } catch (err: unknown) {
    metrics.count('harvest.failed');
    if (entry) {
      const tries = (attemptsByObra.get(obraIdentity(entry)) || 0) + 1;
      attemptsByObra.set(obraIdentity(entry), tries);
      // Falha de rede pode ser transitória: volta pro fim da fila até 3 vezes.
      if (tries <= 3) queue.push(entry);
      else attemptsByObra.delete(obraIdentity(entry));
      persistQueue();
    }
    log.warn('[harvest] ciclo falhou:', log.errorMessage(err));
  } finally {
    inFlight = false;
  }
}

/** Pausa operacional do painel: comuta no módulo e persiste no live. */
function setPaused(value: boolean) {
  paused = Boolean(value);
  harvesterLive.setPaused(paused);
  return paused;
}

/** Esvazia a fila de colheita imediatamente a pedido do operador. */
function clearQueue(): { cleared: number } {
  const count = queue.length;
  queue = [];
  cache.forget(QUEUE_KEY);
  return { cleared: count };
}

/**
 * Processa uma pequena fatia imediatamente, sem furar freio de tráfego nem
 * orçamento horário. O painel chama isto explicitamente; o intervalo normal
 * continua responsável pelo restante da fila.
 */
async function drain(maxWorks?: number) {
  const live = harvesterLive.effective();
  const limit = Math.max(0, Math.min(live.harvestDrainMaxWorks, Math.trunc(Number(maxWorks ?? live.harvestDrainMaxWorks) || 0)));
  let drained = 0;
  while (drained < limit && queue.length && !paused && !harvesterLive.isPaused() && !inFlight) {
    if (activity.recentUserTraffic(live.harvestIdleWindowMs) || queriesThisHour() >= live.harvestMaxPerHour) break;
    const before = queue.length;
    await tick();
    if (queue.length >= before) break;
    drained += 1;
  }
  return { drained, queueRemaining: queue.length, paused: paused || harvesterLive.isPaused() };
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
  const live = harvesterLive.effective();
  const isPause = paused || harvesterLive.isPaused();
  return {
    enabled: live.harvestEnabled && config.releaseIndex.enabled,
    paused: isPause,
    queueDepth: queue.length,
    queueMax: live.harvestQueueMax,
    harvested,
    queriesThisHour: queriesThisHour(),
    maxPerHour: live.harvestMaxPerHour,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    idleWindowMs: live.harvestIdleWindowMs,
    queuePreview: queue.slice(0, config.harvest.queuePreview).map((entry) => ({ ...entry })),
    lastWorks: recentWorks.map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
    config: harvesterLive.snapshot(),
  };
}

export { enqueue, start, status, tick, setPaused, drain, clearQueue };
export default { enqueue, start, status, tick, setPaused, drain, clearQueue };
