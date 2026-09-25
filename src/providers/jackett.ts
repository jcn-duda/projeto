import config from '../config.js';
import { filterRelevantRaw } from '../utils/format.js';
import * as indexerStatus from './indexer-status.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { mapResults } from './jackett-results.js';
import { shapeSearchQuery, budgetFor, rawKeysFor, peekRawFor } from './jackett-query.js';
import { breakerTripped, breakerSnapshot, breakerAnnounced } from './jackett-breaker.js';
import { queryIndexer, type JackettSearchOptions } from './jackett-query-indexer.js';
import { captureItems } from '../utils/magnet-bank.js';
import { ALL_QUERY_INDEXER } from './live-indexer-state.js';
import * as mico from './mico.js';

// Prazo do teste manual de indexador. Nada a ver com o da busca: aqui vale
// esperar pra distinguir "indexer morto" de "indexer lento".
const DIAGNOSTIC_TIMEOUT = 30000;

/**
 * Lista efetiva de indexers que `search` vai consultar. Fonte ÚNICA da regra do
 * ramo agregado: `override == null` usa a config do operador; lista vazia é que
 * cai no `/all`. Exportada para o `collectRaw` marcar pending/allFailed com a
 * MESMA regra real (não com um palpite sobre `opts().jackettIndexers`).
 */
export function effectiveJackettIndexers(indexersOverride: string[] | null): string[] {
  // O card virtual `mico` convive no `ji` com os ids do Jackett, mas não existe
  // lá: consultá-lo daria erro e pintaria o card de offline.
  return mico.jackettOnly(indexersOverride == null ? config.jackett.indexers : indexersOverride);
}

/**
 * Consulta cada indexer em paralelo em vez do agregado /all do Jackett.
 * O /all só responde quando o indexer MAIS LENTO termina, então um indexer
 * ruim derruba a busca inteira; aqui cada um tem seu próprio timeout e o que
 * chegou a tempo é aproveitado.
 *
 * @param {string} query
 * @param {string} type
 * @param {?string[]} [indexersOverride]
 * @param {object} [options]
 */
async function search(query: string, type: string, indexersOverride: string[] | null = null, options: JackettSearchOptions = {}) {
  // `recordStatus: false` é a varredura tardia pt-BR: uma SEGUNDA consulta
  // aos mesmos indexers. A falha dela não pode contar falha do indexer no
  // circuito (o caminho principal respondeu bem), nem a lentidão dela pintar
  // o card de vermelho — o status continua sendo o da busca ao vivo.
  //
  // `ignoreBreaker: true` é a mesma varredura: como ela não disputa o
  // orçamento da resposta, vale consultar o indexer recém-derrubado — o
  // dublado raro mora justamente ali. O breaker é um atalho de busca AO VIVO.
  const { url, apiKey } = config.jackett;
  const { recordStatus = true, ignoreBreaker = false } = options;
  const indexers = effectiveJackettIndexers(indexersOverride);
  if (!apiKey) {
    log.warn('[jackett] JACKETT_API_KEY não configurada');
    return [];
  }
  if (!query) return [];
  if (indexersOverride != null && indexers.length === 0) return [];

  if (indexers.length === 0) {
    // Sem lista configurada, cai no agregado (sujeito ao indexer mais lento).
    try {
      const endpoint = new URL(`${url}/api/v2.0/indexers/all/results`);
      endpoint.searchParams.set('apikey', apiKey);
      endpoint.searchParams.set('Query', query);
      const res = await fetch(endpoint, {
        headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0' },
        signal: AbortSignal.timeout(config.searchTimeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = mapResults(await res.json());
      // O ramo agregado não tem falha por indexer (é uma consulta só). Para o
      // fallback da Etapa 4, emitimos um evento SINTÉTICO: resposta VÁLIDA
      // (mesmo vazia) é sucesso e não dispara reserva. O erro cai no catch.
      options.onQueryResult?.({ indexer: ALL_QUERY_INDEXER, responded: true });
      // Clone total também no agregado `/all`: aqui não há `r.value.indexer`,
      // então a captura usa o indexer do próprio item (mapResults preenche com
      // TrackerId/Tracker) e cai em 'all' quando não há nem isso.
      captureItems(items, '', {
        imdbId: options.imdbId,
        season: options.season,
        episode: options.episode,
        resetPassedFilter: options.resetPassedFilter,
      });
      return items;
    } catch (err) {
      log.warn('[jackett]', err.message);
      // Erro (HTTP/timeout/aborto) do ramo agregado: falha sintética — o
      // consumidor deriva os indexers candidatos das sources do banco.
      options.onQueryResult?.({ indexer: ALL_QUERY_INDEXER, responded: false, reason: 'error' });
      return [];
    }
  }

  // Indexers com circuito aberto nem abrem consulta: a falha é conhecida e o
  // orçamento deles volta para quem ainda entrega. A varredura pt-BR ignora
  // o atalho: roda fora do prazo da resposta, então um timeout extra não
  // custa nada ao usuário, e o indexer recém-derrubado é justamente onde o
  // dublado raro se esconde.
  const activeIndexers = ignoreBreaker
    ? indexers
    : indexers.filter((indexer) => {
      if (!breakerTripped(indexer)) {
        breakerAnnounced.delete(indexer);
        return true;
      }
      if (!breakerAnnounced.has(indexer)) {
        breakerAnnounced.add(indexer);
        const status = indexerStatus.get(indexer);
        log.warn(
          `[jackett] ${indexer}: circuit breaker aberto após ${status?.failStreak || config.jackett.breakerFailures} falha(s) seguidas; buscas pulam este indexer até ${Math.round(config.jackett.breakerCooldown / 60_000)}min após a última falha`,
        );
      }
      return false;
    });
  // Quem ficou de fora pelo breaker também é reportado (responded:false): o
  // consumidor da observabilidade enxerga a diferença entre "não respondeu" e
  // "nem foi consultado", sem que isso toque no circuito.
  if (options.onQueryResult && !ignoreBreaker) {
    const active = new Set(activeIndexers);
    for (const indexer of indexers) {
      if (!active.has(indexer)) options.onQueryResult({ indexer, responded: false, reason: 'breaker' });
    }
  }
  if (activeIndexers.length === 0) return [];

  const settled = await Promise.allSettled(
    activeIndexers.map((i) => queryIndexer(i, query, type, null, options)),
  );

  const out: any[] = [];
  const slow: string[] = [];
  for (let idx = 0; idx < settled.length; idx += 1) {
    const r = settled[idx];
    if (r.status === 'fulfilled') {
      // Resposta VÁLIDA (mesmo que vazia) vs fonte morta dentro do HTTP 200.
      // `sourceOk` já é o veredicto do queryIndexer; aqui só o publicamos.
      options.onQueryResult?.({
        indexer: r.value.indexer,
        responded: r.value.sourceOk !== false,
        ...(r.value.sourceOk === false ? { reason: 'source' } : {}),
      });
      out.push(...r.value.items);
      // Banco de magnets vivo: TUDO que o indexer devolveu com hash entra,
      // antes de qualquer filtro de título/episódio (o filtro decide a lista,
      // não o acervo). Vale também para hit do cache bruto — ele É o que o
      // Jackett devolveu. Item de conta nunca passa por aqui.
      captureItems(r.value.items, r.value.indexer, {
        imdbId: options.imdbId,
        season: options.season,
        episode: options.episode,
        resetPassedFilter: options.resetPassedFilter,
      });
      if (recordStatus && !r.value.fromCache) {
        indexerStatus.record(r.value.indexer, {
          // HTTP válido NÃO significa online: o Jackett devolve 200 com o
          // indexer morto por dentro (`Indexers[].Status`/`Error`), e é
          // `sourceOk` que separa transporte de fonte. Zero resultado para um
          // título continua sendo online — só a falha declarada pinta de
          // vermelho.
          ok: r.value.sourceOk !== false,
          results: r.value.items.length,
          ms: r.value.ms,
          budgetMs: budgetFor(r.value.indexer),
        });
        if (r.value.sourceOk === false) {
          log.warn(`[jackett] ${r.value.indexer}: fonte fora (HTTP 200):`, r.value.sourceError);
        }
      }
      // Hit do cache bruto não registrou status nem entra na lista de lentos:
      // gravar ok:true com ms~0 deixaria um indexer caído verde no card pelo
      // TTL inteiro, e é justamente o card usado para diagnosticar os ✗.
      if (r.value.sourceOk === false) slow.push(`${r.value.indexer} ✗ fonte`);
      else if (!r.value.fromCache && r.value.ms > 2000) slow.push(`${r.value.indexer} ${(r.value.ms / 1000).toFixed(1)}s`);
      // Fase 0 do índice: tempo gasto em indexer que não contribuiu com NENHUM
      // item que sobreviveu ao filtro. Só medição real entra (fromCache é
      // ~0ms e não mediu nada; rejeição não carrega ms confiável).
      // Semântica: nos indexers de resolução Cardigann o pré-filtro interno já
      // cortou o que não casa, então a régua aqui é mais branda para eles — a
      // métrica é diagnóstico de autorização de fase, não comparação exata
      // entre indexers.
      //
      // Consulta de FUNDO (colhedor alimentando o índice, enriquecimento e
      // varredura de cauda) não vai no mesmo balde: zero-sobrevivente ali é
      // sonda negativa da descoberta — o colhedor não sabe de antemão qual
      // indexer tem a obra. Sem a separação, o aquecimento de fundo pinta o
      // balde "a resposta queimou o que o índice deveria ter servido" antes de
      // qualquer usuário aparecer (medido: 137 wastes com ZERO buscas de
      // usuário no processo).
      if (options.matchContext?.names?.length && !r.value.fromCache && r.value.ms > 0) {
        const survived = filterRelevantRaw(r.value.items, options.matchContext);
        if (survived.length === 0) {
          if (options.background) {
            metrics.count('search.jackett.wastedQueries.background');
            metrics.count('search.jackett.wastedMs.background', r.value.ms);
          } else {
            metrics.count('search.jackett.wastedQueries');
            metrics.count('search.jackett.wastedMs', r.value.ms);
          }
        }
      }
    } else {
      // Rejeição (timeout/aborto/erro de rede): não respondeu. Reason fica
      // genérico de propósito — quem decide o motivo do prazo é o queryIndexer.
      options.onQueryResult?.({ indexer: activeIndexers[idx], responded: false, reason: 'error' });
      if (recordStatus) {
        indexerStatus.record(activeIndexers[idx], {
          ok: false,
          // A rejeição não carrega duração real; inventar o orçamento fazia o
          // card dizer "offline · 20s" como se fosse uma medição.
          ms: null,
          budgetMs: budgetFor(activeIndexers[idx]),
        });
      }
      slow.push(`${activeIndexers[idx]} ✗`);
    }
  }
  if (slow.length) log.warn('[jackett] lentos/falharam:', slow.join(', '));
  return out;
}

/**
 * Diagnóstico de UM indexer, pelo MESMO caminho da busca real — inclusive a
 * resolução de magnet, que é onde os indexers BR costumam falhar de verdade.
 * Devolve dado, não veredito: quem exibe decide como pintar.
 */
async function test(indexer: string, query: string, type = 'movie') {
  if (indexer === mico.MICO_ID) return mico.test();
  const started = Date.now();
  if (!config.jackett.apiKey) {
    return { indexer, ok: false, error: 'JACKETT_API_KEY não configurada', ms: 0 };
  }
  const br = config.jackett.ptBrIndexers.includes(indexer);
  const budget = budgetFor(indexer);
  // Sem query explícita, cada lado recebe o nome que ele realmente indexa: o YTS
  // não tem "Coringa" e o BLUDV não tem "Joker". Um só termo reprovaria metade
  // dos indexers saudáveis.
  //
  // E o filme não pode ser a única tentativa: indexer só de séries (eztv,
  // tokyotosho, nyaasi) devolve 0 pra qualquer filme e apareceria como quebrado.
  // Zero resultado no filme → tenta uma série antes de dar veredito.
  const attempts = query
    ? [[query, type]]
    : type === 'series'
      ? [[br ? 'A Casa do Dragão' : 'The Last of Us', 'series']]
      : [
          [br ? 'Coringa' : 'Joker', 'movie'],
          [br ? 'A Casa do Dragão' : 'The Last of Us', 'series'],
        ];
  try {
    let items: any[] = [];
    let ms = 0;
    let effective = attempts[0][0];
    let effectiveType = attempts[0][1];
    for (const [term, kind] of attempts) {
      // Prazo generoso: o diagnóstico é manual e ninguém está esperando o
      // stream. Com o orçamento da busca ao vivo, indexer vivo porém lento (eztv
      // em 4s, 1337x atrás de Cloudflare) aparecia como quebrado — o que
      // interessa é saber que ele responde E quanto tempo cobra.
      const attempt = await queryIndexer(indexer, term, kind, DIAGNOSTIC_TIMEOUT, { noRawCache: true });
      ms += attempt.ms;
      effective = term;
      effectiveType = kind;
      items = attempt.items;
      if (items.length) break;
    }
    // Sem magnet o resultado é inútil pro addon: ele é descartado por falta de
    // infoHash. É a diferença entre "o site respondeu" e "dá pra assistir".
    const withMagnet = items.filter(
      (item) => item.infoHash || /^magnet:\?/i.test(String(item.magnet || '')),
    ).length;
    const result = {
      indexer,
      ok: withMagnet > 0,
      results: items.length,
      withMagnet,
      ms,
      sample: items[0]?.title ? String(items[0].title).slice(0, 120) : null,
      query: effective,
      type: effectiveType,
      br,
      // Quanto a busca ao vivo daria a ele, pra quem lê decidir: um indexer que
      // responde em 13s é saudável e ainda assim inútil num orçamento de 4s.
      budgetMs: budget,
      overBudget: ms > budget,
    };
    indexerStatus.record(indexer, result);
    return result;
  } catch (err) {
    const result = {
      indexer,
      ok: false,
      error: err.message || String(err),
      ms: Date.now() - started,
      budgetMs: budget,
    };
    indexerStatus.record(indexer, result);
    return result;
  }
}

export default { search, test, shapeSearchQuery, breakerTripped, breakerSnapshot, rawKeysFor, peekRawFor, name: 'jackett' };
