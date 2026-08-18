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
 * Regras:
 * - corta em `:`, `–`, `—` apenas quando o prefixo tem 2+ palavras (protege
 *   "Missão: Impossível", onde o prefixo é uma palavra só);
 * - não anexa o ano (responsabilidade de quem chama);
 * - devolve '' quando não há título pt (a varredura já é pulada nesse caso).
 */
function ptSweepQuery(titlePt) {
  const raw = String(titlePt || '').trim();
  if (!raw) return '';
  // Casa o PRIMEIRO separador entre os três suportados; a âncora inicial
  // impede cortar no meio de um subtítulo.
  const cut = raw.match(/^([^:–—]+?)([:–—].*)?$/);
  if (cut) {
    const head = cut[1].trim();
    const headWords = head.split(/\s+/).filter(Boolean);
    if (headWords.length >= 2) return head;
  }
  return raw;
}

/**
 * Query que a varredura pt-BR vai usar. Reaproveita o gate de "tem pt
 * localizado e ele difere do original" — sem ele, a varredura rodava em
 * TODO filme (inclusive "Joker", "Missão: Impossível" sem subtítulo em
 * português), disparando uma segunda rodada inútil contra os globais.
 *
 * - Série: `activePtQuery` já carrega o gate (só é construído quando
 *   `titles.pt && titles.pt !== titles.original`). Sem o `SxxEyy/pack` o
 *   indexer devolve a temporada inteira e o corte por episódio chega
 *   depois — usar a query "crua" do TMDB aqui quebraria esse corte.
 * - Filme: gate idêntico antes de chamar `ptSweepQuery`; sem pt localizado
 *   a busca GLOBAL principal já cobriu o título em inglês.
 */
function ptSweepQueryFor({ season, titles, activePtQuery }) {
  if (season != null) return activePtQuery || null;
  if (!titles?.pt || titles.pt === titles.original) return null;
  return ptSweepQuery(titles.pt) || null;
}

module.exports = { planJackettQueries, ptSweepIndexers, ptSweepQuery, ptSweepQueryFor };
