/**
 * Dedupe de prefetch é por processo, como era em app.ts. Não mover para a
 * fábrica: duas instâncias de app não podem disparar a mesma busca de episódio.
 */
const prefetchInFlight = new Set<string>();

export { prefetchInFlight };
