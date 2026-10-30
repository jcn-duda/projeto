// `checkCached` orquestrado do pipeline TS de debrid: davail, coalescência da
// consulta não abortável (AllDebrid), unusable e o `alive` do magnetdb. Saiu de
// `src/debrid/cache-check.ts` porque nenhum caminho de produção o chama desde o
// corte do `/stream` e do Chupim: a checagem viva é a do gateway (8710). O
// objeto default é MUTÁVEL de propósito — os testes trocam `checkCached` por
// stub e o oráculo (`debrid-pipeline.ts`) chama pelo mesmo objeto.
import { opts } from '../../../src/runtime.js';
import config from '../../../src/config.js';
import { accountScope } from '../../../src/utils/request-key.js';
import { raceWithDeadline } from '../../../src/utils/deadline.js';
import { isRateLimitError } from '../../../src/debrid/common.js';
import { davailState, magnetState, type DavailFlag } from '../../../src/utils/debrid-state-native.js';
import { isSupportedHash } from '../../../src/utils/magnetdb-counts.js';
import * as metrics from '../../../src/utils/metrics.js';
import * as log from '../../../src/utils/logger.js';
import { rawAdapter, type CheckableAdapter } from './raw-adapter.js';
import { cacheVerdict } from '../../../src/utils/rust-debrid-cache.js';
import {
  unusable,
  unusableReason,
  normalizeCacheResult,
  type CacheCheckResult,
} from '../../../src/debrid/cache-check.js';
import type { DebridAdapter } from '../../../types/domain.js';
import { assertSafeTestDb } from '../db-guard.js';

// Grava davail e magnetdb: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/debrid-check');

// Régua LOCAL do banco de magnets: o oráculo chama a PONTE nativa
// (`magnetState()`) direto, com as MESMAS guardas e métricas da régua que
// estava em `src/utils/magnetdb.ts` (o módulo vivo conservou só leitura/reparo
// do painel — a escrita de produção é do gateway e do play_effects nativo).
// Sem o bookkeeping do agregado do painel: nenhum teste do oráculo o lê.
function markAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  // Dedup + minúsculas: o núcleo casa por hash já normalizado, e a métrica de
  // recusa conta HASHES — duas cópias do mesmo hash inflariam `alive.set`.
  const candidates = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter(Boolean);
  // Só grava hash que o parse da chave aceita de volta: gravar o que ele
  // recusa cria linha física que a enumeração de diagnóstico não reconhece.
  const unique = candidates.filter(isSupportedHash);
  const malformed = candidates.length - unique.length;
  if (malformed > 0) metrics.count('magnetdb.hash.refused', malformed);
  if (unique.length === 0) return;
  const now = Date.now();
  // UMA varredura para saber quais já estão `bad`: a precedência
  // `bad > lie > alive` é do núcleo, e um `isBad` por hash custaria uma
  // travessia napi por candidato.
  const bad = new Set(
    magnetState().stateSnapshot(adapterId, apiKey, unique, now)
      .filter((mark) => mark.state === 'bad')
      .map((mark) => String(mark.hash || '').toLowerCase()),
  );
  const allowed = unique.filter((hash) => !bad.has(hash));
  const refused = unique.length - allowed.length;
  if (refused > 0) metrics.count('magnetdb.alive.refused-bad', refused);
  if (allowed.length === 0) return;
  magnetState().markAlive(adapterId, apiKey, allowed, ttl, now);
  metrics.count('magnetdb.alive.set', allowed.length);
}

function isBad(adapterId: string, apiKey: string, hash: string) {
  return config.magnetDb.enabled && adapterId && apiKey && hash
    ? magnetState().state(adapterId, apiKey, hash, Date.now()) === 'bad'
    : false;
}

/**
 * Renovação ECONÔMICA para o atalho do davail: regrava só o hash cujo alive
 * está na segunda metade do TTL. O hit do L1 não é evidência nova. Entrada
 * sem registro (expirou) também renova — o davail acabou de confirmar o
 * positivo; hash com `bad` NÃO renova (bad vence, e a renovação não pode
 * ressuscitá-lo pela janela do davail).
 */
function renewAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  const now = Date.now();
  const stale = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter((hash) => {
    if (!hash || isBad(adapterId, apiKey, hash)) return false;
    const remaining = magnetState().remaining(adapterId, apiKey, 'alive', hash, now);
    return remaining == null || remaining < ttl / 2;
  });
  markAlive(adapterId, apiKey, stale);
}

// Consulta não abortável em andamento (hoje, AllDebrid). O passe tardio junta
// a mesma promise quando o conjunto de hashes é idêntico; se o balde cresceu,
// uma nova consulta é necessária para não tratar os hashes novos como checados.
const nonAbortableChecks = new Map();
const NON_ABORTABLE_CHECK_TTL_MS = 60_000;

// Janela de medição de repetição por hash: o coalescing acima casa o CONJUNTO
// inteiro, então o mesmo hash voltando em buscas diferentes ainda paga upload.
const CHECKED_HASH_WINDOW_MS = 15 * 60 * 1000;
const checkedHashWindow = new Map();

function trackCheckedHashes(infoHashes: string[]) {
  const now = Date.now();
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

/** Falha transitória (rate limit ou erro de rede): "não sei", sem unusable. */
function failedVerdict(failure: 'rate' | 'falha'): CacheCheckResult {
  return cacheVerdict({ form: 'object', cached: [], complete: null, failure, message: '' });
}

function nonAbortableKey(adapter: DebridAdapter, apiKey: string, infoHashes: string[]) {
  const hashes = [...new Set(infoHashes.map((hash: string) => String(hash).toLowerCase()))].sort();
  return `${adapter.id}:${accountScope(apiKey)}:${hashes.join(',')}`;
}

function nonAbortableCheck(
  adapter: CheckableAdapter,
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
    // Continua NÃO abortável: só o orçamento da leitura de arquivos de pack
    // (`fileWaitTimeoutMs`, menos a margem) viaja até o adaptador.
    .then(() => adapter.checkCached(apiKey, infoHashes, {
      ...(fileWaitTimeoutMs != null
        ? { fileWaitTimeoutMs: Math.max(0, fileWaitTimeoutMs - config.debrid.packFilesWaitMarginMs) }
        : {}),
      ...(fileHashes?.length ? { fileHashes } : {}),
    }))
    .then((result) => normalizeCacheResult(adapter, result))
    .catch((err: unknown) => {
      const reason = unusableReason(err);
      if (reason) return unusable(adapter, reason, err);
      log.warn(`[${adapter.id}] falha na checagem de cache:`, log.errorMessage(err));
      return failedVerdict('falha');
    });
  nonAbortableChecks.set(key, entry);
  entry.promise.then(({ known }: { known?: boolean }) => {
    // Falha não fica memorizada: o passe tardio precisa poder tentar de novo.
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
 * Hashes que tocam na hora. `known: false` significa que o serviço não sabe
 * informar, não que nada está em cache; resposta INCOMPLETA também é
 * `known: false`, com o Set parcial preservado.
 */
async function checkCached(
  infoHashes: string[],
  { timeoutMs, forceFresh, fileHashes }: { timeoutMs?: number; forceFresh?: boolean; fileHashes?: string[] } = {},
): Promise<CacheCheckResult> {
  const adapter = rawAdapter();
  if (!adapter || infoHashes.length === 0) return { cached: new Set(), known: false };
  if (!adapter.cacheCheck) return { cached: new Set(), known: false };
  if (timeoutMs != null && timeoutMs <= 0) return { cached: new Set(), known: false };
  // Guardas de prazo ANTES do davail: quem já desistiu de perguntar mantém
  // known:false em vez de responder pelo atalho.
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
    // Pack sem lista de arquivos servido pelo davail volta à pergunta (só a
    // checagem de verdade lê arquivos), até o teto por checagem.
    const refetch = [...new Set((fileHashes || []).map((hash) => String(hash).toLowerCase()))]
      .filter((hash) => fromCache.has(hash))
      .slice(0, config.debrid.packFilesPerCheck);
    if (refetch.length) {
      toAsk = [...missing, ...refetch];
      metrics.count('davail.fileRefetch', refetch.length);
    }
    if (toAsk.length === 0) {
      renewAlive(adapter.id, apiKey, [...fromCache]);
      return { cached: fromCache, known: true };
    }
  }

  let result: CacheCheckResult;
  if (adapter.abortSafeCacheCheck === false) {
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
        log.warn(`[${adapter.id}] rate limit na checagem de cache (${log.errorMessage(err)}); tentando de novo no passe tardio`);
        result = failedVerdict('rate');
      } else {
        log.warn(`[${adapter.id}] falha na checagem de cache:`, log.errorMessage(err));
        result = failedVerdict('falha');
      }
    }
  }

  if (davailOn && !result.unusable) {
    const positives: DavailFlag[] = [];
    const negatives: DavailFlag[] = [];
    for (const hash of new Set(toAsk.map((value) => String(value).toLowerCase()))) {
      if (result.cached.has(hash)) {
        if (config.debrid.availPosTtl > 0) positives.push({ hash, cached: true });
      } else if (result.known && config.debrid.availNegTtl > 0) {
        negatives.push({ hash, cached: false });
      }
    }
    const now = Date.now();
    if (positives.length) davailState().putMany(adapter.id, apiKey, positives, config.debrid.availPosTtl, now);
    if (negatives.length) davailState().putMany(adapter.id, apiKey, negatives, config.debrid.availNegTtl, now);
  }
  if (!result.unusable) markAlive(adapter.id, apiKey, [...result.cached]);
  if (result.known && result.cached.size > 0) metrics.count('debrid.check.cached', result.cached.size);
  result.cached = new Set([...fromCache, ...result.cached]);
  return result;
}

const debridCheck = { checkCached };

export { checkCached };
export default debridCheck;
