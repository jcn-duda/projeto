// Desfecho da colheita de UMA obra: finalização da sonda dirigida e
// reencaminhamento de UMA entrada quando a execução não conclui
// (falha/capped/preempção) — mais o caso em que um run DIRIGIDO não satisfaz um
// pedido de colheita completa coalescido em voo (item aberto 8).
//
// Extraído do `harvester.ts` pela catraca de linhas: o tick decide QUANDO
// colher; aqui mora o que fazer com o resultado. Os contadores de tentativa e
// preempção por obra vivem junto porque só este módulo os toca.
import * as metrics from '../utils/metrics.js';
import * as releaseIndex from '../utils/release-index.js';
import { finalizeBrProbe, noteBrProbePreempted } from './br-probe.js';
import * as harvestQueue from './harvest-queue.js';
import type { HarvestEntry } from './harvest-queue.js';

// Contador de tentativas por obra: uma obra cara (teto estourando sempre ou
// rede morta) não pode segurar a fila para sempre.
const attemptsByObra = new Map<string, number>();
// Preempções por obra — Map SEPARADO do attemptsByObra: tráfego não é falha
// (não dropa), mas após N preempções a obra vai para a cauda em vez de
// monopolizar a frente da fila.
const preemptsByObra = new Map<string, number>();

/** Intenção efetiva lida do slot em voo (base + coalescida). */
export type HarvestIntentSnapshot = {
  reason: string;
  brProbe: boolean;
  priorityAt?: number;
  full: { reason: string; priorityAt?: number } | null;
} | null;

/** Estado do desfecho, já resolvido pelo tick (motivo/flag fundidos). */
export type HarvestSettlement = {
  entry: HarvestEntry;
  identity: string;
  intent: HarvestIntentSnapshot;
  /** A execução (ou uma intenção coalescida) pede finalização da sonda. */
  isProbe: boolean;
  /** Entrada reencaminhada, com o motivo mais forte fundido. */
  returned: HarvestEntry;
  ok: boolean;
  added: number;
  capped: boolean;
  preempted: boolean;
  brFound: boolean;
  responded: number;
};

function probeWork(entry: HarvestEntry) {
  return {
    type: entry.type,
    imdbId: entry.imdbId,
    season: entry.season ?? null,
    episode: entry.episode ?? null,
  };
}

/**
 * A flag dirigida pertence à EXECUÇÃO (`entry.brProbe`), não à intenção
 * fundida: só sobrevive ao reencaminhamento quando a base era dirigida. Uma
 * sonda apenas COALESCIDA em voo (base FULL) não viaja — o run de base cobre o
 * subset dela e já foi finalizado/renovado por `finalizeProbeIfNeeded`. Sem
 * esta guarda, um run FULL com sonda coalescida voltava à fila como
 * `brProbe:true` e o retry era rebaixado ao subset (index-only∩pt-BR),
 * perdendo a colheita completa que o pedido original exigia.
 */
function reforwarded(entry: HarvestEntry, returned: HarvestEntry): HarvestEntry {
  if (entry.brProbe === true) return { ...returned, brProbe: true };
  if (returned.brProbe !== true) return returned;
  const clone = { ...returned };
  delete clone.brProbe;
  return clone;
}

/**
 * Sonda dirigida (Fase 4): o estado final é decidido AQUI, depois de o worker
 * ter rodado pelos controles do colhedor.
 * Ordem: achar BR vence teto (found prova valor, mesmo com a passada cortada);
 * `responded > 0` (dirigido) ou `ok` (coalescido, colheita completa) é a prova
 * de que houve resposta VÁLIDA — `jackett.search` engole falha e devolve `[]`,
 * e vazio não autoriza `empty`. Preempção NÃO finaliza: a obra volta à fila e o
 * lease é renovado.
 */
function finalizeProbeIfNeeded(s: HarvestSettlement): void {
  if (!s.isProbe) return;
  const work = probeWork(s.entry);
  if (s.preempted) noteBrProbePreempted(work);
  else if (s.brFound) finalizeBrProbe(work, 'found');
  else if (s.capped) finalizeBrProbe(work, 'capped');
  else if (s.entry.brProbe ? s.responded > 0 : s.ok) finalizeBrProbe(work, 'empty');
  else finalizeBrProbe(work, 'failed');
}

/** Aplica o desfecho de uma execução CONCLUÍDA (com ou sem preempção/teto). */
export function settleHarvest(s: HarvestSettlement): void {
  const { entry, identity, intent, returned } = s;
  finalizeProbeIfNeeded(s);

  // A intenção FULL coalescida (ou uma entrada FULL que foi promovida a
  // dirigida — `fullBase`) precisa de cobertura COMPLETA, mas SÓ quando o run
  // foi DIRIGIDO (`entry.brProbe === true`): um run dirigido cobre apenas o
  // subset index-only∩pt-BR e por isso não satisfaz o pedido completo que
  // chegou em voo. Um run REGULAR cobre a colheita inteira — o pedido
  // coalescido já foi absorvido e NÃO deixa resíduo (reenfileirar seria
  // duplicar trabalho que a execução corrente já fez). Se o run dirigido não
  // concluiu (preempção/teto), reenfileirar o `returned` dirigido rebaixaria o
  // pedido completo ao subset; o retry correto é o FULL (uma colheita completa
  // cobre o subset). O estado da sonda já foi finalizado/renovado por
  // `finalizeProbeIfNeeded` acima. Os contadores e a posição
  // (cabeça/cauda/drop) espelham exatamente os ramos originais.
  const fullPending = entry.brProbe === true ? fullIntentOf(entry, intent) : null;
  if (fullPending && s.preempted) {
    const tries = (preemptsByObra.get(identity) || 0) + 1;
    preemptsByObra.set(identity, tries);
    metrics.count('harvest.preempted');
    const fullReturned = fullEntry(entry, fullPending);
    fullReturned.resumed = true;
    if (tries <= 3) harvestQueue.head(fullReturned);
    else {
      harvestQueue.tail(fullReturned);
      metrics.count('harvest.preempted.deferred');
      preemptsByObra.delete(identity);
    }
    metrics.count('harvest.coalesced.full-kept');
    harvestQueue.persist();
    return;
  }
  if (fullPending && s.capped) {
    const tries = (attemptsByObra.get(identity) || 0) + 1;
    attemptsByObra.set(identity, tries);
    if (tries <= 3) {
      metrics.count('harvest.capped');
      harvestQueue.head(fullEntry(entry, fullPending));
      metrics.count('harvest.coalesced.full-kept');
    } else {
      metrics.count('harvest.capped.dropped');
      releaseIndex.clearPartial(entry.imdbId, { season: entry.season, episode: entry.episode });
      attemptsByObra.delete(identity);
    }
    harvestQueue.persist();
    return;
  }

  if (s.preempted) {
    // Obra interrompida por tráfego: SEM custo em attemptsByObra (não é
    // falha). Até 3 preempções volta à frente; a 4ª vai para a cauda
    // (`harvest.preempted.deferred`) para não monopolizar a fila — sem
    // dropar. `resumed` só para o painel; enqueuedAt original preservado.
    const tries = (preemptsByObra.get(identity) || 0) + 1;
    preemptsByObra.set(identity, tries);
    metrics.count('harvest.preempted');
    // A intenção fundida (motivo mais forte) VIAJA com a obra devolvida, mas a
    // flag dirigida só sobrevive quando a base era dirigida (`reforwarded`).
    const returnedPreempted = { ...reforwarded(entry, returned), resumed: true };
    if (tries <= 3) {
      harvestQueue.head(returnedPreempted);
    } else {
      harvestQueue.tail(returnedPreempted);
      metrics.count('harvest.preempted.deferred');
      preemptsByObra.delete(identity);
    }
    harvestQueue.persist();
    return;
  }

  // Conclusão sem preempção: zera o ciclo de preempções desta obra.
  preemptsByObra.delete(identity);
  // Contrato da Etapa 1 preservado: obra que CONCLUIU (ou foi cortada pelo teto)
  // conta eficácia. A preemptada nunca chega aqui — voltou à fila e será
  // recolhida como conclusão legítima depois.
  metrics.count(s.added > 0 ? 'harvest.done' : 'harvest.empty');
  if (s.capped) {
    // Obra cortada no meio pelo teto volta para a FRENTE da fila: terminar o
    // que já começou vale mais que abrir obra nova, porque um registro parcial
    // no índice já conta como cobertura para o idxPoolCovered — a busca
    // passaria a ser servida de uma lista incompleta. O contador de tentativas
    // evita que uma obra cara segure a fila para sempre.
    const tries = (attemptsByObra.get(identity) || 0) + 1;
    attemptsByObra.set(identity, tries);
    if (tries <= 3) {
      metrics.count('harvest.capped');
      // A intenção fundida sobrevive ao retorno por teto — sem a flag dirigida
      // quando a base era FULL (`reforwarded`).
      harvestQueue.head(reforwarded(entry, returned));
      harvestQueue.persist();
    } else {
      // Drop da fila: limpa partial grudado (ex.: raiz semeada) antes de apagar
      // attempts — senão o flag bloqueia fast-path por ~30d.
      metrics.count('harvest.capped.dropped');
      releaseIndex.clearPartial(entry.imdbId, { season: entry.season, episode: entry.episode });
      attemptsByObra.delete(identity);
    }
    return;
  }

  attemptsByObra.delete(identity);
  // Run DIRIGIDO cobre só o subset index-only∩pt-BR: um pedido de colheita
  // COMPLETA coalescido em voo NÃO foi satisfeito e volta à fila como UMA
  // entrada (sem a flag dirigida — a sonda já finalizou pelo resultado do run).
  // O run completo cobriu tudo o que coalesceu.
  if (fullPending) {
    harvestQueue.tail(fullEntry(entry, fullPending));
    harvestQueue.persist();
    metrics.count('harvest.coalesced.full-requeued');
  }
}

/**
 * Intenção FULL pendente do run: o que coalesceu em voo (`intent.full`) ou uma
 * entrada FULL que foi promovida a dirigida (`fullBase` — o motivo da própria
 * entrada é o pedido completo; a promoção só anexa a flag).
 */
function fullIntentOf(
  entry: HarvestEntry,
  intent: HarvestIntentSnapshot,
): { reason: string; priorityAt?: number } | null {
  if (intent?.full) return intent.full;
  if (entry.brProbe === true && entry.fullBase === true) {
    return {
      reason: entry.reason,
      ...(entry.priorityAt != null ? { priorityAt: entry.priorityAt } : {}),
    };
  }
  return null;
}

/** A entrada FULL reencaminhada: identidade da obra, motivo FULL, sem dirigida. */
function fullEntry(
  entry: HarvestEntry,
  full: { reason: string; priorityAt?: number },
): HarvestEntry {
  const fullReturned: HarvestEntry = {
    imdbId: entry.imdbId,
    type: entry.type,
    season: entry.season,
    episode: entry.episode,
    reason: full.reason,
    enqueuedAt: entry.enqueuedAt,
  };
  if (full.priorityAt != null) fullReturned.priorityAt = full.priorityAt;
  return fullReturned;
}

/**
 * Falha no meio do worker: reencaminha UMA entrada (até 3 vezes) com o motivo
 * mais forte fundido em voo e finaliza a sonda como falha — libera seeds pelo
 * retry curto e destrava o aviso, em vez de ficar pending até o lease vencer.
 */
export function settleHarvestFailure(entry: HarvestEntry, intent: HarvestIntentSnapshot): void {
  metrics.count('harvest.failed');
  const identity = harvestQueue.obraIdentity(entry);
  const isProbe = entry.brProbe === true || Boolean(intent?.brProbe);
  // Mesmo gate do `settleHarvest`: só o run DIRIGIDO não satisfaz um pedido
  // completo coalescido; o regular cobre tudo e reencaminha a intenção fundida
  // comum (sem a branch FULL).
  const fullPending = entry.brProbe === true ? fullIntentOf(entry, intent) : null;
  const mergedReason = intent?.reason ?? entry.reason;
  const tries = (attemptsByObra.get(identity) || 0) + 1;
  attemptsByObra.set(identity, tries);
  // Falha de rede pode ser transitória: volta pro fim da fila até 3 vezes. O
  // reencaminhamento é a intenção FULL quando existe (colheita completa cobre
  // o subset da sonda; o dirigido falho não pode rebaixar o pedido) — senão a
  // intenção fundida comum, com a flag dirigida só se a base era dirigida
  // (`reforwarded`).
  const baseReturned: HarvestEntry = {
    ...entry,
    reason: mergedReason,
    ...(mergedReason === 'br-gap' && intent?.priorityAt != null ? { priorityAt: intent.priorityAt } : {}),
  };
  const returned: HarvestEntry = fullPending
    ? fullEntry(entry, fullPending)
    : reforwarded(entry, baseReturned);
  if (fullPending) metrics.count('harvest.coalesced.full-kept');
  if (tries <= 3) harvestQueue.tail(returned);
  else attemptsByObra.delete(identity);
  if (isProbe) finalizeBrProbe(probeWork(entry), 'failed');
  harvestQueue.persist();
}

/** Zera os contadores voláteis por obra — simula processo novo nos testes. */
export function resetHarvestOutcomeForTest(): void {
  attemptsByObra.clear();
  preemptsByObra.clear();
}
