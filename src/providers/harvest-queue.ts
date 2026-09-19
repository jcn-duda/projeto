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
import * as harvestInflight from './harvest-inflight.js';
import { reasonPriority, isPromotion, obraIdentity, isRecentBrGap, BR_GAP_PRIORITY_WINDOW_MS } from './harvest-reason.js';

export { obraIdentity, isRecentBrGap, BR_GAP_PRIORITY_WINDOW_MS };

export type HarvestEntry = {
  imdbId: string;
  type: 'movie' | 'series';
  season?: number | null;
  episode?: number | null;
  reason: string;
  enqueuedAt: number;
  // Instante da JANELA DE PRIORIDADE do `br-gap` (Fase 5). Separado do
  // `enqueuedAt`: a promoção NÃO reseta a fome — a obra vira urgente por 1h
  // sem perder o bound anti-fome. Ausente em entrada antiga: cai no
  // `enqueuedAt` (janela conservadora, nunca maior que a real).
  priorityAt?: number;
  // Sinal de painel (Etapa 2): devolvida à FRENTE por preempção de tráfego.
  // Não entra na ordenação — é o head() com o enqueuedAt original que a coloca
  // à frente do próprio rank.
  resumed?: boolean;
  // Sonda dirigida (Fase 4): OR-aderente. Marcada, a execução roda o modo
  // probe (interseção index-only∩pt-BR) mesmo com motivo mais forte — a
  // precedência do reason na ordenação é preservada, só a execução muda.
  brProbe?: boolean;
  // Nasceu FULL e ganhou a flag por promoção: o desfecho reencaminha o `reason`
  // dela (o pedido completo) sem a flag.
  fullBase?: boolean;
};

/**
 * Resultado do enqueue, para quem PRECISA saber se o pedido virou trabalho
 * (a sonda só grava `pending` com a entrada apta na fila). Os consumidores
 * antigos seguem ignorando o retorno.
 */
export type EnqueueOutcome = {
  accepted: boolean;
  // `coalesced`: a obra já estava em voo no `harvestOne` (item aberto 8) — nada novo na fila.
  reason: 'disabled' | 'invalid' | 'queued' | 'promoted' | 'duplicate' | 'dedupe' | 'coalesced';
};

// A fila inteira vive numa chave só (ver cabeçalho). Persistência best-effort
// como todo L2.
const QUEUE_KEY = `${prefix('harvest')}q`;

let queue: HarvestEntry[] = [];

/**
 * Evidência BR para priorizar a fila (Fase 3.2), pura e barata (in-memory):
 * play real vence; na ausência, o índice já ter provado release BR dublada
 * conta; o resto segue FIFO. Nunca escreve no debrid.
 */
function brEvidenceRank(entry: HarvestEntry): number {
  if (entry.reason === 'next-episode') return 3;
  // Evidência por OBRA (pack cobre a temporada), mesma regra BR-gap/F3: o post
  // que prometia PT mas era EN não prova BR tocável — só enganaria a fila.
  if (hasBrDubbed(releaseIndex.lookupQuiet(entry.imdbId, { season: entry.season, episode: entry.episode }))) return 2;
  return 0;
}

/**
 * Tier de precedência (Fase 5). `next-episode` (topo absoluto, play real) e
 * `br-gap` recente (lacuna recém-provada, rede de segurança da sonda) são
 * URGÊNCIAS OPERACIONAIS: ficam acima do tier regular com `harvestBrFirst`
 * ligado OU desligado; o toggle restaura FIFO só ENTRE as regulares.
 *
 * O anti-fome (`harvestBrMaxWaitMs`) opera DENTRO do tier regular. Sob vazão
 * sustentada ≥ capacidade dos urgentes, backlog regular pode esperar — decisão
 * consciente. A janela de 1h limita CADA br-gap individual; não há bound duro
 * global.
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
 * `br-gap` > demais), sem duplicar e sem rebaixar. A promoção NÃO renova o
 * `enqueuedAt` ("pedido agora"): a fome continua contando desde o pedido
 * original e, quando o motivo é `br-gap`, a janela própria passa a contar do
 * `priorityAt` gravado/atualizado na promoção. A entrada sobe pela ordem
 * efetiva (o `br-gap` recente tem tier próprio em `prioritizeQueue`). O dedupe
 * de 12h é gravado/renovado DEPOIS da decisão — gravá-lo antes engolia a
 * promoção (obra enfileirada como `miss` nunca virava `br-gap`).
 *
 * Item aberto 8: a obra EM VOO no `harvestOne` também aceita a intenção
 * (coalescing genérico, qualquer motivo) — a execução corrente absorve o
 * pedido, sem criar segunda entrada.
 */
export function enqueue(entry: Omit<HarvestEntry, 'enqueuedAt'>): EnqueueOutcome {
  const live = harvesterLive.effective();
  if (!live.harvestEnabled || !config.releaseIndex.enabled) return { accepted: false, reason: 'disabled' };
  const imdbId = String(entry.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return { accepted: false, reason: 'invalid' };
  if (entry.type !== 'movie' && entry.type !== 'series') return { accepted: false, reason: 'invalid' };
  const full: HarvestEntry = { ...entry, imdbId, enqueuedAt: Date.now() };
  if (full.reason === 'br-gap') full.priorityAt = full.enqueuedAt;

  // Duplicata/promoção ANTES do dedupe (Fase 5): o dedupe é por obra+motivo, e
  // gravá-lo antes de decidir deixava um pedido mais forte sem efeito quando o
  // motivo fraco já estava na fila.
  const existing = queue.find((q) => obraIdentity(q) === obraIdentity(full));
  if (existing) {
    // A flag dirigida é OR-aderente: uma vez pedida, a execução é probe mesmo
    // que o motivo não seja promovido (ex.: `next-episode` já presente).
    const probeUpgrade = Boolean(full.brProbe) && !existing.brProbe;
    if (probeUpgrade) {
      existing.brProbe = true;
      existing.fullBase = true; // a cobertura completa da entrada sobrevive ao desfecho
    }
    if (!isPromotion(existing.reason, full.reason)) {
      if (!probeUpgrade) return { accepted: true, reason: 'duplicate' }; // duplicata simples
      persist();
      return { accepted: true, reason: 'queued' };
    }
    const from = existing.reason;
    existing.reason = full.reason;
    // Promoção NÃO zera o `enqueuedAt`: sobe o motivo sem apagar a fome (o
    // bound `harvestBrMaxWaitMs` continua contando desde o pedido original). A
    // janela própria do `br-gap` passa a contar de `priorityAt`.
    if (full.reason === 'br-gap') existing.priorityAt = full.enqueuedAt;
    markRecentlyQueued(full);
    reorder();
    persist();
    // Métrica própria: promoção não é enqueue novo e não pode inflar
    // `harvest.enqueued` (que mede entradas adicionadas à fila).
    metrics.count('harvest.queue.promoted');
    log.debug(`[harvest] fila promovida: ${obraIdentity(existing)} ${from} -> ${full.reason}`);
    return { accepted: true, reason: 'promoted' };
  }

  // Coalescing GENÉRICO em voo (item aberto 8): a MESMA obra está sendo colhida
  // AGORA — qualquer motivo funde a intenção na execução corrente em vez de
  // criar segunda entrada. Roda ANTES do dedupe (pedido mais forte não pode ser
  // engolido por um dedupe fraco); o dedupe é marcado como pedido aceito e
  // `harvest.enqueued`/`promoted` não são inflados.
  if (
    harvestInflight.coalesce(obraIdentity(full), {
      reason: full.reason,
      rank: reasonPriority(full.reason),
      brProbe: Boolean(full.brProbe),
      priorityAt: full.priorityAt,
    })
  ) {
    markRecentlyQueued(full);
    metrics.count('harvest.coalesced');
    log.debug(`[harvest] ${obraIdentity(full)} em voo: intenção ${full.reason} coalescida`);
    return { accepted: true, reason: 'coalesced' };
  }

  if (wasRecentlyQueued(full)) return { accepted: false, reason: 'dedupe' };
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
  return { accepted: true, reason: 'queued' };
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

/** Existe sonda dirigida esperando? (o dreno sob tráfego testa antes do tick) */
export function hasProbe(): boolean {
  return queue.some((q) => q.brProbe === true);
}

/**
 * Primeira entrada DIRIGIDA (brProbe), removida — execução FORA DE TURNO sob
 * tráfego: a sonda (~3 consultas) roda durante o uso mesmo sem ser a cabeça
 * (`next-episode` ordena acima de `br-gap`; na fila cheia de plays a sonda
 * nunca chegaria ao topo para furar o freio). `null` sem sonda na fila.
 */
export function takeProbe(): HarvestEntry | null {
  const idx = queue.findIndex((q) => q.brProbe === true);
  if (idx < 0) return null;
  return queue.splice(idx, 1)[0] ?? null;
}

/**
 * Entrada já enfileirada desta obra (cópia viva, dono é a fila). Usada pela
 * sonda para confirmar que o pedido dirigido virou trabalho ANTES de gravar
 * `pending` — sem entrada apta, o worker não executaria o modo probe.
 */
export function findQueued(entry: Pick<HarvestEntry, 'imdbId' | 'season' | 'episode'>): HarvestEntry | undefined {
  return queue.find((q) => obraIdentity(q) === obraIdentity(entry));
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
  // Flag dirigida OR-aderente: head/tail não podem apagar um pedido de probe.
  if (entry.brProbe && !queued.brProbe) {
    queued.brProbe = true;
    queued.fullBase = true;
  }
  if (isPromotion(queued.reason, entry.reason)) {
    // Mantém `enqueuedAt`/`resumed` da entrada que já estava na fila; só o
    // motivo sobe — a fome não é resetada, e a janela do br-gap vem de
    // `priorityAt`. Só copia quando a entrada JÁ tem o campo: inventar um
    // instante aqui estenderia a janela de prioridade artificialmente.
    queued.reason = entry.reason;
    if (entry.reason === 'br-gap' && entry.priorityAt != null) queued.priorityAt = entry.priorityAt;
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
  if (entry.brProbe && !queued.brProbe) {
    queued.brProbe = true;
    queued.fullBase = true;
  }
  if (isPromotion(queued.reason, entry.reason)) {
    // Mantém `enqueuedAt`/`resumed` da entrada que já estava na fila; só o
    // motivo sobe — a fome não é resetada.
    queued.reason = entry.reason;
    if (entry.reason === 'br-gap' && entry.priorityAt != null) queued.priorityAt = entry.priorityAt;
  }
}

/** Amostra do painel: ordem EFETIVA (priorizada), já copiada. */
export function preview(limit: number): HarvestEntry[] {
  return prioritizeQueue(queue).slice(0, limit).map((entry) => ({ ...entry }));
}
