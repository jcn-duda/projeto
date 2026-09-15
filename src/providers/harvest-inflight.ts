// Coalescing da colheita em voo (Fase 4, C8; GENÉRICO desde o item aberto 8).
//
// Antes só a sonda dirigida era coalescida: um enqueue COMUM (miss/gap/
// next-episode/br-gap) que chegasse enquanto o colhedor JÁ colhia a MESMA obra
// criava uma SEGUNDA entrada — a obra era raspada duas vezes e a fila ganhava
// trabalho duplicado. Agora QUALQUER `harvestQueue.enqueue` da identidade em
// voo funde a intenção aqui em vez de criar entrada nova.
//
// Módulo FOLHA (não importa ninguém) para não criar ciclo: `harvest-queue`,
// `br-probe` e `harvester` importam daqui, e a precedência numérica chega
// pronta do chamador (`reasonPriority`) — a tabela de motivos continua num
// lugar só. Só uma obra fica em voo por vez (o tick do colhedor é serial por
// contrato), então um único slot basta e a identidade é comparada em cada
// toque: obra DIFERENTE nunca coalesce.
export type HarvestIntent = {
  reason: string;
  /** Precedência numérica do motivo (`next-episode` > `br-gap` > demais). */
  rank: number;
  brProbe?: boolean;
  priorityAt?: number;
};

type FullIntent = { reason: string; rank: number; priorityAt?: number };

type Slot = {
  identity: string;
  // Intenção EFETIVA da execução (base + o que foi coalescido). Só sobe de
  // precedência; serve para reencaminhar UMA entrada quando a execução não
  // conclui (falha/capped/preempção).
  reason: string;
  rank: number;
  brProbe: boolean;
  priorityAt?: number;
  // Melhor intenção FULL (não-dirigida) coalescida. Um run DIRIGIDO cobre só o
  // subset index-only∩pt-BR: ele NÃO satisfaz um pedido de colheita COMPLETA
  // que chegou em voo, então essa intenção volta à fila ao fim do run dirigido
  // (sucesso inclusive). O run completo cobre tudo e não deixa resíduo.
  full: FullIntent | null;
};

let current: Slot | null = null;

/**
 * Marca o início da colheita de uma obra com a intenção da entrada base (a que
 * saiu da fila). O `full` nasce nulo de propósito: a cobertura da própria
 * entrada é decidida pelo tick; aqui só entra o que foi coalescido em voo.
 */
export function begin(identity: string, base: HarvestIntent): void {
  current = {
    identity: String(identity || ''),
    reason: base.reason,
    rank: Number(base.rank) || 0,
    brProbe: Boolean(base.brProbe),
    priorityAt: base.priorityAt,
    full: null,
  };
}

/** Encerra a colheita da obra, descartando a intenção anexada. */
export function end(identity: string): void {
  if (current && current.identity === String(identity || '')) current = null;
}

/** A obra está sendo colhida AGORA? */
export function isInflight(identity: string): boolean {
  return Boolean(current && current.identity === String(identity || ''));
}

/**
 * Funde uma intenção que chegou DURANTE a colheita desta obra. Devolve `true`
 * quando casou com a obra em voo — o chamador NÃO deve criar entrada nova.
 * A promoção só SOBE (`rank` maior vence, nunca rebaixa) e a flag dirigida é
 * OR-aderente (uma vez pedida, a execução passa a ser probe).
 */
export function coalesce(identity: string, intent: HarvestIntent): boolean {
  if (!current || current.identity !== String(identity || '')) return false;
  const rank = Number(intent.rank) || 0;
  if (intent.brProbe) current.brProbe = true;
  if (rank > current.rank) {
    current.reason = intent.reason;
    current.rank = rank;
    // `priorityAt` pertence à janela do br-gap; fora dela não se inventa
    // instante (o campo fica ausente).
    current.priorityAt = intent.reason === 'br-gap' ? intent.priorityAt : undefined;
  }
  // Só a intenção NÃO-dirigida exige cobertura completa; guarda a mais forte.
  if (!intent.brProbe) {
    const prev = current.full;
    if (!prev || rank > prev.rank) {
      current.full = {
        reason: intent.reason,
        rank,
        priorityAt: intent.reason === 'br-gap' ? intent.priorityAt : undefined,
      };
    }
  }
  return true;
}

/**
 * Intenção efetiva da obra em voo (base + coalescida), lida DEPOIS do
 * `harvestOne`. `null` quando a identidade não está em voo. Não limpa o slot —
 * quem encerra é o `end` (finally do tick).
 */
export function pendingIntent(identity: string): {
  reason: string;
  brProbe: boolean;
  priorityAt?: number;
  full: { reason: string; priorityAt?: number } | null;
} | null {
  if (!current || current.identity !== String(identity || '')) return null;
  return {
    reason: current.reason,
    brProbe: current.brProbe,
    ...(current.priorityAt != null ? { priorityAt: current.priorityAt } : {}),
    full: current.full
      ? {
          reason: current.full.reason,
          ...(current.full.priorityAt != null ? { priorityAt: current.full.priorityAt } : {}),
        }
      : null,
  };
}

/** Limpa o slot volátil — simula restart nos testes. */
export function resetHarvestInflightForTest(): void {
  current = null;
}
