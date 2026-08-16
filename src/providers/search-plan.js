/**
 * Quem estoura o orçamento de coleta não pode compartilhar Promise: um
 * NerdFilmes de 7,4s segurava o BLUDV (e um redetorrent de 20s segurava o
 * TPB) fora do balde até depois dos ~6,5s. Globais de teto curto continuam
 * agrupados — cabem no prazo. `ptBrIndexers` só decide a query em pt-BR.
 */
const { numeralSearchVariant } = require('../utils/format');

function planJackettQueries(query, ptQuery, selectedIndexers, ptBrIndexers, isolateIndexers = []) {
  const brSet = new Set(ptBrIndexers);
  const isolateSet = new Set([...ptBrIndexers, ...isolateIndexers]);
  const grouped = [];
  const isolated = [];

  for (const indexer of selectedIndexers) {
    if (isolateSet.has(indexer)) {
      const task = {
        query: brSet.has(indexer) ? (ptQuery || query) : query,
        indexers: [indexer],
      };
      // Sites BR misturam título localizado no post e original na release. A
      // segunda variante é apenas fallback SEQUENCIAL do mesmo indexer; quem
      // executa precisa mantê-la dentro do deadline original da tarefa.
      if (brSet.has(indexer)) {
        // Grafia arábica do numeral de sequência (II -> 2): a query que sai pro
        // indexer BR é pt-BR (ou a original quando não há ptQuery) — e ela pode
        // carregar o numeral em romano. Só vai junto quando gera variante.
        const variant = numeralSearchVariant(task.query);
        if (variant) task.variant = variant;
        if (ptQuery && ptQuery !== query) task.fallback = query;
      }
      isolated.push(task);
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
