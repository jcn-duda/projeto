/**
 * Quem estoura o orçamento de coleta não pode compartilhar Promise: um
 * NerdFilmes de 7,4s segurava o BLUDV (e um redetorrent de 20s segurava o
 * TPB) fora do balde até depois dos ~6,5s. Globais de teto curto continuam
 * agrupados — cabem no prazo. `ptBrIndexers` só decide a query em pt-BR.
 */
import { numeralSearchVariant, franchiseRoot } from '../utils/format.js';

interface SearchPlanTask {
  query: string;
  indexers: string[];
  /** Grafia arábica da sequência (só no indexer BR). */
  variant?: string;
  /** Query original como fallback (só BR+ptQuery). */
  fallback?: string;
}

function planJackettQueries(
  query: string,
  ptQuery: string | null,
  selectedIndexers: string[],
  ptBrIndexers: string[],
  isolateIndexers: string[] = [],
  sweepQuery: string | null = null,
): SearchPlanTask[] {
  const brSet = new Set(ptBrIndexers);
  const isolateSet = new Set([...ptBrIndexers, ...isolateIndexers]);
  const grouped: string[] = [];
  const isolated: SearchPlanTask[] = [];

  for (const indexer of selectedIndexers) {
    if (isolateSet.has(indexer)) {
      const task: SearchPlanTask = {
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

  const plan: SearchPlanTask[] = [];
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
function ptSweepIndexers(selectedIndexers: string[], ptBrIndexers: string[]) {
  const brSet = new Set(ptBrIndexers);
  return selectedIndexers.filter((indexer) => !brSet.has(indexer));
}

/**
 * Indexers que só alimentam o índice pelo colhedor NÃO entram no plano ao
 * vivo: latência de 8–31s contra orçamento total de 20s derrubava-os no
 * breaker a cada busca e ainda queimava o prazo com o retry PT→título
 * original. A busca ao vivo serve do índice (idxPoolCovered decide); quem
 * mantém as releases deles frescas é o colhedor, cujas falhas não contam no
 * breaker nem pintam card. Lista vazia = comportamento antigo.
 */
function liveIndexers(selectedIndexers: string[], indexOnlyIndexers: string[] = []) {
  const fora = new Set(indexOnlyIndexers);
  return selectedIndexers.filter((indexer) => !fora.has(indexer));
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
function ptSweepQuery(titlePt: string | null | undefined) {
  return franchiseRoot(String(titlePt || ''));
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
function ptSweepQueryFor({ titles }: { titles?: any }) {
  if (!titles?.pt || titles.pt === titles.original) return null;
  return ptSweepQuery(titles.pt) || null;
}

export { planJackettQueries, ptSweepIndexers, ptSweepQuery, ptSweepQueryFor, liveIndexers };
