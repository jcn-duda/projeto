/**
 * Quem estoura o orçamento de coleta não pode compartilhar Promise: um
 * NerdFilmes de 7,4s segurava o BLUDV (e um redetorrent de 20s segurava o
 * TPB) fora do balde até depois dos ~6,5s. Globais de teto curto continuam
 * agrupados — cabem no prazo. `ptBrIndexers` só decide a query em pt-BR.
 */
const { numeralSearchVariant, franchiseRoot } = require('../utils/format');

function planJackettQueries(query, ptQuery, selectedIndexers, ptBrIndexers, isolateIndexers = [], sweepQuery = null) {
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
  if (grouped.length) {
    plan.push({ query, indexers: grouped });
    if (sweepQuery && sweepQuery !== query) plan.push({ query: sweepQuery, indexers: [...grouped] });
  }
  plan.push(...isolated);
  return plan;
}

/**
 * Alvos da varredura TARDIA com o título pt-BR: os indexers selecionados que
 * NÃO são BR. Os BR já recebem o título localizado no caminho crítico (e com
 * strip/bare-title pensados para buscador WordPress, que não se aplicam aos
 * globais); tracker global é quem hospeda dublado titulado em português que a
 * query em inglês não acha.
 */
function ptSweepIndexers(selectedIndexers, ptBrIndexers) {
  const brSet = new Set(ptBrIndexers);
  return selectedIndexers.filter((indexer) => !brSet.has(indexer));
}

/**
 * Query da varredura: título pt SEM subtítulo e SEM ano. Buscador de tracker
 * global casa por palavras do título — "Jornada nas Estrelas: O Filme 1979"
 * devolve 1 resultado num único indexer, "Jornada nas Estrelas" devolve 13 em
 * três. A precisão continua garantida pelo matchContext, que roda depois.
 *
 * A implementação (corte de subtítulo, marcador de sequência e trava de 2+
 * palavras) vive em format.js como `franchiseRoot`: a exceção de franquia do
 * inventário da conta precisa da MESMA raiz, e duplicar a regra faria os dois
 * caminhos divergirem.
 */
function ptSweepQuery(titlePt) {
  return franchiseRoot(titlePt);
}

/**
 * Query que a varredura pt-BR vai usar. Reaproveita o gate de "tem pt
 * localizado e ele difere do original" — sem ele, a varredura rodava em
 * TODO filme (inclusive "Joker", "Missão: Impossível" sem subtítulo em
 * português), disparando uma segunda rodada inútil contra os globais.
 *
 * Filme e série usam a mesma raiz pt. Medido no thepiratebay: "Jornada nas
 * Estrelas S01E04" devolve 0 resultados; o título puro devolve 6, incluindo
 * "T01 E004 … Dub PT-BR". O corte por episódio é responsabilidade do
 * matchContext, depois da coleta.
 */
function ptSweepQueryFor({ titles }) {
  if (!titles?.pt || titles.pt === titles.original) return null;
  return ptSweepQuery(titles.pt) || null;
}

module.exports = { planJackettQueries, ptSweepIndexers, ptSweepQuery, ptSweepQueryFor };
