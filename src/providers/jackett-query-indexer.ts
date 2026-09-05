import config from '../config.js';
import type { MatchContext } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { filterRelevantRaw } from '../utils/format.js';
import * as log from '../utils/logger.js';
import { prefix } from '../utils/cache-keys.js';
import { mapResults, indexerFailure, CATEGORY_UNFILTERED_INDEXERS } from './jackett-results.js';
import { shapeSearchQuery, budgetFor } from './jackett-query.js';
import { remaining, MIN_RESOLVE_BUDGET, resolveCardigannDownloads } from './jackett-resolve.js';

export interface JackettSearchOptions {
  /** Diagnóstico: mede a consulta de verdade, sem ler/gravar o cache bruto. */
  noRawCache?: boolean;
  /** Grafia arábica do numeral (plano BR: II -> 2). */
  variantQuery?: string;
  /** Título original como fallback (plano BR+ptQuery). */
  fallbackQuery?: string;
  /** Raiz da franquia sem marcador de sequência (plano BR: "Parte II" → raiz). */
  franchiseQuery?: string;
  matchContext?: MatchContext | null;
  /** Varredura tardia: falha não conta no circuito nem pinta o card. */
  recordStatus?: boolean;
  /** Consulta FORA do caminho da resposta (colhedor, enriquecimento/varredura
   * de cauda): zero-sobrevivente ali é sonda negativa da descoberta e vai para
   * contador de fundo próprio, não para o desperdício do caminho crítico. */
  background?: boolean;
  /** Varredura tardia: consulta mesmo indexer com circuito aberto. */
  ignoreBreaker?: boolean;
  /** Warmup popula raw sem pagar resolução de protetor de link. */
  skipResolve?: boolean;
}

export async function queryIndexer(indexer: string, query: string, type: string, timeoutOverride: number | null = null, options: JackettSearchOptions = {}) {
  const { url, apiKey } = config.jackett;
  const isBr = config.jackett.ptBrIndexers.includes(indexer);

  // Orçamento TOTAL do indexer (busca + resolução de magnets), não só do fetch:
  // o resolve roda fora do AbortSignal da busca e somava o próprio timeout por
  // cima, estourando o REPLY_DEADLINE e zerando o resultado. Indexers BR raspam
  // WordPress e ainda seguem protetor de link, então têm prazo maior.
  // O override existe só pro diagnóstico, que não responde a ninguém esperando.
  const timeout = timeoutOverride || budgetFor(indexer);

  const started = Date.now();
  const deadline = started + timeout;
  // O cache bruto memoiza SÓ a camada de rede: a cascata de fallback (decide
  // por relevância) e a resolução de magnets (filtra pelo episódio da query
  // original) continuam rodando por busca; num hit, cada salto de protetor
  // vira hit no cache `dlmag:` existente. Falha nunca é cacheada — o breaker
  // e o indexer-status seguem sendo a resposta para indexer fora do ar.
  // `noRawCache` é o diagnóstico: ele precisa medir a consulta de verdade.
  const rawTtl = options.noRawCache || config.rawCache.maxItems <= 0
    ? 0
    : isBr ? config.rawCache.ttlBr : config.rawCache.ttl;
  let liveFetches = 0;
  // Falha da FONTE na última consulta ao vivo (HTTP 200 com o indexer morto
  // por dentro — ver indexerFailure). Só o caminho ao vivo escreve aqui: o hit
  // de cache não mediu nada e não pode afirmar saúde nem doença.
  // Portador em vez de `let`: a atribuicao mora dentro do closure de
  // fetchQuery, e o fluxo do tsc estreitaria uma variavel solta para `null`
  // no ponto de leitura — fazendo `sourceOk` virar o literal `true` e as
  // comparacoes em jackett.ts virarem erro de sobreposicao vazia.
  const source: { error: string | null } = { error: null };
  const fetchQuery = async (candidateQuery: string) => {
    const searchQuery = shapeSearchQuery(indexer, candidateQuery, isBr);
    // A shaped query já remove SxxEyy nos indexers BR, então episódios da
    // mesma temporada compartilham a entrada por construção — é o que faz a
    // busca tardia de pack ("Nome S03") custar uma varredura por temporada.
    const rawKey = `${prefix('raw')}jackett:${indexer}:${type}:${searchQuery}`;
    if (rawTtl > 0) {
      const hit = cache.get(rawKey);
      if (hit && Array.isArray(hit.items)) return { searchQuery, items: hit.items };
    }
    const endpoint = new URL(`${url}/api/v2.0/indexers/${indexer}/results`);
    endpoint.searchParams.set('apikey', apiKey);
    endpoint.searchParams.set('Query', searchQuery);
    // 2000 = Movies, 5000 = TV nos indexers Torznab
    const categoryBucket = type === 'movie' ? 2000 : type === 'series' ? 5000 : 0;
    // Quem não aguenta categoria na URL filtra depois, sobre a resposta.
    const filterLocally = CATEGORY_UNFILTERED_INDEXERS.has(indexer);
    if (categoryBucket && !filterLocally) {
      endpoint.searchParams.append('Category[]', String(categoryBucket));
    }
    const budget = remaining(deadline);
    if (budget <= 0) throw new Error('timeout');
    const res = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
      signal: AbortSignal.timeout(Math.max(1, budget)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    source.error = indexerFailure(payload);
    const items = mapResults(payload, {
      isBr,
      indexer,
      categoryBucket: filterLocally ? categoryBucket : 0,
    });
    liveFetches += 1;
    // Vazio POR FALHA não vira entrada de cache: guardá-lo faria o indexer
    // continuar mudo pelo TTL inteiro depois de a fonte voltar, e o degrau
    // seguinte da cascata leria o vazio como resposta legítima.
    if (rawTtl > 0 && !source.error && items.length <= config.rawCache.maxItems) {
      // 200 com zero itens usa o TTL curto: pode ser rate-limit disfarçado.
      cache.set(rawKey, { items }, items.length === 0 ? config.rawCache.emptyTtl : rawTtl);
    }
    return { searchQuery, items };
  };

  let found = await fetchQuery(query);
  // Cadeia sequencial: primary (pt-BR) -> variante numérica -> original. Cada
  // passo abre só quando o anterior não trouxe candidato útil, e compartilham o
  // MESMO deadline absoluto — nada de duas tentativas no ar dentro do orçamento.
  // `variantQuery` vem do plano BR (II -> 2) e `fallbackQuery` é o título original.
  const shapedSeen = [found.searchQuery];
  const cascade: { q: string; label: string }[] = [];
  if (isBr && options.variantQuery) cascade.push({ q: options.variantQuery, label: 'variante numérica' });
  // Título pt-BR SEM o ano. Medido ao vivo em tt1465522: "Tucker e Dale Contra
  // o Mal 2010" devolve 0 no comandotorrents e no torrentdosfilmesv2, e o mesmo
  // título nu devolve 1 em cada um — o post BR é de 2012 (data do lançamento
  // nacional) e o buscador WordPress trata o ano como token obrigatório. O ano
  // fica na query primária porque ajuda a relevância quando o indexer casa; o
  // degrau nu só abre quando ela não trouxe nada. Nos `bareTitleIndexers` o
  // strip já aconteceu e o dedup de `shapedSeen` descarta o degrau repetido.
  if (isBr) {
    const bare = query.replace(/\s+(?:19|20)\d{2}\s*$/, ' ');
    if (bare !== query) cascade.push({ q: bare, label: 'título sem ano' });
  }
  // Raiz da franquia: "Se Beber, Não Case! Parte II" não acha o post da
  // Trilogia no WordPress BR, mas a raiz "Se Beber, Não Case!" acha. Degrau
  // SEQUENCIAL no MESMO deadline — depois do título sem ano (o ano impediria
  // o marcador de sequência de casar) e antes do fallback original. O
  // `shapedSeen` já descarta a duplicata quando a raiz coincide com um degrau
  // anterior já moldado.
  if (isBr && options.franchiseQuery) cascade.push({ q: options.franchiseQuery, label: 'raiz da franquia' });
  if (isBr && options.fallbackQuery) cascade.push({ q: options.fallbackQuery, label: 'título original' });
  for (const step of cascade) {
    const shaped = shapeSearchQuery(indexer, step.q, isBr);
    // Depois da moldagem duas grafias podem virar a mesma query (ex.: variante
    // que o bare-title reduz ao título); não vale abrir chamada duplicada.
    if (!shaped || shapedSeen.includes(shaped)) continue;
    const relevant = options.matchContext?.names?.length
      ? filterRelevantRaw(found.items, options.matchContext)
      : found.items;
    if (relevant.length === 0 && remaining(deadline) > MIN_RESOLVE_BUDGET) {
      log.info(`[jackett] ${indexer}: nenhum resultado relevante em PT; tentando ${step.label}`);
      shapedSeen.push(shaped);
      try {
        found = await fetchQuery(step.q);
      } catch (err) {
        // A primária já respondeu HTTP válido. Uma variante opcional instável
        // não pode reclassificar o indexer inteiro como offline nem apagar a
        // chance do próximo fallback dentro do orçamento restante.
        log.warn(`[jackett] ${indexer}: falha ao tentar ${step.label}:`, err?.message || err);
      }
    }
  }

  const items = options.skipResolve
    ? found.items
    : await resolveCardigannDownloads(indexer, found.items, query, deadline, options.matchContext);
  // fromCache diz se NENHUMA consulta Torznab saiu desta chamada: quem veio
  // do cache não mediu nada, e o status do indexer não pode ser inventado.
  // `sourceOk` separa "o servidor respondeu" de "a fonte está viva". Item
  // encontrado prova vida por si só — uma variante instável no fim da cascata
  // não pode condenar o indexer que já entregou. Sem item algum, a falha da
  // última consulta ao vivo é o que vale.
  const sourceOk = items.length > 0 || !source.error;
  return {
    indexer,
    items,
    ms: Date.now() - started,
    fromCache: liveFetches === 0,
    sourceOk,
    sourceError: sourceOk ? null : source.error,
  };
}
