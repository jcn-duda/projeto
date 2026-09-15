// Precedência de motivos da fila do colhedor (Fase 5): `next-episode` (play
// real) > `br-gap` (lacuna de dublado) > demais. Módulo FOLHA (não importa
// ninguém) para ser consumido pela fila e pelo coalescing em voo sem criar
// ciclo; a tabela de motivos continua existindo em UM lugar só.
const REASON_PRIORITY: Record<string, number> = { 'next-episode': 2, 'br-gap': 1 };

/** Precedência numérica do motivo (`next-episode` > `br-gap` > demais). */
export function reasonPriority(reason: string): number {
  return REASON_PRIORITY[reason] ?? 0;
}

/** O motivo novo é mais forte que o corrente? (promoção só sobe, nunca rebaixa) */
export function isPromotion(currentReason: string, incomingReason: string): boolean {
  return reasonPriority(incomingReason) > reasonPriority(currentReason);
}

/** Identidade da obra na fila/colheita: imdb + temporada + episódio (vazios em filme). */
export function obraIdentity(entry: { imdbId: string; season?: number | null; episode?: number | null }) {
  return `${entry.imdbId}:${entry.season ?? ''}:${entry.episode ?? ''}`;
}
