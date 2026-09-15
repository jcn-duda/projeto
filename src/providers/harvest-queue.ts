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
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as releaseIndex from '../utils/release-index.js';
import * as harvesterLive from '../utils/harvester-live.js';
import { hasBrDubbed } from '../utils/br-gap.js';

export type HarvestEntry = {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number | null;
  episode?: number | null;
  reason: string;
  enqueuedAt: number;
  // Sinal de painel (Etapa 2): entrada devolvida à FRENTE da fila por
  // preempção de tráfego. Não entra na ordenação — é o head() com o
  // enqueuedAt original que a coloca à frente do próprio rank.
  resumed?: boolean;
};

// A fila inteira vive numa chave só (ver cabeçalho). Persistência best-effort
// como todo L2.
const QUEUE_KEY = `${prefix('harvest')}q`;

let queue: HarvestEntry[] = [];

export function obraIdentity(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode'>) {
  return `${entry.imdbId}:${entry.season ?? ''}:${entry.episode ?? ''}`;
}

// Janela de prioridade própria de uma entrada `br-gap` recém-promovida (Fase 5).
// A lacuna de dublado acabou de ser provada e o colhedor é a rede de segurança da
// sonda dirigida: por até 1h o `br-gap` fura `popular`/`miss` — inclusive as que
// furariam pelo bound de fome (`harvestBrMaxWaitMs`). Passada a janela a entrada
// volta às regras normais (evidência BR, anti-fome, FIFO), para não monopolizar a
// frente da fila para sempre.
export const BR_GAP_PRIORITY_WINDOW_MS = 60 * 60 * 1000;

// Precedência de promoção no enqueue (Fase 5): `next-episode` > `br-gap` >
// demais. Só promove quem SOBE — trocar um `next-episode` por `br-gap` seria
// rebaixar o play real do usuário, que é o pedido mais forte da fila.
const REASON_PRIORITY: Record<string, number> = { 'next-episode': 2, 'br-gap': 1 };

function reasonPriority(reason: string): number {
  return REASON_PRIORITY[reason] ?? 0;
}

/** O motivo novo é mais forte que o corrente? (promoção só sobe, nunca rebaixa) */
function isPromotion(currentReason: string, incomingReason: string): boolean {
  return reasonPriority(incomingReason) > reasonPriority(currentReason);
}

/** `br-gap` promovido/enfileirado dentro da janela de prioridade própria. */
function isRecentBrGap(entry: HarvestEntry, now: number): boolean {
  return entry.reason === 'br-gap' && now - entry.enqueuedAt < BR_GAP_PRIORITY_WINDOW_MS;
}

/**
 * Evidência BR para priorizar a fila (Fase 3.2). Pura e barata (in-memory):
 * play real (`next-episode`) vence; na ausência, o índice já ter provado
 * release BR dublada conta; o resto segue FIFO. Nunca escreve no debrid.
 */
function brEvidenceRank(entry: HarvestEntry): number {
  if (entry.reason === 'next-episode') return 3;
  // Evidência por OBRA (pack cobre a temporada), mesma regra BR-gap/F3: o post
  // que prometia PT mas era EN não prova BR tocável — só enganaria a fila.
  if (hasBrDubbed(releaseIndex.lookupQuiet(entry.imdbId, { season: entry.season, episode: entry.episode }))) return 2;
  return 0;
}

/**
 * Tier de precedência (Fase 5). `next-episode` (play real) e `br-gap` recente
 * são URGÊNCIAS OPERACIONAIS: ficam acima do tier regular com `harvestBrFirst`
 * ligado OU desligado. Desligar a flag restaura FIFO apenas ENTRE as entradas
 * regulares — não desarma os dois pedidos explícitos. `next-episode` é o topo
 * absoluto (pedido real do usuário); `br-gap` recente é a lacuna de dublado
 * recém-provada, rede de segurança da sonda dirigida.
 *
 * O anti-fome (`harvestBrMaxWaitMs`) opera DENTRO do tier regular. Sob vazão
 * sustentada ≥ capacidade dos urgentes, backlog regular pode esperar — decisão
 * consciente. A janela de 1h limita CADA br-gap individual (depois disso ele cai
 * para o tier regular); não existe promessa de bound duro global.
 */
function priorityTier(entry: HarvestEntry, now: number): number {
  if (entry.reason === 'next-episode') return 2;
  if (isRecentBrGap(entry, now)) return 1;
  return 0;
}

/**
 * Ordena a fila e devolve UMA CÓPIA — nunca muta a entrada. As urgências
 * `next-episode`/`br-gap recente` (Fase 5) vêm sempre primeiro; abaixo delas
 * (tier regular), com `harvestBrFirst` ligado, rank de evidência BR desc, depois
 * FIFO por enqueuedAt, com bound de fome: obra sem evidência BR esperando além
 * de `harvestBrMaxWaitMs` sobe para a frente — obra pedida pelo usuário não pode
 * morrer de fome atrás de conteúdo BR. Desligado devolve FIFO por enqueuedAt
 * APENAS no tier regular: a ordem persistida pode ter sido priorizada por uma
 * sessão anterior com a flag ligada, e desligar ao vivo precisa restaurar FIFO
 * mesmo assim — sem desligar as exceções operacionais.
 */
export function prioritizeQueue(queue: HarvestEntry[]): HarvestEntry[] {
  const live = harvesterLive.effective();
  const now = Date.now();
  const wait = live.harvestBrMaxWaitMs;
  // O rank de evidência BR só é consultado com a priorização ligada — sem ela a
  // ordenação é FIFO e o `lookupQuiet` seria trabalho jogado fora.
  const rank = new Map<string, number>();
  if (live.harvestBrFirst) {
    for (const e of queue) rank.set(obraIdentity(e), brEvidenceRank(e));
  }
  return [...queue].sort((a, b) => {
    const ta = priorityTier(a, now);
    const tb = priorityTier(b, now);
    if (ta !== tb) return tb - ta;
    if (!live.harvestBrFirst) return a.enqueuedAt - b.enqueuedAt;
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

// TTL do dedupe por obra+motivo: re-enfileirar a cada busca enchia a fila.
const HARVEST_DEDUPE_TTL_S = 12 * 3600;

function queueDedupeKey(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode' | 'reason'>) {
  return `${prefix('harvest')}seen:${crypto.createHash('sha256').update(`${obraIdentity(entry)}:${entry.reason}`).digest('hex')}`;
}

/** Já enfileirada nos últimos 12h (mesma obra+motivo)? NÃO renova o TTL. */
function wasRecentlyQueued(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode' | 'reason'>) {
  return cache.get(queueDedupeKey(entry)) === 1;
}

/** Grava/renova o dedupe da obra+motivo — só quando o pedido é ACEITO. */
function markRecentlyQueued(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode' | 'reason'>) {
  cache.set(queueDedupeKey(entry), 1, HARVEST_DEDUPE_TTL_S);
}

/**
 * Enfileira uma obra para colheita em fundo. Alimentado por: busca com lacuna
 * no índice (miss/gap) e episódio seguinte de série assistida. Nunca lança e
 * nunca bloqueia — é fogo-e-esquece por contrato.
 *
 * Fase 5: a obra já na fila aceita PROMOÇÃO de motivo (`next-episode` >
 * `br-gap` > demais), sem duplicar e sem rebaixar. A promoção renova o
 * `enqueuedAt` ("pedido agora") e a entrada sobe pela ordem efetiva (o
 * `br-gap` recente tem tier próprio em `prioritizeQueue`). O dedupe de 12h é
 * gravado/renovado DEPOIS da decisão — gravá-lo antes engolia a promoção
 * (obra enfileirada como `miss` nunca virava `br-gap`).
 */
export function enqueue(entry: Omit<HarvestEntry, 'enqueuedAt'>) {
  const live = harvesterLive.effective();
  if (!live.harvestEnabled || !config.releaseIndex.enabled) return;
  const imdbId = String(entry.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return;
  if (entry.type !== 'movie' && entry.type !== 'series') return;
  const full: HarvestEntry = { ...entry, imdbId, enqueuedAt: Date.now() };

  // Duplicata/promoção ANTES do dedupe (Fase 5): o dedupe é por obra+motivo, e
  // gravá-lo antes de decidir deixava um pedido mais forte sem efeito quando o
  // motivo fraco já estava na fila.
  const existing = queue.find((q) => obraIdentity(q) === obraIdentity(full));
  if (existing) {
    if (!isPromotion(existing.reason, full.reason)) return; // duplicata simples
    const from = existing.reason;
    existing.reason = full.reason;
    existing.enqueuedAt = full.enqueuedAt;
    // Promoção aceita grava/renova o dedupe: sem isso a mesma busca repetiria a
    // promoção (e o "pedido agora") a cada abertura.
    markRecentlyQueued(full);
    reorder();
    persist();
    // Métrica própria: promoção não é enqueue novo e não pode inflar
    // `harvest.enqueued` (que mede entradas adicionadas à fila).
    metrics.count('harvest.queue.promoted');
    log.debug(`[harvest] fila promovida: ${obraIdentity(existing)} ${from} -> ${full.reason}`);
    return;
  }

  if (wasRecentlyQueued(full)) return;
  markRecentlyQueued(full);
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

/**
 * Volta a obra para a FRENTE da fila (cortada pelo teto: terminar primeiro).
 *
 * Corrida in-flight (Fase 5), espelhando o `tail`: a identidade pode ter sido
 * re-enfileirada — e promovida — enquanto a obra estava em voo no `harvestOne`.
 * Não duplica; o pedido em voo volta à frente (head semantics) carregando o
 * motivo de MAIOR precedência entre os dois (`next-episode` > `br-gap` >
 * demais), sem rebaixar o que já estava na fila. Não conta enqueue/promoted.
 */
export function head(entry: HarvestEntry): void {
  const idx = queue.findIndex((q) => obraIdentity(q) === obraIdentity(entry));
  if (idx < 0) {
    queue.unshift(entry);
    return;
  }
  const queued = queue[idx];
  if (isPromotion(queued.reason, entry.reason)) {
    // Mantém `enqueuedAt`/`resumed` da entrada que já estava na fila; só o
    // motivo sobe.
    queued.reason = entry.reason;
  }
  queue.splice(idx, 1);
  queue.unshift(queued);
}

/**
 * Devolve a obra para o FIM da fila (falha transitória de rede / adiamento).
 *
 * Corrida in-flight (Fase 5): enquanto a obra estava em voo no `harvestOne`, a
 * busca pode ter re-enfileirado a MESMA identidade — e, se provou lacuna BR ou o
 * episódio seguinte, já promovido o motivo. Empilhar a entrada original aqui
 * duplicaria a obra e poderia rebaixar a promoção. A identidade já presente é
 * mantida como está (é o pedido mais recente, com o `enqueuedAt` renovado) e só
 * sobe o motivo quando a entrada em voo tem precedência MAIOR (`next-episode` >
 * `br-gap` > demais). Não conta enqueue/promoted — a obra não mudou de estado na
 * fila, só foi devolvida.
 */
export function tail(entry: HarvestEntry): void {
  const idx = queue.findIndex((q) => obraIdentity(q) === obraIdentity(entry));
  if (idx < 0) {
    queue.push(entry);
    return;
  }
  const queued = queue[idx];
  if (isPromotion(queued.reason, entry.reason)) {
    // Mantém `enqueuedAt`/`resumed` da entrada que já estava na fila; só o
    // motivo sobe.
    queued.reason = entry.reason;
  }
}

/** Amostra do painel: ordem EFETIVA (priorizada), já copiada. */
export function preview(limit: number): HarvestEntry[] {
  return prioritizeQueue(queue).slice(0, limit).map((entry) => ({ ...entry }));
}
