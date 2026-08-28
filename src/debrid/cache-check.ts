import { opts } from '../runtime.js';
import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { prefix } from '../utils/cache-keys.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { isAuthError, isQuotaError, isRateLimitError } from './common.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as magnetdb from '../utils/magnetdb.js';
import { notify } from '../utils/notify.js';
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
type AdapterCacheResponse = Set<string> | { cached: Set<string>; complete?: boolean };

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

function unusable(adapter: DebridAdapter, reason: keyof typeof UNUSABLE, err: unknown): CacheCheckResult {
  const kind = UNUSABLE[reason];
  const message = log.errorMessage(err);
  metrics.count(kind.metric);
  log.warn(`[${adapter.id}] ${kind.label} (${message}); a lista volta como P2P — ${kind.fix(adapter)}`);
  notify(`debrid_${reason}`, 'error', `${kind.label} (${message})`, {
    adapter: adapter.id,
    fix: kind.fix(adapter),
  }).catch(() => {});
  return { cached: new Set(), known: false, unusable: { reason, message } };
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
  const cached = new Set<string>(result instanceof Set ? result : result.cached);
  const complete = result instanceof Set ? true : result?.complete !== false;
  if (!complete) {
    log.warn(
      `[${adapter.id}] checagem de cache incompleta; tratando como "não sei" em vez de "não tem"`,
    );
  }
  return { cached, known: complete };
}

function nonAbortableKey(adapter: DebridAdapter, apiKey: string, infoHashes: string[]) {
  const hashes = [...new Set(infoHashes.map((hash: string) => String(hash).toLowerCase()))].sort();
  return `${adapter.id}:${accountScope(apiKey)}:${hashes.join(',')}`;
}

function davailKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('davail')}${adapterId}:${accountScope(apiKey)}:${String(hash).toLowerCase()}`;
}

/**
 * O recheck acabou de confirmar que o hash ficou pronto. Semeia o positivo para
 * a próxima lista marcar ⚡ sem repetir a consulta ao debrid.
 */
function noteAvailable(infoHash: string) {
  const adapter = current();
  const apiKey = opts().debridApiKey;
  if (!adapter || !apiKey || !infoHash) return;
  if (config.debrid.availPosTtl > 0) {
    cache.set(davailKey(adapter.id, apiKey, infoHash), 1, config.debrid.availPosTtl);
  }
  // Pronto de verdade é evidência durável: entra no banco de magnets além do
  // davail de TTL curto.
  magnetdb.markAlive(adapter.id, apiKey, [infoHash]);
}

function nonAbortableCheck(adapter: DebridAdapter, apiKey: string, infoHashes: string[]) {
  const key = nonAbortableKey(adapter, apiKey, infoHashes);
  let entry = nonAbortableChecks.get(key);
  if (entry) return entry.promise;

  entry = {};
  entry.promise = Promise.resolve()
    // Sem timeout dinâmico: abortar depois do upload perderia os ids necessários
    // para apagar o que não estava em cache. O teto próprio do adaptador continua
    // valendo, mas a corrida da resposta não cancela este trabalho.
    .then(() => adapter.checkCached(apiKey, infoHashes))
    .then((result) => normalizeCacheResult(adapter, result))
    .catch((err: unknown) => {
      // A AllDebrid é justamente o serviço que passa por aqui, então a
      // credencial recusada precisa ser reconhecida NESTE catch também — não
      // só no caminho abortável lá embaixo.
      const reason = unusableReason(err);
      if (reason) return unusable(adapter, reason, err);
      log.warn(`[${adapter.id}] falha na checagem de cache:`, log.errorMessage(err));
      return { cached: new Set(), known: false };
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
  { timeoutMs, forceFresh }: { timeoutMs?: number; forceFresh?: boolean } = {},
): Promise<CacheCheckResult> {
  const adapter = current();
  if (!adapter || infoHashes.length === 0) return { cached: new Set(), known: false };
  if (!adapter.cacheCheck) return { cached: new Set(), known: false };

  // Tempo restante esgotado: degrada na hora, sem rede. É a MESMA semântica de
  // resposta incompleta (lista inteira via debrid, sem ⚡ falso).
  if (timeoutMs != null && timeoutMs <= 0) return { cached: new Set(), known: false };
  // Os guards de prazo voltam ANTES da camada davail, de propósito: a resposta
  // que já desistiu de perguntar mantém o contrato known:false — responder pelo
  // L1 aqui mudaria o comportamento do applyDebrid (needsFullRefresh) sem a
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
    const missing: string[] = [];
    for (const hash of unique) {
      const value = cache.get(davailKey(adapter.id, apiKey, hash));
      if (value === 1 && config.debrid.availPosTtl > 0) fromCache.add(hash);
      else if (value === 0 && config.debrid.availNegTtl > 0) {
        // Negativo confirmado também responde sem rede, mas não entra no Set.
      } else missing.push(hash);
    }
    if (missing.length < unique.length) metrics.count('davail.servedHashes', unique.length - missing.length);
    toAsk = missing;
    if (toAsk.length === 0) {
      // O atalho respondeu TUDO pela memória, mas a evidência é a mesma do
      // caminho com rede — positivo confirmado. Sem renovar aqui, quanto mais
      // buscado o título, mais ele era servido pelo atalho e mais cedo o
      // desempate instant morria no meio do TTL de 7 dias. A renovação é
      // ECONÔMICA (só quem está na segunda metade do TTL): o hit do L1 não é
      // evidência nova, e regravar todo hit de título popular era escrita
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
    const task = nonAbortableCheck(adapter, apiKey, toAsk);
    result = timeoutMs == null ? await task : await raceWithDeadline(task, timeoutMs, () => {
      metrics.count('debrid.check.raceLost');
      return { cached: new Set(), known: false };
    });
  } else {
    trackCheckedHashes(toAsk);
    try {
      result = normalizeCacheResult(adapter, await adapter.checkCached(apiKey, toAsk, { timeoutMs }));
    } catch (err) {
      const reason = unusableReason(err);
      if (reason) result = unusable(adapter, reason, err);
      else if (isRateLimitError(err)) {
        metrics.count('debrid.rate_limit');
        log.warn(`[${adapter.id}] rate limit na checagem de cache (${err.message}); tentando de novo no passe tardio`);
        result = { cached: new Set(), known: false };
      } else {
        log.warn(`[${adapter.id}] falha na checagem de cache:`, err.message);
        result = { cached: new Set(), known: false };
      }
    }
  }

  if (davailOn && !result.unusable) {
    // Lote único: com a cota do davail saturada, uma passada de evicção (e UMA
    // transação SQLite) para a busca inteira, não uma por hash no prazo da
    // resposta. A persistência já era em lote; a evicção é que não era.
    const writes: { key: string; value: number; ttlSeconds: number }[] = [];
    for (const hash of new Set(toAsk.map((value) => String(value).toLowerCase()))) {
      if (result.cached.has(hash)) {
        if (config.debrid.availPosTtl > 0) {
          writes.push({ key: davailKey(adapter.id, apiKey, hash), value: 1, ttlSeconds: config.debrid.availPosTtl });
        }
      } else if (result.known && config.debrid.availNegTtl > 0) {
        writes.push({ key: davailKey(adapter.id, apiKey, hash), value: 0, ttlSeconds: config.debrid.availNegTtl });
      }
    }
    cache.setMany(writes);
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

export { checkCached, noteAvailable, UNUSABLE, failureReason };
export type { CacheCheckResult };
