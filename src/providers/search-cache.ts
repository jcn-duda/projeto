import config from '../config.js';
import * as cache from '../utils/cache.js';
import debrid from '../debrid/index.js';
import { accountScope, streamsCacheKey } from '../utils/request-key.js';
import { opts, capture, run } from '../runtime.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { noteUserRequest } from './activity.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { parseStremioId } from '../utils/format.js';
import { registerSeasonSearchKey } from './autofetch-runner.js';
import { onlyNotice } from './stream-builder.js';
import { doSearch } from './search-orchestrator.js';

// Buscas idênticas simultâneas (Stremio pede stream de vários clientes) compartilham a mesma promise.
const inFlight = new Map();


// Refresh de fundo do stale-while-revalidate: mapa PRÓPRIO, separado do
// inFlight — a revalidação não coalesce com a busca síncrona do cliente nem a
// impede de começar; e uma busca síncrona em voo já reescreve o cache fresco.
const refreshing = new Map();

/**
 * A lista tem play de verdade: pelo menos um stream com url ou infoHash. O
 * item de aviso carrega só name + externalUrl. O `complete` do finish e a
 * elegibilidade do SWR usam o MESMO teste, senão os critérios divergem e o
 * stale serviria uma lista que nunca deveria ter sido promovida a completa.
 */
export function hasPlayableStream(streams: any[]) {
  return Array.isArray(streams) && streams.some((s) => s && (s.url || s.infoHash));
}

export async function findStreams({ type, id, background }: { type: string; id: string; background?: boolean }) {
  if (!background) {
    noteUserRequest();
  }
  if (!id || !String(id).startsWith('tt')) {
    return { streams: [], partial: false };
  }
  if (!background) {
    metrics.count('stream.request');
  } else {
    metrics.count('autofetch.prefetch');
  }

  // A config do usuário entra na chave: dois install URLs com qualidades ou
  // debrid diferentes não podem compartilhar o mesmo resultado cacheado.
  // A URL de play leva a configuração e a assinatura da conta que construiu o
  // stream. Compartilhar cache entre duas API keys entregaria a URL (e a conta)
  // do primeiro usuário ao segundo; o digest isola sem persistir a credencial.
  // É configuração do operador, mas muda url/infoHash de cada stream e por
  // isso precisa fazer parte do shape persistido como as opções da instalação.
  const requestOpts = opts();
  const cacheKey = streamsCacheKey(type, id, { ...requestOpts, resolveUncached: config.debrid.resolveUncached });
  if (type === 'series' && requestOpts.debridApiKey) {
    const { imdbId, season } = parseStremioId(id);
    const adapter = debrid.current();
    if (season != null && adapter) {
      registerSeasonSearchKey(adapter.id, accountScope(requestOpts.debridApiKey), imdbId, season, cacheKey);
    }
  }
  // getWithStale em vez de get(): o get() APAGA a entrada expirada, e é
  // justamente ela que o SWR quer servir enquanto o refresh de fundo roda.
  // Graça 0 restaura a semântica dura anterior (kill-switch).
  const grace = config.streamStaleGrace;
  const hit = grace > 0
    ? cache.getWithStale(cacheKey, grace)
    : (() => {
        const value = cache.get(cacheKey);
        return value ? { value, stale: false } : null;
      })();
  if (hit) {
    const cached = hit.value;
    // O cache em SQLite sobrevive ao deploy, e a versão anterior gravava só o
    // array de streams. Sem esta linha, a primeira subida serviria `undefined`
    // por até 15 minutos em cima das entradas antigas.
    if (Array.isArray(cached)) {
      if (background && (!cached.length || onlyNotice(cached))) metrics.count('autofetch.prefetch.empty');
      return { streams: cached, partial: false };
    }
    if (!hit.stale) {
      if (background && (!cached?.streams?.length || onlyNotice(cached?.streams))) {
        metrics.count('autofetch.prefetch.empty');
      }
      return cached;
    }
    // Expirada DENTRO da janela de graça: responde na hora e revalida em
    // fundo. Só entra lista completa com debrid conferido e stream tocável —
    // aviso e parcial estenderiam o estado ruim em vez de consertá-lo.
    if (staleRefreshEligible(cached)) {
      metrics.count('search.swr.served');
      scheduleStaleRefresh(cacheKey, { type, id }, capture());
      if (background && (!cached?.streams?.length || onlyNotice(cached?.streams))) {
        metrics.count('autofetch.prefetch.empty');
      }
      return cached;
    }
    // Inelegível: cai na busca síncrona abaixo; a entrada velha fica no cache
    // até a reescrita (getWithStale não apaga).
  }

  // deadlineAt é compartilhado entre o passo de resposta e a checagem de cache:
  // a coleta não pode consumir tudo e deixar zero pro debrid. Passado adiante
  // como parte do input do builder, só o passo de resposta carrega — o passe
  // tardio (late/onBatch) chama finish sem deadlineAt e usa o timeout completo.
  const deadlineAt = Date.now() + config.replyDeadline;

  let task = inFlight.get(cacheKey);
  if (!task) {
    // Mede até a RESPOSTA — que é onde `doSearch` resolve. A coleta pode
    // continuar depois disso (fontes BR não cabem no orçamento), e esse rabo é
    // medido separado, em `search.late`: juntar os dois num número só faria a
    // busca fria parecer lenta e a quente parecer rápida pelo motivo errado.
    const done = metrics.timed('search.response');
    task = doSearch({ type, id, cacheKey, deadlineAt }).finally(() => {
      inFlight.delete(cacheKey);
      done();
    });
    // Se ninguém estiver ouvindo quando ela terminar, o resultado ainda vai pro cache;
    // o catch evita unhandled rejection depois que o deadline devolveu [].
    task.catch((err: unknown) => log.warn('[search] falhou em background:', log.errorMessage(err)));
    inFlight.set(cacheKey, task);
  } else {
    metrics.count('stream.coalesced');
  }

  // O cliente Stremio aborta em 10s. Devolvemos vazio antes disso em vez de
  // estourar o timeout dele — a busca continua e popula o cache pra próxima.
  const res: any = await raceWithDeadline(task, config.replyDeadline, () => {
    // Contador separado do timer: a busca que estoura o prazo termina depois e
    // entra no p95 como sucesso lento. Só isto conta quantas vezes o CLIENTE
    // recebeu lista parcial.
    metrics.count('search.deadline');
    log.warn(`[search] deadline de ${config.replyDeadline}ms atingido para ${id}; segue em background`);
    // Quarto estado do aviso, e o único que NÃO sai do buildStreams: aqui a busca
    // nem terminou, enquanto os outros três explicam uma lista que ficou vazia
    // depois de buscar. Vale para filme também — a coleta segue para os dois, e a
    // próxima pergunta pega o cache já preenchido.
    const streams = config.search.noticeStream
      ? [{ name: 'Procurando fontes — reabra em instantes', notice: true }]
      : [];
    return { streams, partial: true };
  });

  if (background && (!res?.streams?.length || onlyNotice(res.streams))) {
    metrics.count('autofetch.prefetch.empty');
  }
  return res;
}

/**
 * O refresh sem teto só pode ser dispensado quando a entrada cacheada nasceu de
 * uma checagem de cache CONFIÁVEL. `partial:false` sozinho não prova isso: ele
 * diz que a coleta acabou, não que alguém perguntou ao debrid.
 *
 * A diferença aparecia inteira na AllDebrid, cuja consulta disputa o prazo sem
 * poder ser abortada (o /magnet/instant morreu; checar é dar upload). Quando a
 * corrida perdia, a busca respondia sem ⚡ e o passe tardio promovia essa mesma
 * lista a completa; o refresh — que existe justamente pra
 * recuperar o ⚡ — desistia ao ver `partial:false`. Resultado: raio nenhum, e a
 * lista sem raio cacheada como boa por CACHE_TTL.
 *
 * Entrada antiga (gravada antes deste campo existir) não tem `debridKnown`:
 * cai em `false` de propósito, paga UMA checagem tardia e se corrige sozinha.
 */
export function debridRefreshSatisfied(entry: any) {
  return Boolean(entry && entry.partial === false && entry.debridKnown === true);
}

/** SWR só serve o que o finish promoveria a completa + checagem confiável. */
function staleRefreshEligible(entry: any) {
  return debridRefreshSatisfied(entry) && hasPlayableStream(entry?.streams);
}

/**
 * Resposta já saiu; a revalidação roda em fundo sem prazo de cliente. Erro
 * só vira log — nunca afeta quem recebeu a lista stale.
 */
export function scheduleStaleRefresh(cacheKey: string, { type, id }: { type: string; id: string }, requestCtx: any) {
  if (refreshing.has(cacheKey)) return;
  // Busca síncrona da mesma chave já em voo reescreve o cache fresco: o
  // refresh seria trabalho duplicado.
  if (inFlight.has(cacheKey)) return;
  refreshing.set(cacheKey, true);
  metrics.count('search.swr.scheduled');
  // Fora do AsyncLocalStorage da requisição: sem restaurar o contexto,
  // opts() leria os defaults do .env e o refresh regravaria o cache com a
  // config ERRADA — mesmo padrão do runRecheck. Sem contexto capturado,
  // roda com os defaults mesmo (caso de teste/chamada fora de request).
  const ctx = requestCtx || { opts: opts(), encoded: '' };
  Promise.resolve(run(ctx, async () => {
    // Revalida antes de pagar a busca: passe tardio, recheck do autofetch ou
    // outra requisição podem ter reescrito a entrada fresca nesse meio tempo.
    const current = cache.getWithStale(cacheKey, config.streamStaleGrace);
    if (current && !current.stale) return;
    const started = Date.now();
    // Sem deadlineAt encurtado: passe de fundo tem o orçamento completo.
    await doSearch({ type, id, cacheKey, deadlineAt: Date.now() + config.replyDeadline });
    metrics.observe('search.swr', Date.now() - started);
  }))
    .catch((err) => log.warn('[search] refresh SWR falhou:', err?.message || err))
    .finally(() => refreshing.delete(cacheKey));
}

/** Quantas buscas estao coalescendo agora -- usado so pelo snapshot do dashboard. */
export function searchesInFlightCount() {
  return inFlight.size;
}
