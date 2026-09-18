import config from '../config.js';
import type { MatchContext, RawItem } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { filterRelevantRaw, stripDiacritics } from '../utils/format.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { prefix } from '../utils/cache-keys.js';
import { admitsMultiWorkPack } from '../utils/multiwork-pack.js';
import { mapResults, indexerFailure, CATEGORY_UNFILTERED_INDEXERS, UNRELIABLE_CATEGORY_INDEXERS } from './jackett-results.js';
import { shapeSearchQuery, budgetFor } from './jackett-query.js';
import { remaining, MIN_RESOLVE_BUDGET, resolveCardigannDownloads } from './jackett-resolve.js';

export interface JackettSearchOptions {
  /** Diagnóstico: mede a consulta de verdade, sem ler/gravar o cache bruto. */
  noRawCache?: boolean;
  /** Grafia arábica do numeral (plano BR: II -> 2). */
  variantQuery?: string;
  /** Fallback bilíngue do plano BR: EN (mainstream) no live, onde a primária
   * é pt; pt no colhedor, onde a primária é mainstream. */
  fallbackQuery?: string;
  /** Raiz da franquia sem marcador de sequência (plano BR: "Parte II" → raiz). */
  franchiseQuery?: string;
  /** Raiz da coleção multiobra (TMDB): degrau SEQUENCIAL no MESMO deadline e
   * COMPLEMENTAR — abre mesmo com release relevante vinda da primária, mas só
   * quando o acumulado ainda NÃO contém um pack admitido da obra. Só BR. */
  multiWorkQuery?: string;
  /** Título original da obra (TMDB) como degrau SEQUENCIAL de último recurso
   * ("Adım Farah" quando a primária é "My Name Is Farah"). Global recebe
   * sempre; BR só quando NÃO há já uma cascata bilíngue útil (ver o gate
   * `bilingualFallbackUseful` abaixo). */
  originalQuery?: string;
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
  /** Orçamento TOTAL dedicado (busca + resolução /dl). Usado SÓ pelo
   * colhedor para index-only, que têm latência fora de qualquer orçamento de
   * resposta; quem não passa cai no budgetFor de sempre. */
  timeoutMs?: number;
  /**
   * Observabilidade por consulta, opcional. `responded: true` significa que o
   * indexer deu uma resposta VÁLIDA (HTTP + envelope do Jackett sadios), mesmo
   * que ela seja `[]`; `false` cobre breaker/timeout/erro de rede/fonte morta
   * dentro do HTTP 200. Existe para a sonda dirigida (Fase 4) distinguir
   * "vazio autoritativo" de "falhou e engoliu": `jackett.search` devolve `[]`
   * nos dois casos, e `[]` sozinho não prova sucesso. Não altera status de
   * indexer nem o breaker — é só leitura para o chamador.
   */
  onQueryResult?: (info: { indexer: string; responded: boolean; reason?: string }) => void;
  /**
   * Identidade da obra da busca. Viaja só para a captura do banco de magnets
   * vivo (`magnet_work`): cada item do Jackett guarda para QUAL busca apareceu,
   * e é isso que o fallback da Etapa 4 consulta quando um indexer cai. Nada no
   * matching/plano lê estes campos.
   */
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  /**
   * `true` só na coleta VIVA: a captura reseta o `passed_filter` da obra para
   * 0 e o `markFilterResult` do stream-builder escreve o resultado. Coleta de
   * FUNDO (colhedor/varredura) omite: preserva o valor existente.
   */
  resetPassedFilter?: boolean;
}

/**
 * O acumulado já contém um pack multiobra ADMITIDO para a obra? Quando sim, o
 * degrau complementar da coleção não tem o que acrescentar: a query existe
 * justamente para descobrir o pack, e ele já está na mão. A checagem reusa a
 * MESMA `admitsMultiWorkPack` do filtro de título do pipeline — uma régua
 * paralela divergiria em silêncio do que `buildStreams` vai admitir depois.
 * Sem contexto multiWork nada é admitido, então o degrau segue abrindo.
 */
function hasAdmittedMultiWorkPack(items: RawItem[], matchContext: MatchContext | null | undefined): boolean {
  const multiWork = matchContext?.multiWork;
  const names = matchContext?.names;
  if (!multiWork || !names?.length) return false;
  const year = matchContext?.year ?? null;
  const isSeries = matchContext?.isSeries ?? false;
  return items.some((item) => admitsMultiWorkPack(item, { multiWork, year, isSeries, names }));
}

export async function queryIndexer(indexer: string, query: string, type: string, timeoutOverride: number | null = null, options: JackettSearchOptions = {}) {
  const { url, apiKey } = config.jackett;
  const isBr = config.jackett.ptBrIndexers.includes(indexer);

  // Orçamento TOTAL do indexer (busca + resolução de magnets), não só do fetch:
  // o resolve roda fora do AbortSignal da busca e somava o próprio timeout por
  // cima, estourando o REPLY_DEADLINE e zerando o resultado. Indexers BR raspam
  // WordPress e ainda seguem protetor de link, então têm prazo maior.
  // O override posicional existe só pro diagnóstico; `options.timeoutMs` é o
  // orçamento dedicado do colhedor para index-only — nunca do caminho vivo,
  // que continua no budgetFor (indexerTimeout/brIndexerTimeout).
  const timeout = timeoutOverride || options.timeoutMs || budgetFor(indexer);

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
  const fetchQuery = async (candidateQuery: string, isCascadeStep = false) => {
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
    // Indexers que devolvem 0 com `Category[]` na URL saem sem categoria.
    const noCategoryInUrl = CATEGORY_UNFILTERED_INDEXERS.has(indexer);
    // MagnetDownload nem tolera `Category[]` nem distingue o tipo no `Category` da
    // resposta (só Other/8000): além de sair sem categoria, pula o filtro
    // local por balde — senão o `mapResults` descartaria TODO o acervo. Um
    // indexer que não aguanta a URL mas devolve `Category` útil (TPB) segue
    // filtrando localmente pelo balde.
    const unreliableCategory = UNRELIABLE_CATEGORY_INDEXERS.has(indexer);
    const filterLocally = noCategoryInUrl && !unreliableCategory;
    const sendCategoryInUrl = !(noCategoryInUrl || unreliableCategory);
    if (sendCategoryInUrl && categoryBucket) {
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
    const envelopeError = indexerFailure(payload);
    // Só a PRIMÁRIA define o veredicto de saúde (`source.error`): um degrau
    // opcional que tropeça — exceção HTTP já tratada na cascata, ou HTTP 200
    // com o indexer morto por dentro (indexerFailure) — não pode reclassificar
    // nem abrir breaker para um indexer cuja primária respondeu. A decisão de
    // NÃO cachear vazio por falha continua valendo para o PRÓPRIO degrau, com
    // o erro dele.
    if (!isCascadeStep) source.error = envelopeError;
    // Recíproco: um degrau SAUDÁVEL não limpa o erro da primária — a saúde
    // dela é a autoridade; o degrau só pode dar itens, nunca veredicto.
    const items = mapResults(payload, {
      isBr,
      indexer,
      categoryBucket: filterLocally ? categoryBucket : 0,
    });
    liveFetches += 1;
    // Vazio POR FALHA não vira entrada de cache: guardá-lo faria o indexer
    // continuar mudo pelo TTL inteiro depois de a fonte voltar, e o degrau
    // seguinte da cascata leria o vazio como resposta legítima.
    if (rawTtl > 0 && !(isCascadeStep ? envelopeError : source.error) && items.length <= config.rawCache.maxItems) {
      // 200 com zero itens usa o TTL curto: pode ser rate-limit disfarçado.
      cache.set(rawKey, { items }, items.length === 0 ? config.rawCache.emptyTtl : rawTtl);
    }
    return { searchQuery, items };
  };

  let found = await fetchQuery(query);
  // Cadeia sequencial: primary -> variante numérica -> ... -> fallback
  // bilíngue (`fallbackQuery`: EN no live, onde a primária é pt; pt no
  // colhedor, onde a primária é mainstream). Cada passo abre só quando o
  // anterior não trouxe candidato útil, e compartilham o MESMO deadline
  // absoluto — nada de duas tentativas no ar dentro do orçamento.
  const shapedSeen = [found.searchQuery];
  const cascade: { q: string; label: string; isOriginal?: boolean; isMultiWork?: boolean }[] = [];
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
  // Coleção multiobra (BR_MULTIWORK_PACKS, nativa por padrão): degrau sequencial no MESMO
  // deadline, depois da raiz de sequência e antes do fallback bilíngue. A raiz
  // vem do TMDB (autoridade), não de cortar título. É COMPLEMENTAR: abre também
  // com release relevante já na mão — o pack dublado costuma ser o único lugar
  // onde a obra existe em PT — e por isso AGREGA em vez de substituir; só não
  // abre quando o acumulado já tem um pack admitido. A admissão do pack
  // acontece depois, no filtro de título (que agora o conhece).
  if (isBr && options.multiWorkQuery) cascade.push({ q: options.multiWorkQuery, label: 'coleção multiobra da franquia', isMultiWork: true });
  if (isBr && options.fallbackQuery) cascade.push({ q: options.fallbackQuery, label: 'fallback do plano BR' });
  // Degrau do título ORIGINAL da obra (TMDB): fonte real do caso Farah — os
  // trackers globais publicam "Adım Farah" e a query mainstream "My Name Is
  // Farah" nunca o encontra. SEQUENCIAL e de último recurso, nunca fan-out
  // paralelo: só abre quando a primária não trouxe candidato relevante e ainda
  // há orçamento no MESMO deadline. Nos BR ele só vale quando a cascata NÃO é
  // bilíngue útil (`bilingualFallbackUseful`): já existindo o par pt ↔ EN no
  // plano — no live a primária é pt com fallback EN; no colhedor a primária é
  // mainstream com fallback pt — o degrau do original acrescentaria um
  // TERCEIRO idioma à mesma cascata e é suprimido. "Útil" = fallback presente
  // E diferente da primária pós-shape: quando a query já É o título pt
  // (Cinemeta 404 cai no próprio pt), o fallback viraria no-op do dedupe e não
  // pode suprimir o original. A relevância do degrau é julgada pelo MESMO
  // matchContext — release do título original casa porque `names` já o inclui,
  // e ela NUNCA nasce `_br`/`_dubbed`: origem/áudio continuam sendo provados
  // pelo título e pelo flag do provider, não pela query que a encontrou.
  const bilingualFallbackUseful = isBr && options.fallbackQuery
    && shapeSearchQuery(indexer, options.fallbackQuery, isBr) !== shapeSearchQuery(indexer, query, isBr);
  if (options.originalQuery && !bilingualFallbackUseful) {
    cascade.push({ q: options.originalQuery, label: 'título original da obra', isOriginal: true });
    // Mesma obra grafada em ASCII: o magnetdownload devolve lotes diferentes
    // para "Adım Farah" (7) e "Adim Farah" (8). Só abre se a grafia original
    // não trouxe nada relevante; nos BR o shape já tira o acento e o
    // `shapedSeen` descarta a repetição.
    const asciiOriginal = stripDiacritics(options.originalQuery);
    if (asciiOriginal !== options.originalQuery) {
      cascade.push({ q: asciiOriginal, label: 'título original sem acento', isOriginal: true });
    }
  }
  for (const step of cascade) {
    const shaped = shapeSearchQuery(indexer, step.q, isBr);
    // Depois da moldagem duas grafias podem virar a mesma query (ex.: variante
    // que o bare-title reduz ao título); não vale abrir chamada duplicada.
    if (!shaped || shapedSeen.includes(shaped)) continue;
    const relevant = options.matchContext?.names?.length
      ? filterRelevantRaw(found.items, options.matchContext)
      : found.items;
    if (remaining(deadline) <= MIN_RESOLVE_BUDGET) continue;
    // O degrau da coleção multiobra é COMPLEMENTAR: abre mesmo com release
    // relevante já na mão, porque o dublado raro muitas vezes só existe no pack
    // da franquia. Ele NÃO abre quando o acumulado já contém um pack ADMITIDO da
    // obra — aí a query não teria o que acrescentar. Todos os demais degraus
    // mantêm o gate clássico por `relevant.length === 0`.
    const complementary = step.isMultiWork === true && relevant.length > 0;
    const opens = step.isMultiWork
      ? !hasAdmittedMultiWorkPack(found.items, options.matchContext)
      : relevant.length === 0;
    if (opens) {
      log.info(complementary
        ? `[jackett] ${indexer}: pack da franquia pode existir só na coleção; tentando ${step.label}`
        : `[jackett] ${indexer}: nenhum resultado relevante; tentando ${step.label}`);
      shapedSeen.push(shaped);
      try {
        // `step` conta a TENTATIVA (o degrau pode ser servido do raw cache ou
        // falhar na rede — o contador não distingue, é tentativa de degrau).
        if (step.isOriginal) metrics.count('jackett.original.step');
        if (step.isMultiWork) metrics.count('jackett.multiwork.step');
        // Só o degrau COMPLEMENTAR (abriu com relevante já presente) conta aqui:
        // é o custo novo da feature, separável do degrau clássico por vazio.
        if (complementary) metrics.count('jackett.multiwork.complementary');
        const accumulated = found.items;
        const next = await fetchQuery(step.q, true);
        // Complementar AGREGA ao que a primária trouxe — substituir descartaria
        // as releases do filme que o usuário já tinha. Os demais degraus só
        // rodam com a lista relevante vazia e substituem, como antes.
        found = complementary
          ? { searchQuery: next.searchQuery, items: [...accumulated, ...next.items] }
          : next;
        // `hit` conta só SOBREVIVENTE RELEVANTE do degrau — o MESMO filtro de
        // título do pipeline —, nunca item bruto irrelevante que o degrau
        // tenha trazido e o filtro descartaria.
        if (step.isOriginal) {
          // `workHit` conta sobrevivente RELEVANTE DA OBRA (o MESMO filtro de
          // título do pipeline via `filterRelevantRaw`) — não prova resolução
          // do episódio/pedido, só que o degrau trouxe candidato da obra.
          const sobreviventes = options.matchContext?.names?.length
            ? filterRelevantRaw(found.items, options.matchContext)
            : found.items;
          if (sobreviventes.length > 0) metrics.count('jackett.original.workHit');
        }
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
  // `ms` inclui deliberadamente TODA a cascata sequencial (variante, bare,
  // franquia, fallback bilíngue, título original) além do resolve — é o custo
  // real do indexer nesta chamada. Consequência: um global que devolve vazio
  // pode parecer mais lento que o usual porque rodou degraus extras, não
  // necessariamente por regressão de rede; compare com `fromCache`/liveFetches.
  return {
    indexer,
    items,
    ms: Date.now() - started,
    fromCache: liveFetches === 0,
    sourceOk,
    sourceError: sourceOk ? null : source.error,
  };
}
