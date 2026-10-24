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

// Janela de prioridade do `br-gap` recém-promovido (Fase 5): por até 1h a
// lacuna recém-provada fura `popular`/`miss`; depois volta às regras normais.
export const BR_GAP_PRIORITY_WINDOW_MS = 60 * 60 * 1000;

/** `br-gap` promovido/enfileirado dentro da janela de prioridade própria. */
export function isRecentBrGap(
  entry: { reason: string; priorityAt?: number; enqueuedAt: number },
  now: number,
): boolean {
  if (entry.reason !== 'br-gap') return false;
  // Fallback seguro para entrada antiga sem `priorityAt`: usa o `enqueuedAt`.
  const since = entry.priorityAt ?? entry.enqueuedAt;
  return now - since < BR_GAP_PRIORITY_WINDOW_MS;
}
