/**
 * Quem estoura o orçamento de coleta não pode compartilhar Promise: um
 * NerdFilmes de 7,4s segurava o BLUDV (e um redetorrent de 20s segurava o
 * TPB) fora do balde até depois dos ~6,5s. Globais de teto curto continuam
 * agrupados — cabem no prazo. `ptBrIndexers` só decide a query em pt-BR.
 */
function planJackettQueries(query, ptQuery, selectedIndexers, ptBrIndexers, isolateIndexers = []) {
  const brSet = new Set(ptBrIndexers);
  const isolateSet = new Set([...ptBrIndexers, ...isolateIndexers]);
  const grouped = [];
  const isolated = [];

  for (const indexer of selectedIndexers) {
    if (isolateSet.has(indexer)) {
      isolated.push({
        query: brSet.has(indexer) ? (ptQuery || query) : query,
        indexers: [indexer],
      });
    } else {
      grouped.push(indexer);
    }
  }

  const plan = [];
  if (grouped.length) plan.push({ query, indexers: grouped });
  plan.push(...isolated);
  return plan;
}

module.exports = { planJackettQueries };
