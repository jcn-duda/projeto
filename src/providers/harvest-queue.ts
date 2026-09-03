// Fila persistente do colhedor: as obras a colher vivem em UMA chave
// (`harvest:v1:q`) — obras são poucas (teto HARVEST_QUEUE_MAX), e ler/escrever
// um array é atômico dentro do processo — sem scan de chaves, que o cache Map
// não oferece. Separada do ciclo (harvester.ts) porque é o estado compartilhado
// entre quem enfileira (busca, semente, painel) e quem consome (tick/drain);
// o ciclo só a toca pelas primitivas daqui, então o dono do array é único.
import crypto from 'node:crypto';
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as metrics from '../utils/metrics.js';
import * as releaseIndex from '../utils/release-index.js';
import * as harvesterLive from '../utils/harvester-live.js';

export type HarvestEntry = {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number | null;
  episode?: number | null;
  reason: string;
  enqueuedAt: number;
};

// A fila inteira vive numa chave só (ver cabeçalho). Persistência best-effort
// como todo L2.
const QUEUE_KEY = `${prefix('harvest')}q`;

let queue: HarvestEntry[] = [];

export function obraIdentity(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode'>) {
  return `${entry.imdbId}:${entry.season ?? ''}:${entry.episode ?? ''}`;
}

/**
 * Evidência BR para priorizar a fila (Fase 3.2). Pura e barata (in-memory):
 * play real (`next-episode`) vence; na ausência, o índice já ter provado
 * release BR dublada conta; o resto segue FIFO. Nunca escreve no debrid.
 */
function brEvidenceRank(entry: HarvestEntry): number {
  if (entry.reason === 'next-episode') return 3;
  // Evidência por OBRA (pack cobre a temporada), nunca release lied: o post
  // que prometia PT mas era EN não prova BR tocável — só enganaria a fila.
  if (releaseIndex.lookupQuiet(entry.imdbId, { season: entry.season, episode: entry.episode }).some((r) => r.isBr && r.dubbed && !r.lied)) return 2;
  return 0;
}

/**
 * Ordena a fila e devolve UMA CÓPIA — nunca muta a entrada. Com `harvestBrFirst`
 * ligado, rank de evidência BR desc, depois FIFO por enqueuedAt, com bound de
 * fome: obra sem evidência BR esperando além de `harvestBrMaxWaitMs` sobe para
 * a frente — obra pedida pelo usuário não pode morrer de fome atrás de conteúdo
 * BR. Desligado devolve a ordem exata (FIFO) por enqueuedAt: a ordem persistida
 * pode ter sido priorizada por uma sessão anterior com a flag ligada, e
 * desligar ao vivo precisa restaurar FIFO mesmo assim.
 */
export function prioritizeQueue(queue: HarvestEntry[]): HarvestEntry[] {
  const live = harvesterLive.effective();
  const now = Date.now();
  if (!live.harvestBrFirst) {
    return [...queue].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }
  const wait = live.harvestBrMaxWaitMs;
  const rank = new Map<string, number>();
  for (const e of queue) rank.set(obraIdentity(e), brEvidenceRank(e));
  return [...queue].sort((a, b) => {
    const ra = rank.get(obraIdentity(a)) ?? 0;
    const rb = rank.get(obraIdentity(b)) ?? 0;
    const aStarved = wait > 0 && now - a.enqueuedAt >= wait && ra === 0;
    const bStarved = wait > 0 && now - b.enqueuedAt >= wait && rb === 0;
    if (aStarved !== bStarved) return aStarved ? -1 : 1;
    if (ra !== rb) return rb - ra;
    return a.enqueuedAt - b.enqueuedAt;
  });
}


export function load() {
  const stored = cache.get(QUEUE_KEY);
  if (Array.isArray(stored)) queue = stored.filter((e) => e && /^tt\d+$/.test(String(e.imdbId)));
  // Sempre unifica a ordem após carregar: a sessão que gravou pode ter usado
  // outra config de priorização, e a ordem persistida não vale quando ela muda.
  queue = prioritizeQueue(queue);
}

export function persist() {
  if (!queue.length) {
    cache.forget(QUEUE_KEY);
    return;
  }
  const live = harvesterLive.effective();
  // Terceiro caminho de descarte (Etapa 1): obra capped/preemptada volta por
  // head() além do teto e o slice corta a cauda sem passar pelo enqueue — sem
  // este contador o descarte sumiria do diagnóstico.
  const kept = queue.slice(0, live.harvestQueueMax);
  const dropped = queue.length - kept.length;
  if (dropped > 0) metrics.count('harvest.queue.dropped', dropped);
  cache.set(QUEUE_KEY, kept, live.harvestEntryTtl);
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
export function enqueue(entry: Omit<HarvestEntry, 'enqueuedAt'>) {
  const live = harvesterLive.effective();
  if (!live.harvestEnabled || !config.releaseIndex.enabled) return;
  const imdbId = String(entry.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return;
  if (entry.type !== 'movie' && entry.type !== 'series') return;
  const full: HarvestEntry = { ...entry, imdbId, enqueuedAt: Date.now() };
  if (recentlyQueued(full)) return;
  if (queue.some((q) => obraIdentity(q) === obraIdentity(full))) return;
  if (live.harvestBrFirst) {
    // Com prioridade ativa, o teto NUNCA pode descartar a cabeça mais
    // importante só porque ela é mais antiga. Reordena e remove da CAUDA — a
    // de menor prioridade (empate: a mais nova) — até abrir espaço, depois
    // adiciona a nova; a ordem efetiva volta a valer no próximo passo/status.
    queue = prioritizeQueue(queue);
    while (queue.length >= live.harvestQueueMax) {
      queue.pop();
      metrics.count('harvest.queue.dropped');
    }
    queue.push(full);
  } else {
    // Sem priorização mantém a semântica antiga: obra nova empurra a mais
    // velha. A fila é oportunidade de colheita, não backlog sagrado.
    while (queue.length >= live.harvestQueueMax) {
      queue.shift();
      metrics.count('harvest.queue.dropped');
    }
    queue.push(full);
  }
  persist();
  metrics.count('harvest.enqueued');
}

/** Esvazia a fila de colheita imediatamente a pedido do operador. */
export function clearQueue(): { cleared: number } {
  const count = queue.length;
  queue = [];
  cache.forget(QUEUE_KEY);
  return { cleared: count };
}

// Primitivas de acesso do ciclo (tick/drain/status): o array nunca sai daqui —
// o corte entre fila e ciclo só é seguro se o estado tiver um dono único.
export function isEmpty(): boolean {
  return queue.length === 0;
}

export function depth(): number {
  return queue.length;
}

/** Reaplica a ordem efetiva (FIFO ou priorização BR) sobre a fila corrente. */
export function reorder(): void {
  queue = prioritizeQueue(queue);
}

export function takeHead(): HarvestEntry | undefined {
  return queue.shift();
}

/** Volta a obra para a FRENTE da fila (cortada pelo teto: terminar primeiro). */
export function head(entry: HarvestEntry): void {
  queue.unshift(entry);
}

/** Devolve a obra para o FIM da fila (falha transitória de rede). */
export function tail(entry: HarvestEntry): void {
  queue.push(entry);
}

/** Amostra do painel: ordem EFETIVA (priorizada), já copiada. */
export function preview(limit: number): HarvestEntry[] {
  return prioritizeQueue(queue).slice(0, limit).map((entry) => ({ ...entry }));
}
