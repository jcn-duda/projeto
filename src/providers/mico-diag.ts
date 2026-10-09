import config from '../config.js';
import { MICO_ID, search, repairBreaker, type SearchArgs } from './mico.js';

/**
 * Diagnóstico do card virtual do Mico (`/test-indexer.json?id=mico`), em
 * módulo próprio para separar a SONDA (validação de entrada, veredito do
 * diagnóstico, envelope de erro) da busca ao vivo em `mico.ts` — separação de
 * responsabilidade, não força da catraca (mico.ts tinha 339 linhas). Mesmo
 * shape do `jackett.test`; quem despacha é `jackett.test(id, q, type)`.
 */

/** Consulta padrão do diagnóstico sem alvo explícito: acervo dublado conhecido. */
const TEST_DEFAULT_ID = 'tt7286456';

/** Alvo do diagnóstico: `tt…` (filme) ou `tt…:S:E` (episódio), o mesmo formato
 * do caminho `/stream` do Stremio. Temporada 0 (especiais) é legítima. */
const TEST_TARGET = /^(tt\d{1,10})(?::(\d{1,4}):(\d{1,4}))?$/;

/**
 * Envelope do diagnóstico com falha. Validação recusada e fonte indisponível
 * voltam como `ok:false` + `error` SEM rede (paridade com o Jackett, que
 * devolve falha no payload, não como HTTP 4xx) e SEM reparar o circuito:
 * reparo é consequência de medição real, não de entrada recusada.
 */
function testFailure(error: string, query: string, type: string, ms = 0) {
  return {
    indexer: MICO_ID,
    ok: false,
    error,
    results: 0,
    withMagnet: 0,
    ms,
    sample: null,
    query,
    type,
    br: true,
    budgetMs: config.mico.timeout,
    overBudget: ms > config.mico.timeout,
  };
}

/**
 * Diagnóstico do card (`/test-indexer.json?id=mico` e o "testar todos" do
 * painel): mesmo shape do `jackett.test`.
 *
 * Aqui `query` é IMDb, não texto: `tt…` consulta o FILME e `tt…:S:E` o
 * EPISÓDIO de série (o endpoint do Mico de série exige os dois; temporada 0
 * são os especiais e o episódio tem que ser positivo). Entrada que não casa
 * devolve erro claro sem consultar — nunca uma consulta errada. Sem query
 * (compat "testar todos" e card sem campos), roda o coringa de filme,
 * reportado com o alvo exato que foi consultado.
 */
async function test(query = '', type = 'movie') {
  const kind = type === 'series' ? 'series' : 'movie';
  const raw = String(query || '').trim();
  if (!raw) {
    return probe({ type: 'movie', imdbId: TEST_DEFAULT_ID }, 'movie', TEST_DEFAULT_ID);
  }
  const match = TEST_TARGET.exec(raw);
  if (!match) {
    return testFailure('consulta do Mico é IMDb id: use tt… (filme) ou tt…:S:E (série)', raw, kind);
  }
  const [, imdbId, season, episode] = match;
  if (kind === 'series' && (season === undefined || episode === undefined)) {
    return testFailure('série no Mico é consultada por episódio: use tt…:S:E', raw, kind);
  }
  if (kind === 'series' && Number(episode) < 1) {
    return testFailure('episódio deve ser positivo (S0 vale para especiais): use tt…:S:E com E≥1', raw, kind);
  }
  if (kind === 'movie' && season !== undefined) {
    return testFailure('tt…:S:E é episódio de série; use type=series', raw, kind);
  }
  return probe(
    kind === 'series'
      ? { type: 'series', imdbId, season: Number(season), episode: Number(episode) }
      : { type: 'movie', imdbId },
    kind,
    raw,
  );
}

/**
 * Medição real do diagnóstico: repara o circuito (só aqui — a busca viva é
 * quem volta a contar falha real), consulta pelo caminho normal da busca e
 * separa os três vereditos com a honestidade devida:
 *  - FONTE FALHOU (rede/429/5xx/timeout): a busca é fail-open e devolve `[]`
 *    em silêncio; o canal existente `onQueryResult` (`responded:false`) é quem
 *    distingue — closure LOCAL da medição, sem estado global nem corrida.
 *    Mensagem estática, sem texto cru de terceiro (sanitizada por construção).
 *  - RESPOSTA VÁLIDA VAZIA: `ok:false` sem `error` — é "SEM MAGNET", não falha.
 *  - `results` é o bruto da fonte, SEM filtro de obra — relevância não é
 *    medível aqui (diagnóstico não tem matchContext); bruto não vira "útil".
 */
async function probe(args: SearchArgs, kind: 'movie' | 'series', target: string) {
  // Fonte desativada é veredito explícito, não "sem magnet" — e sem fetch.
  if (!config.mico.enabled) {
    return testFailure('fonte desativada (MICO_ENABLED=false)', target, kind);
  }
  repairBreaker();
  const started = Date.now();
  let sourceFail: 'error' | 'breaker' | null = null;
  const items = await search(args, {
    onQueryResult: (info) => {
      if (!info.responded) sourceFail = info.reason ?? 'error';
    },
  });
  const ms = Date.now() - started;
  if (sourceFail !== null) {
    return testFailure(
      sourceFail === 'breaker'
        ? 'circuito do Mico aberto por falhas seguidas'
        : 'fonte do Mico falhou (rede, HTTP 429/5xx ou timeout)',
      target,
      kind,
      ms,
    );
  }
  return {
    indexer: MICO_ID,
    ok: items.length > 0,
    results: items.length,
    withMagnet: items.length,
    ms,
    sample: items[0]?.title ? String(items[0].title).slice(0, 120) : null,
    query: target,
    type: kind,
    br: true,
    budgetMs: config.mico.timeout,
    overBudget: ms > config.mico.timeout,
  };
}

export { test };
