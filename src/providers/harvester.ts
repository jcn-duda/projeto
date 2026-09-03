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
//
// Este módulo é a ORQUESTRAÇÃO (tick/drain/start/status): a fila persistente
// mora em harvest-queue.ts e a colheita de uma obra (com o teto horário e o
// intervalo por indexer) em harvest-worker.ts. A direção é uma só — daqui para
// os irmãos; nenhum deles importa de volta.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as activity from './activity.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import debrid from '../debrid/index.js';
import { notify } from '../utils/notify.js';
import { nextSeeds } from './imdb-seed.js';
import * as harvesterLive from '../utils/harvester-live.js';
import { enqueue, clearQueue, prioritizeQueue, obraIdentity } from './harvest-queue.js';
import * as harvestQueue from './harvest-queue.js';
import type { HarvestEntry } from './harvest-queue.js';
import * as harvestWorker from './harvest-worker.js';

let started = false;
let inFlight = false;
// Pausa é operacional e deliberadamente não persiste: após restart o operador
// volta ao comportamento configurado no .env, sem uma ação temporária virar
// desligamento esquecido.
let paused = false;
// Contador de tentativas por obra: uma obra cara (teto estourando sempre ou
// rede morta) não pode segurar a fila para sempre.
const attemptsByObra = new Map<string, number>();

async function checkQuotaWarning() {
  if (!config.notify.enabled || !config.notify.webhookUrl) return;
  const adapter = config.debrid.service ? debrid.BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.accountStatus !== 'function') return;
  if (!config.debrid.apiKey || !config.debrid.envOperatorAccount) return;
  const quotaWarnKey = `${prefix('harvest')}quotaWarn`;
  const cooldownMs = config.harvest.quotaWarnCooldownMs;
  if (cooldownMs > 0 && cache.get(quotaWarnKey)) return;
  try {
    const status = await adapter.accountStatus(config.debrid.apiKey);
    if (cooldownMs > 0) {
      cache.set(quotaWarnKey, 1, Math.ceil(cooldownMs / 1000));
    }
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
    .then((obras) => obras.forEach((obra) => harvestQueue.enqueue(obra as any)))
    .catch((err: unknown) => log.debug('[seed] ciclo falhou:', log.errorMessage(err)));
  if (harvestQueue.isEmpty()) return;
  if (harvestWorker.queriesThisHour() >= live.harvestMaxPerHour) return;
  inFlight = true;
  let entry: HarvestEntry | undefined;
  try {
    // Sempre prioriza: com a flag desligada restaura FIFO, com ligada respeita
    // o rank BR e a fome — independentemente da ordem em que a fila estava.
    harvestQueue.reorder();
    entry = harvestQueue.takeHead();
    if (!entry) return;
    harvestQueue.persist();
    const identity = obraIdentity(entry);
    const { added, capped, preempted } = await harvestWorker.harvestOne(entry);
    if (preempted) {
      // Obra interrompida por tráfego volta à frente, SEM custo de tentativas
      // e SEM contar na eficácia: o usuário chegou — não é falha da obra, e a
      // meia-colheita não pode entrar duas vezes em done/empty. `resumed` marca
      // só para o painel; o spread preserva o enqueuedAt original, que é quem
      // decide a precedência dentro do rank no prioritizeQueue.
      harvestQueue.head({ ...entry, resumed: true });
      harvestQueue.persist();
      metrics.count('harvest.preempted');
    } else {
      // Contrato da Etapa 1 preservado: obra que CONCLUIU (ou foi cortada pelo
      // teto) conta eficácia. A preemptada nunca chega aqui — voltou à fila e
      // será recolhida como conclusão legítima depois.
      metrics.count(added > 0 ? 'harvest.done' : 'harvest.empty');
      if (capped) {
        // Obra cortada no meio pelo teto volta para a FRENTE da fila: terminar
        // o que já começou vale mais que abrir obra nova, porque um registro
        // parcial no índice já conta como cobertura para o idxPoolCovered — a
        // busca passaria a ser servida de uma lista incompleta. O contador de
        // tentativas evita que uma obra cara segure a fila para sempre.
        const tries = (attemptsByObra.get(identity) || 0) + 1;
        attemptsByObra.set(identity, tries);
        if (tries <= 3) {
          metrics.count('harvest.capped');
          harvestQueue.head(entry);
          harvestQueue.persist();
        } else {
          metrics.count('harvest.capped.dropped');
          attemptsByObra.delete(identity);
        }
      } else {
        attemptsByObra.delete(identity);
      }
    }
  } catch (err: unknown) {
    metrics.count('harvest.failed');
    if (entry) {
      const tries = (attemptsByObra.get(obraIdentity(entry)) || 0) + 1;
      attemptsByObra.set(obraIdentity(entry), tries);
      // Falha de rede pode ser transitória: volta pro fim da fila até 3 vezes.
      if (tries <= 3) harvestQueue.tail(entry);
      else attemptsByObra.delete(obraIdentity(entry));
      harvestQueue.persist();
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

/**
 * Processa uma pequena fatia imediatamente, sem furar freio de tráfego nem
 * orçamento horário. O painel chama isto explicitamente; o intervalo normal
 * continua responsável pelo restante da fila.
 */
async function drain(maxWorks?: number) {
  const live = harvesterLive.effective();
  const limit = Math.max(0, Math.min(live.harvestDrainMaxWorks, Math.trunc(Number(maxWorks ?? live.harvestDrainMaxWorks) || 0)));
  let drained = 0;
  while (drained < limit && !harvestQueue.isEmpty() && !paused && !harvesterLive.isPaused() && !inFlight) {
    if (activity.recentUserTraffic(live.harvestIdleWindowMs) || harvestWorker.queriesThisHour() >= live.harvestMaxPerHour) break;
    const before = harvestQueue.depth();
    await tick();
    if (harvestQueue.depth() >= before) break;
    drained += 1;
  }
  return { drained, queueRemaining: harvestQueue.depth(), paused: paused || harvesterLive.isPaused() };
}

function start() {
  if (started) return;
  started = true;
  if (!config.harvest.enabled || !config.releaseIndex.enabled) {
    log.info('[harvest] desativado (colhedor ou índice off)');
    return;
  }
  harvestQueue.load();
  const recovered = harvestQueue.depth();
  if (recovered) log.info(`[harvest] fila recuperada do disco: ${recovered} obra(s)`);
  const timer = setInterval(() => { tick().catch(() => {}); }, config.harvest.intervalMs);
  timer.unref();
}

/** Para o painel: estado do colhedor sem expor nada sensível. */
function status() {
  const live = harvesterLive.effective();
  const isPause = paused || harvesterLive.isPaused();
  const workerStats = harvestWorker.stats();
  return {
    enabled: live.harvestEnabled && config.releaseIndex.enabled,
    paused: isPause,
    queueDepth: harvestQueue.depth(),
    queueMax: live.harvestQueueMax,
    harvested: workerStats.harvested,
    queriesThisHour: harvestWorker.queriesThisHour(),
    maxPerHour: live.harvestMaxPerHour,
    lastRunAt: workerStats.lastRunAt ? new Date(workerStats.lastRunAt).toISOString() : null,
    idleWindowMs: live.harvestIdleWindowMs,
    queuePreview: harvestQueue.preview(config.harvest.queuePreview),
    lastWorks: workerStats.recentWorks.map((entry) => ({ ...entry, at: new Date(entry.at).toISOString() })),
    config: harvesterLive.snapshot(),
  };
}

// Superfície pública preservada: enqueue/clearQueue/prioritizeQueue vivem na
// fila, mas são reexportados daqui — consumidores e testes não mudam.
export { enqueue, clearQueue, prioritizeQueue, start, status, tick, setPaused, drain };
export default { enqueue, start, status, tick, setPaused, drain, clearQueue, prioritizeQueue };
