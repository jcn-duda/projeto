import { opts } from '../runtime.js';
import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { isAuthError, isQuotaError, isRateLimitError } from './common.js';
import { davailState, type DavailFlag } from '../utils/debrid-state-native.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as magnetdb from '../utils/magnetdb.js';
import { notify } from '../utils/notify.js';
import { cacheVerdict } from '../utils/rust-debrid-cache.js';
import { current } from './registry.js';

// Consulta não abortável em andamento (hoje, AllDebrid). O passe tardio junta
// a mesma promise quando o conjunto de hashes é idêntico; se o balde cresceu,
// uma nova consulta é necessária para não tratar os hashes novos como checados.
const nonAbortableChecks = new Map();
const NON_ABORTABLE_CHECK_TTL_MS = 60_000;

// Janela de medição de repetição por hash. O coalescing acima casa o CONJUNTO
// inteiro de hashes, então o mesmo hash voltando em buscas diferentes ainda
// paga upload de novo (AllDebrid). A razão repeated/hashes na janela decide se
// o cache de disponibilidade por hash compensa — sem a medição antes, a
// decisão seria palpite.
const CHECKED_HASH_WINDOW_MS = 15 * 60 * 1000;
const checkedHashWindow = new Map();

type CacheCheckResult = {
  cached: Set<string>;
  known: boolean;
  unusable?: { reason: string; message: string };
};
type AdapterCacheResponse = Set<string> | {
  cached: Set<string>;
  complete?: boolean;
  /** 200 da checagem nativa: conta recusada/no teto — veredito, não exceção. */
  unusable?: { reason?: string; message?: string } | null;
};

function trackCheckedHashes(infoHashes: string[]) {
  const now = Date.now();
  // Poda preguiçosa na própria chamada: o volume de checagens é baixo e não
  // justifica timer dedicado.
  for (const [hash, at] of checkedHashWindow) {
    if (now - at > CHECKED_HASH_WINDOW_MS) checkedHashWindow.delete(hash);
  }
  let repeated = 0;
  for (const raw of infoHashes) {
    const hash = String(raw).toLowerCase();
    if (checkedHashWindow.has(hash)) repeated += 1;
    checkedHashWindow.set(hash, now);
  }
  metrics.count('debrid.check.hashes', infoHashes.length);
  if (repeated) metrics.count('debrid.check.repeated', repeated);
}

/**
 * Serviço inutilizável AGORA, por um motivo que só o usuário conserta —
 * estado próprio, não "não sei".
 *
 * `known:false` sozinho manda a lista inteira pelo debrid, o que faz sentido
 * quando o serviço só não respondeu a tempo. Nestes dois casos não: a checagem
 * é um upload, e o play também é — se o upload é recusado, nenhum link vai
 * resolver e a lista precisa voltar como P2P. Os dois chegam à tela do mesmo
 * jeito (o ⚡ some de todos os streams) e só o log distingue a causa, então
 * cada motivo carrega o próprio conserto.
 */
const UNUSABLE = {
  auth: {
    metric: 'debrid.auth.invalid',
    label: 'credencial recusada',
    fix: (adapter: DebridAdapter) =>
      `gere uma chave nova em ${adapter.keyUrl || 'sua conta'} e atualize DEBRID_API_KEY` +
      ' ou refaça a URL de instalação em /configure',
  },
  quota: {
    metric: 'debrid.quota.exceeded',
    label: 'conta no limite de magnets',
    fix: () =>
      'apague magnets antigos no painel do serviço; a checagem de cache é um upload' +
      ' e não cabe mais nenhum enquanto a conta estiver cheia',
  },
};

/** Efeitos da conta inutilizável (métrica, log, aviso); o veredito vem do Rust. */
function unusable(adapter: DebridAdapter, reason: keyof typeof UNUSABLE, err: unknown): CacheCheckResult {
  const kind = UNUSABLE[reason];
  const message = log.errorMessage(err);
  metrics.count(kind.metric);
  log.warn(`[${adapter.id}] ${kind.label} (${message}); a lista volta como P2P — ${kind.fix(adapter)}`);
  notify(`debrid_${reason}`, 'error', `${kind.label} (${message})`, {
    adapter: adapter.id,
    fix: kind.fix(adapter),
  }).catch(() => {});
  return cacheVerdict({ form: 'object', cached: [], complete: null, failure: reason, message });
}

/** Falha transitória (rate limit ou erro de rede): "não sei", sem unusable. */
function failedVerdict(failure: 'rate' | 'falha'): CacheCheckResult {
  return cacheVerdict({ form: 'object', cached: [], complete: null, failure, message: '' });
}

/** Classifica o que impede o serviço de funcionar, ou null se for transitório. */
function unusableReason(err: unknown): keyof typeof UNUSABLE | null {
  if (isAuthError(err)) return 'auth';
  if (isQuotaError(err)) return 'quota';
  return null;
}

/** Rate limit é transitório: não entra em unusable. Só classifica o diagnóstico. */
function failureReason(err: unknown) {
  return unusableReason(err) || (isRateLimitError(err) ? 'rate' : 'falha');
}

function normalizeCacheResult(adapter: DebridAdapter, result: AdapterCacheResponse): CacheCheckResult {
  // 200 nativo com `unusable` (auth/quota) é conta recusada, não "não sei" mudo.
  const refused = result instanceof Set ? undefined : result?.unusable;
  if (refused) {
    const reason = refused.reason === 'quota' ? 'quota' : 'auth';
    return unusable(adapter, reason, new Error(refused.message || refused.reason));
  }
  const cached = new Set<string>(result instanceof Set ? result : result.cached);
  const complete = result instanceof Set ? true : result?.complete !== false;
  if (!complete) {
    log.warn(
      `[${adapter.id}] checagem de cache incompleta; tratando como "não sei" em vez de "não tem"`,
    );
  }
  return cacheVerdict({
    form: result instanceof Set ? 'set' : 'object',
    cached: [...cached],
    complete: result instanceof Set ? null : (result?.complete ?? null),
    failure: null,
    message: '',
  });
}

function nonAbortableKey(adapter: DebridAdapter, apiKey: string, infoHashes: string[]) {
  const hashes = [...new Set(infoHashes.map((hash: string) => String(hash).toLowerCase()))].sort();
  return `${adapter.id}:${accountScope(apiKey)}:${hashes.join(',')}`;
}

/**
 * O recheck acabou de confirmar que o hash ficou pronto. Semeia o positivo para
 * a próxima lista marcar ⚡ sem repetir a consulta ao debrid.
 */
function noteAvailable(infoHash: string) {
  const adapter = current();
  const apiKey = opts().debridApiKey;
  if (!adapter || !apiKey || !infoHash) return;
  if (config.debrid.availPosTtl > 0) davailState().put(adapter.id, apiKey, infoHash, true, config.debrid.availPosTtl, Date.now());
  // Pronto de verdade é evidência durável: entra no banco de magnets além do
  // davail de TTL curto.
  magnetdb.markAlive(adapter.id, apiKey, [infoHash]);
}

/**
 * Leitura de SONDAGEM do davail, sem efeito algum: a ponte lê o store do núcleo
 * direto — não promove LRU, não conta cache.hit e não acorda o L2. Negativo
 * "fresco" aqui foi escrito NESTA instância, que é exatamente o que o consumidor
 * (DEBRID_ALIVE_AS_CACHE) quer para vetar o atalho do histórico; positivo
 * sozinho não pinta ⚡, só o negativo contradiz.
 *
 * @returns {0|1|null} veredito vivo do store, ou null (ausente/expirado).
 */
function peekDavail(adapterId: string, apiKey: string, hash: string): 0 | 1 | null {
  const value = davailState().get(adapterId, apiKey, hash, Date.now());
  if (value === null) return null;
  return value ? 1 : 0;
}

/**
 * Negativo MEDIDO pelo play: o /resolve acabou de constatar que o hash não
 * estava pronto no serviço. Grava davail=0 pela janela curta do availNegTtl
 * (a mesma do caminho da checagem) para o atalho do histórico não pintar ⚡
 * no que o play acabou de provar frio — o erro do atalho custa uma janela,
 * não os 7 dias do alive. Não toca no magnetdb: o alive de plays antigos
 * continua de pé, e um play futuro bem-sucedido o renova.
 */
function noteUnavailable(adapterId: string, apiKey: string, infoHash: string) {
  if (!adapterId || !apiKey || !infoHash) return;
  if (config.debrid.availNegTtl > 0) davailState().put(adapterId, apiKey, infoHash, false, config.debrid.availNegTtl, Date.now());
}

function nonAbortableCheck(
  adapter: DebridAdapter,
  apiKey: string,
  infoHashes: string[],
  fileWaitTimeoutMs?: number,
  fileHashes?: string[],
) {
  const key = nonAbortableKey(adapter, apiKey, infoHashes);
  let entry = nonAbortableChecks.get(key);
  if (entry) return entry.promise;

  entry = {};
  entry.promise = Promise.resolve()
    // Continua NÃO abortável: NENHUM `timeoutMs` vai ao adaptador — os
    // timeouts próprios de rede (upload, leitura de arquivos) continuam sendo
    // os dele, e o trabalho segue após perder a corrida externa. O orçamento
    // DINÂMICO da resposta viaja SÓ como `fileWaitTimeoutMs`: é o teto com que
    // a AllDebrid espera a leitura dos arquivos de pack dentro da própria
    // checagem (alldebrid-check), sem tornar nada abortável. A espera interna
    // desiste com a MARGEM (packFilesWaitMarginMs) ANTES do orçamento: o timer
    // externo começa antes e o upload consome parte dele — esperar o valor
    // cheio transformava leitura lenta de pack em known:false/raceLost e
    // apagava o ⚡ por causa de um tamanho cosmético. A corrida EXTERNA não
    // muda: perder nela segue deixando o trabalho correr em fundo. A entrada
    // coalescida guarda o primeiro orçamento visto (o dedupe é pelo conjunto
    // de hashes); quem chegar depois continua protegido pela corrida.
    // `fileHashes` só vai quando existe: é por ele que a AllDebrid lê a lista
    // de arquivos dos packs antes da limpeza apagar o id do magnet.
    .then(() => adapter.checkCached(apiKey, infoHashes, {
      ...(fileWaitTimeoutMs != null
        ? { fileWaitTimeoutMs: Math.max(0, fileWaitTimeoutMs - config.debrid.packFilesWaitMarginMs) }
        : {}),
      ...(fileHashes?.length ? { fileHashes } : {}),
    }))
    .then((result) => normalizeCacheResult(adapter, result))
    .catch((err: unknown) => {
      // A AllDebrid é justamente o serviço que passa por aqui, então a
      // credencial recusada precisa ser reconhecida NESTE catch também — não
      // só no caminho abortável lá embaixo.
      const reason = unusableReason(err);
      if (reason) return unusable(adapter, reason, err);
      log.warn(`[${adapter.id}] falha na checagem de cache:`, log.errorMessage(err));
      return failedVerdict('falha');
    });
  nonAbortableChecks.set(key, entry);
  entry.promise.then(({ known }: { known?: boolean }) => {
    // Falha não pode ficar memorizada: o passe tardio deve poder tentar de novo
    // assim que o serviço voltar. Só resultado confiável serve como dedupe curto.
    if (!known) {
      if (nonAbortableChecks.get(key) === entry) nonAbortableChecks.delete(key);
      return;
    }
    const timer = setTimeout(() => {
      if (nonAbortableChecks.get(key) === entry) nonAbortableChecks.delete(key);
    }, NON_ABORTABLE_CHECK_TTL_MS);
    timer.unref();
  });
  return entry.promise;
}

/**
 * Hashes que tocam na hora. O segundo retorno diz se a resposta é confiável:
 * `known: false` significa que o serviço não sabe informar, não que nada está
 * em cache — quem chama precisa distinguir os dois casos.
 *
 * Resposta INCOMPLETA (um lote estourou o timeout) também vira `known: false`.
 * Antes ela passava como completa e o filtro `cachedOnly` apagava tudo que
 * estava no lote perdido — inclusive fontes BR que estavam em cache. O Set
 * parcial ainda volta: dá pra marcar o ⚡ de quem foi confirmado sem esconder
 * quem não chegou a ser perguntado.
 *
 * @param {Array<*>} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Teto dinâmico do passo de resposta (restante
 *   do REPLY_DEADLINE menos margem). Quando <=0 degrada na hora, sem rede.
 *   Ausente = timeout completo do adaptador (passe tardio).
 */
async function checkCached(
  infoHashes: string[],
  { timeoutMs, forceFresh, fileHashes }: { timeoutMs?: number; forceFresh?: boolean; fileHashes?: string[] } = {},
): Promise<CacheCheckResult> {
  const adapter = current();
  if (!adapter || infoHashes.length === 0) return { cached: new Set(), known: false };
  if (!adapter.cacheCheck) return { cached: new Set(), known: false };

  // Tempo restante esgotado: degrada na hora, sem rede. É a MESMA semântica de
  // resposta incompleta (lista inteira via debrid, sem ⚡ falso).
  if (timeoutMs != null && timeoutMs <= 0) return { cached: new Set(), known: false };
  // Os guards de prazo voltam ANTES da camada davail, de propósito: a resposta
  // que já desistiu de perguntar mantém o contrato known:false — responder pelo
  // davail aqui mudaria o comportamento do applyDebrid (needsFullRefresh) sem a
  // rede ter sido consultada naquela janela.
  if (
    adapter.abortSafeCacheCheck === false &&
    timeoutMs != null &&
    timeoutMs < config.debrid.nonAbortableRaceFloor
  ) {
    return { cached: new Set(), known: false };
  }
  const apiKey = opts().debridApiKey;
  const davailOn = config.debrid.availPosTtl > 0 || config.debrid.availNegTtl > 0;
  const fromCache = new Set<string>();
  let toAsk = infoHashes;
  if (davailOn && !forceFresh) {
    const unique = [...new Set(infoHashes.map((hash) => String(hash).toLowerCase()))];
    // UMA travessia para a leva inteira: o store nativo já devolve só as linhas
    // vivas, com o hash em minúsculas; ausente não é "frio".
    const live = davailState().getMany(adapter.id, apiKey, unique, Date.now());
    const flags = new Map(live.map((flag): [string, boolean] => [flag.hash, flag.cached]));
    const missing: string[] = [];
    for (const hash of unique) {
      const value = flags.get(hash);
      if (value === true && config.debrid.availPosTtl > 0) fromCache.add(hash);
      else if (value === false && config.debrid.availNegTtl > 0) {
        // Negativo confirmado também responde sem rede, mas não entra no Set.
      } else missing.push(hash);
    }
    if (missing.length < unique.length) metrics.count('davail.servedHashes', unique.length - missing.length);
    toAsk = missing;
    // Pack sem lista de arquivos servido pelo davail nunca voltava ao serviço, e
    // só a checagem de verdade lê arquivos (AllDebrid /magnet/status, TorBox
    // list_files). Star Trek (2009), 2026-09-13: três coleções prontas ficaram
    // em movie-no-files com zero leituras. Esses voltam à pergunta, até o teto
    // de leituras por checagem; o positivo do davail continua valendo.
    const refetch = [...new Set((fileHashes || []).map((hash) => String(hash).toLowerCase()))]
      .filter((hash) => fromCache.has(hash))
      .slice(0, config.debrid.packFilesPerCheck);
    if (refetch.length) {
      toAsk = [...missing, ...refetch];
      metrics.count('davail.fileRefetch', refetch.length);
    }
    if (toAsk.length === 0) {
      // O atalho respondeu TUDO sem rede, mas a evidência é a mesma do caminho
      // que perguntou ao serviço — positivo confirmado. Sem renovar aqui, quanto
      // mais buscado o título, mais ele era servido pelo atalho e mais cedo o
      // desempate instant morria no meio do TTL de 7 dias. A renovação é
      // ECONÔMICA (só quem está na segunda metade do TTL): o acerto do davail
      // não é evidência nova, e regravar todo hit de título popular era escrita
      // recorrente sem ganho.
      magnetdb.renewAlive(adapter.id, apiKey, [...fromCache]);
      return { cached: fromCache, known: true };
    }
  }

  let result: CacheCheckResult;
  // A checagem da AllDebrid faz upload de verdade. Ela pode disputar o prazo,
  // mas nunca é abortada: se perder, continua em background, lê os ids e limpa
  // os não cacheados. O passe tardio junta a mesma promise.
  if (adapter.abortSafeCacheCheck === false) {
    // Medição fica no ponto onde a checagem REAL acontece: degradação por
    // prazo ou ausência de serviço não é pergunta feita ao debrid.
    trackCheckedHashes(toAsk);
    const task = nonAbortableCheck(adapter, apiKey, toAsk, timeoutMs, fileHashes);
    result = timeoutMs == null ? await task : await raceWithDeadline(task, timeoutMs, () => {
      metrics.count('debrid.check.raceLost');
      return { cached: new Set(), known: false };
    });
  } else {
    trackCheckedHashes(toAsk);
    try {
      result = normalizeCacheResult(adapter, await adapter.checkCached(apiKey, toAsk, fileHashes?.length ? { timeoutMs, fileHashes } : { timeoutMs }));
    } catch (err) {
      const reason = unusableReason(err);
      if (reason) {
        result = unusable(adapter, reason, err);
      } else if (isRateLimitError(err)) {
        metrics.count('debrid.rate_limit');
        log.warn(`[${adapter.id}] rate limit na checagem de cache (${err.message}); tentando de novo no passe tardio`);
        result = failedVerdict('rate');
      } else {
        log.warn(`[${adapter.id}] falha na checagem de cache:`, err.message);
        result = failedVerdict('falha');
      }
    }
  }

  if (davailOn && !result.unusable) {
    // Lote único: com a cota do davail saturada, uma passada de evicção (e UMA
    // transação SQLite) para a busca inteira, não uma por hash no prazo da
    // resposta. A persistência já era em lote; a evicção é que não era.
    const positives: DavailFlag[] = [];
    const negatives: DavailFlag[] = [];
    for (const hash of new Set(toAsk.map((value) => String(value).toLowerCase()))) {
      if (result.cached.has(hash)) {
        if (config.debrid.availPosTtl > 0) positives.push({ hash, cached: true });
      } else if (result.known && config.debrid.availNegTtl > 0) {
        negatives.push({ hash, cached: false });
      }
    }
    // `putMany` aplica UMA janela a todas as flags: positivo e negativo (janelas
    // próprias) saem em duas chamadas — não existe override por flag.
    const now = Date.now();
    if (positives.length) davailState().putMany(adapter.id, apiKey, positives, config.debrid.availPosTtl, now);
    if (negatives.length) davailState().putMany(adapter.id, apiKey, negatives, config.debrid.availNegTtl, now);
  }
  // Positivo medido vira histórico durável (banco de magnets), independente do
  // TTL curto do davail. Serviço inutilizável não grava nada: a culpa é da
  // conta, não dos hashes.
  if (!result.unusable) magnetdb.markAlive(adapter.id, apiKey, [...result.cached]);
  // A taxa ⚡ compara somente a resposta confirmada pela rede com os hashes
  // enviados à rede. `fromCache` já foi contabilizado em davail.servedHashes;
  // somá-lo aqui faria o numerador superar o denominador numa chamada mista.
  if (result.known && result.cached.size > 0) metrics.count('debrid.check.cached', result.cached.size);
  result.cached = new Set([...fromCache, ...result.cached]);
  return result;
}

export { checkCached, noteAvailable, peekDavail, noteUnavailable, UNUSABLE, failureReason, normalizeCacheResult, unusableReason };
export type { CacheCheckResult };
