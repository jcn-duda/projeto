/**
 * Indexers BR não podem compartilhar uma única Promise: um NerdFilmes de 7,4s
 * segurava o BLUDV de 6,2s fora do balde até depois do orçamento de 6,5s.
 * Globais seguem agrupados porque todos têm o mesmo teto curto e terminam cedo.
 */
function planJackettQueries(query, ptQuery, selectedIndexers, ptBrIndexers) {
  const brSet = new Set(ptBrIndexers);
  const br = selectedIndexers.filter((indexer) => brSet.has(indexer));
  const global = selectedIndexers.filter((indexer) => !brSet.has(indexer));
  const plan = [];

  if (global.length) plan.push({ query, indexers: global });
  for (const indexer of br) {
    plan.push({ query: ptQuery || query, indexers: [indexer] });
  }
  return plan;
}

module.exports = { planJackettQueries };
