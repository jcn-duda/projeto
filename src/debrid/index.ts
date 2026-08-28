import { opts } from '../runtime.js';
import type { DebridAdapter, InventoryItem, PlayHint } from '../../types/domain.js';
import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { prefix } from '../utils/cache-keys.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { isAuthError, isQuotaError, isRateLimitError } from './common.js';
import * as inventoryMemo from './inventory-memo.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as magnetdb from '../utils/magnetdb.js';
import { notify } from '../utils/notify.js';
import * as rdOracle from './rd-oracle.js';
import * as rdLedger from './rd-ledger.js';
import * as catalog from '../utils/catalog.js';
import { recordFileEvidence } from './audio-audit.js';

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
 * Registry de serviços de debrid. Cada adaptador expõe a mesma forma:
 *
 *   { id, label, cacheCheck, keyUrl, checkCached(apiKey, hashes), resolveLink(apiKey, hash, ep) }
 *
 * `cacheCheck` é a diferença que mais importa na prática: Real-Debrid e
 * Debrid-Link aposentaram os endpoints de disponibilidade instantânea, então
 * não dá pra saber de antemão o que toca na hora. AllDebrid mede via
 * `/magnet/upload` (`cacheCheck: true`, consulta não abortável). Quem
 * responde `false` faz o orquestrador ignorar o filtro "somente em cache" em
 * vez de esconder a lista inteira.
 */
import * as premiumize from './premiumize.js';
import * as realdebrid from './realdebrid.js';
import * as alldebrid from './alldebrid.js';
import * as torbox from './torbox.js';
import * as debridlink from './debridlink.js';

// Namespace ESM é congelado; os testes trocam métodos do adaptador (mock) e o
// registry precisa entregar o MESMO objeto mutável que o module.exports dava.
const ADAPTERS: DebridAdapter[] = [
  { ...premiumize },
  { ...realdebrid },
  { ...alldebrid },
  { ...torbox },
  { ...debridlink },
];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

/** Metadados para a página de configuração — sem nada sensível. */
const SERVICES = ADAPTERS.map(({ id, label, short, cacheCheck, keyUrl }) => ({
  id,
  label,
  // Sigla para onde não cabe o nome inteiro (badge do cabeçalho). O nome
  // completo continua no seletor: sigla sozinha não se explica.
  short,
  cacheCheck,
  keyUrl,
}));

/**
 * Adaptador da requisição corrente, ou null quando o usuário está em P2P puro.
 */
function current(): DebridAdapter | null {
  const { debridService, debridApiKey } = opts();
  if (!debridService || !debridApiKey) return null;
  const adapter = BY_ID.get(debridService);
  if (!adapter) {
    log.warn(`[debrid] serviço desconhecido: ${debridService}`);
    return null;
  }
  // RD só passa a prometer cacheCheck quando o ledger pode conservar a prova e
  // existe pelo menos uma fonte externa. O clone evita mudar a semântica dos
  // outros serviços nem congelar o kill-switch no carregamento do módulo.
  if (adapter.id === 'realdebrid') {
    // available() exige fonte utilizável COM a credencial efetiva da instalação;
    // sem apiKey (P2P puro) o RD honesto não promete cacheCheck.
    return { ...adapter, cacheCheck: config.debrid.rdLedger.enabled && rdOracle.available(debridApiKey) };
  }
  return adapter;
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

// Acima disto o verificador avisa: encher a conta derruba a checagem de cache
// inteira (ela é um upload), e o sintoma na tela — o ⚡ sumindo de TODOS os
// streams — não aponta para a causa.
//
// É um limiar nosso, não o limite do serviço: a AllDebrid tem dois tetos que
// não batem entre si (30 "ativos" na doc, 1000 na mensagem de erro real) e
// nenhum é consultável. 800 dá margem para limpar antes de quebrar; ajuste se
// a sua conta aguentar mais.
const ACCOUNT_WARN_TOTAL = config.debrid.accountWarnTotal;
// Fair-use do Premiumize (`limit_used` em [0, 1]). 0 desliga o aviso.
const ACCOUNT_WARN_LIMIT_USED = config.debrid.accountWarnLimitUsed;

/**
 * Saúde da conta do serviço corrente, para o endpoint de diagnóstico.
 *
 * Nunca lança: o verificador precisa responder justamente quando o serviço está
 * ruim. Os motivos vêm classificados igual ao da busca (`auth`/`quota`), então
 * a mesma linguagem serve para o log e para o JSON.
 */
async function accountStatusFor(adapter: DebridAdapter | null, apiKey: string) {
  if (!adapter) return { ok: false, reason: 'sem-debrid', service: null };
  if (typeof adapter.accountStatus !== 'function') {
    return { ok: true, service: adapter.id, label: adapter.label, supported: false };
  }

  try {
    const status = await adapter.accountStatus(apiKey);
    // O fair-use sai numa variável PRÓPRIA em vez de um booleano `byFairUse`
    // consultando `status.limitUsed` depois: `Number.isFinite` não estreita o
    // tipo através de um intermediário, e o campo é opcional (só o Premiumize
    // publica). Mesmo teste, mesmo resultado — agora verificável.
    const fairUse = Number.isFinite(status.limitUsed) ? Number(status.limitUsed) : null;
    const warn = fairUse !== null
      ? ACCOUNT_WARN_LIMIT_USED > 0 && fairUse >= ACCOUNT_WARN_LIMIT_USED
      : Number(status.magnets) >= ACCOUNT_WARN_TOTAL;
    const warnAt = fairUse !== null ? ACCOUNT_WARN_LIMIT_USED : ACCOUNT_WARN_TOTAL;
    const warnAtUnit = fairUse !== null ? 'fair-use' : 'magnets';
    if (warn) {
      if (fairUse !== null) {
        log.warn(
          `[${adapter.id}] fair-use ${Math.round(fairUse * 100)}% ` +
            `(aviso a partir de ${Math.round(ACCOUNT_WARN_LIMIT_USED * 100)}%); ` +
            'quando o serviço recusar (account_limit_reached) a lista degrada para P2P',
        );
      } else {
        log.warn(
          `[${adapter.id}] ${status.magnets} magnet(s) na conta (aviso a partir de ${ACCOUNT_WARN_TOTAL});` +
            ' quando o serviço recusar novos uploads a checagem de cache para e o ⚡ some da lista inteira' +
            ' — limpe com scripts/magnets.js',
        );
      }
    }
    return {
      ...status,
      ok: true,
      service: adapter.id,
      label: adapter.label,
      supported: true,
      warn,
      warnAt,
      warnAtUnit,
    };
  } catch (err) {
    const reason = failureReason(err);
    const fix = reason === 'auth'
      ? UNUSABLE.auth.fix(adapter)
      : reason === 'quota'
        ? UNUSABLE.quota.fix()
        : reason === 'rate'
          ? 'aguarde alguns minutos para o rate limit passar e consulte novamente'
          : null;
    return { ok: false, service: adapter.id, label: adapter.label, reason, error: err.message, fix };
  }
}

async function accountStatus() {
  const adapter = current();
  return accountStatusFor(adapter, opts().debridApiKey);
}

function withAccountTimeout(task: Promise<any>) {
  return Promise.race([
    task,
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, reason: 'timeout', error: 'timeout consultando o debrid' }),
        config.debrid.dashboardAccountTimeoutMs,
      );
      timer.unref?.();
    }),
  ]);
}

/**
 * Contas que a requisição realmente conhece. Não existe chave para os outros
 * adaptadores, então exibi-los como "offline" seria uma mentira operacional.
 */
async function dashboardAccounts(currentStatus: any) {
  const accounts: Record<string, any> = {};
  const active = current();
  if (active && currentStatus?.service) accounts[active.id] = currentStatus;

  const operator = config.debrid.service ? BY_ID.get(config.debrid.service) || null : null;
  if (
    operator &&
    operator.id !== active?.id &&
    config.debrid.apiKey &&
    config.debrid.allowEnvKey
  ) {
    accounts[operator.id] = await withAccountTimeout(accountStatusFor(operator, config.debrid.apiKey));
  }
  return accounts;
}

async function resolveLink(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter) return null;
  return adapter.resolveLink(opts().debridApiKey, infoHash, episode);
}

// Inventário em voo por serviço+conta: buscas concorrentes não pagam a mesma
// leitura da conta.
const inventoryInFlight = new Map();

function inventoryFor(adapter: DebridAdapter, apiKey: string) {
  if (typeof adapter.inventory !== 'function') return Promise.resolve([]);
  const loadInventory = adapter.inventory;
  const key = inventoryMemo.memoKey(adapter.id, apiKey);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  let task = inventoryInFlight.get(key);
  if (!task) {
    task = Promise.resolve()
      .then(() => loadInventory(apiKey))
      .then((items) => {
        // Teto defensivo: a conta real medida tem 1208 prontos; resposta
        // degenerada não pode entrar inteira no cache.
        const list = (Array.isArray(items) ? items : []).slice(0, config.debrid.inventoryMax);
        inventoryMemo.store(adapter.id, apiKey, list);
        log.info(`[${adapter.id}] inventário da conta: ${list.length} item(ns) pronto(s)`);
        return list;
      });
    inventoryInFlight.set(key, task);
    // A corrida da resposta pode ter desistido desta promise: sem isto, a
    // rejeição tardia virava unhandled. Falha NÃO fica cacheada — a próxima
    // busca tenta de novo (mesmo contrato do knownBefore e do nonAbortable).
    const cleanup = () => {
      if (inventoryInFlight.get(key) === task) inventoryInFlight.delete(key);
    };
    task.then(cleanup, cleanup);
  }
  return task;
}

/**
 * Leitura síncrona do memo dinv da conta: cache.get, sem rede, sem in-flight.
 * null = memo frio.
 */
function inventoryPeek(adapter?: DebridAdapter | null, apiKey?: string): InventoryItem[] | null {
  const ad = adapter || current();
  const key = apiKey || opts().debridApiKey;
  if (!ad || !key) return null;
  return inventoryMemo.peek(ad.id, key);
}

/**
 * Itens prontos na conta do serviço corrente (`{ title, infoHash, size }`).
 * É o que sustenta a conta-como-fonte: o que o usuário já baixou entra na
 * busca com ⚡ sem depender de indexer. Memoizado por serviço+conta —
 * inventário é privado — com TTL próprio. Adaptador sem `inventory` devolve
 * [] (a feature vira no-op para ele).
 */
async function inventory() {
  const adapter = current();
  if (!adapter || typeof adapter.inventory !== 'function') return [];
  return inventoryFor(adapter, opts().debridApiKey);
}

/** Invalida só memos de inventários que esta requisição pode alcançar. */
function refreshInventory() {
  const keys = new Set<string>();
  const active = current();
  const activeKey = opts().debridApiKey;
  if (active && activeKey) keys.add(inventoryMemo.memoKey(active.id, activeKey));

  const operator = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (operator && config.debrid.apiKey && config.debrid.allowEnvKey) {
    keys.add(inventoryMemo.memoKey(operator.id, config.debrid.apiKey));
  }
  cache.forgetMany([...keys]);
  return { refreshed: keys.size };
}

/**
 * Manda o torrent baixar no serviço e volta na hora — NÃO espera ficar pronto.
 * É o que sustenta o download automático da fonte BR dublada: o play só
 * funciona depois, quando o serviço terminar.
 */
async function enqueue(infoHash: string, episode?: PlayHint) {
  const adapter = current();
  if (!adapter || typeof adapter.enqueue !== 'function') return false;
  try {
    return await adapter.enqueue(opts().debridApiKey, infoHash, episode || {});
  } catch (err) {
    // O runner precisa distinguir cooldown RD de recusa do torrent para repor
    // a cabeça da fila. Os demais adapters preservam o fail-soft histórico.
    if (adapter.id === 'realdebrid' && isRateLimitError(err)) throw err;
    log.warn(`[${adapter.id}] falha ao enfileirar ${infoHash}:`, err.message);
    return false;
  }
}

/**
 * Aquece o inventário da conta configurada no operador antes da primeira busca.
 * Chaves seladas de instalações continuam no carregamento preguiçoso, pois só
 * existem durante a requisição.
 */
function warmupEnv() {
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (!adapter) return Promise.resolve(null);

  // Aquece também o inventário-como-fonte da conta do operador: a primeira
  // leitura custa ~700ms (medido numa conta com 1208 magnets) e não pode
  // cair dentro da primeira busca.
  if (
    config.debrid.inventorySource &&
    typeof adapter.inventory === 'function' &&
    config.debrid.apiKey && config.debrid.allowEnvKey
  ) {
    inventoryFor(adapter, config.debrid.apiKey).catch((err: unknown) => {
      log.warn(`[${adapter.id}] não consegui aquecer o inventário como fonte:`, log.errorMessage(err));
    });
  }

  if (typeof adapter.warmInventory !== 'function') return Promise.resolve(null);
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.dropReady) return Promise.resolve(null);
  return adapter.warmInventory(config.debrid.apiKey).catch((err: unknown) => {
    log.warn(`[${adapter.id}] não consegui aquecer o inventário:`, log.errorMessage(err));
    return null;
  });
}

/**
 * Varredura dos magnets mortos da conta do operador. Roda no boot e em
 * intervalo: o lixo que a limpeza por busca não alcança é justamente o que
 * nunca mais aparece numa consulta.
 */
async function sweepDeadEnv() {
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.sweepDead !== 'function') return null;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.sweepDead) return null;
  try {
    return await adapter.sweepDead(config.debrid.apiKey);
  } catch (err) {
    log.warn(`[${adapter.id}] varredura de mortos falhou:`, err.message);
    return null;
  }
}

/**
 * Varredura dos magnets antigos sem áudio PT da conta do operador. Mesma
 * guarda do `sweepDeadEnv`: só a chave do `.env`, com `allowEnvKey` e o
 * toggle ligado — é varredura do operador, não de uma instalação.
 */
async function sweepUndubbedEnv() {
  const adapter = config.debrid.service ? BY_ID.get(config.debrid.service) : null;
  if (!adapter || typeof adapter.sweepUndubbed !== 'function') return null;
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.sweepUndubbed) return null;
  try {
    return await adapter.sweepUndubbed(config.debrid.apiKey);
  } catch (err) {
    log.warn(`[${adapter.id}] varredura de não-dublados falhou:`, err.message);
    return null;
  }
}

/**
 * Varredura da conta da INSTALAÇÃO corrente (a chave que veio no segmento de
 * config), e não a do `.env`.
 *
 * `sweepDeadEnv` é do operador: exige `allowEnvKey` e usa `config.debrid.apiKey`.
 * Quem abre o painel com uma install URL de outro serviço não é atendido por
 * ele — o botão respondia "varredura indisponível" mesmo com o adaptador certo
 * do outro lado, porque estava olhando para a conta errada.
 */
async function sweepDeadCurrent() {
  const adapter = current();
  if (!adapter || typeof adapter.sweepDead !== 'function') return null;
  const { debridApiKey } = opts();
  if (!debridApiKey || !config.debrid.sweepDead) return null;
  try {
    return await adapter.sweepDead(debridApiKey);
  } catch (err: unknown) {
    log.warn(`[${adapter.id}] varredura de mortos falhou:`, log.errorMessage(err));
    return null;
  }
}

/**
 * Consulta se o hash é um play instantâneo já comprovado para o adaptador
 * corrente (hoje, Real-Debrid via ledger quando ledger e oráculo estão ativos).
 * Outros adaptadores devolvem false.
 */
function knownInstant(hash: string): boolean {
  const adapter = current();
  if (!adapter || adapter.id !== 'realdebrid') return false;
  // O clone do current() já embute a credencial da requisição no cacheCheck
  // (rdLedger.enabled && rdOracle.available(debridApiKey)); reaproveitá-lo aqui
  // evita re-resolver a chave fora do ALS.
  if (!adapter.cacheCheck) return false;
  return rdLedger.isHit(hash);
}

export { knownInstant };

// ---------------------------------------------------------------------------
// Catálogo durável + limpador BR da conta do OPERADOR (AllDebrid)
// ---------------------------------------------------------------------------
//
// Mesmo padrão do `sweepUndubbedEnv`: adapter vem de `config.debrid.service`
// via BY_ID, chave de `config.debrid.apiKey` com `allowEnvKey`. NUNCA lançam —
// devolvem `{ ok:false, reason }` e capturam erro com log.warn, para a rota
// operacional responder diagnóstico em vez de cair.

/** Operador configurado para o catálogo, ou null + reason de indisponibilidade. */
function catalogContext(): { adapter: DebridAdapter | null; guardos: { ok: false; reason: string } | null } {
  if (!config.debrid.service) return { adapter: null, guardos: { ok: false, reason: 'sem-debrid' } };
  const adapter = BY_ID.get(config.debrid.service) || null;
  // magnetList é quem prova que o adaptador suporta a varredura da conta.
  if (!adapter || typeof adapter.magnetList !== 'function') {
    return { adapter, guardos: { ok: false, reason: 'sem-adapter-catalogo' } };
  }
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey) {
    return { adapter, guardos: { ok: false, reason: 'sem-conta-operador' } };
  }
  return { adapter, guardos: null };
}

/** Varre a conta do operador e devolve o relatório do catálogo. */
async function catalogScanEnv() {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  try {
    const magnets = await adapter.magnetList!(config.debrid.apiKey);
    const report = catalog.scan({
      adapterId: adapter.id,
      account: accountScope(config.debrid.apiKey),
      magnets,
      // O operatorCtx() do br-coverage é específico da Fase 3 (só enxerga a
      // conta RD do .env) e devolveria adapterId null para a AllDebrid — o ⚡
      // do catálogo sairia sempre "unknown". Aqui o alvo é a CONTA do
      // operador: davail e mag:alive são gravados exatamente com
      // adapter+accountScope, então o ctx correto é o próprio adapter ativo.
      ctx: { adapterId: adapter.id, apiKey: config.debrid.apiKey },
    });
    return { ok: true, report };
  } catch (err: unknown) {
    log.warn(`[catalog] varredura falhou:`, log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

/** Relatório do catálogo (leitura do banco, sem rede). */
function catalogStatusEnv() {
  const { guardos } = catalogContext();
  if (guardos) return guardos;
  return { ok: true, report: catalog.report(accountScope(config.debrid.apiKey)) };
}

/** Plano de deduplicação (leitura pura; nenhuma deleção). */
function dedupPreviewEnv() {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  return { ok: true, plan: catalog.planDedup(accountScope(config.debrid.apiKey), adapter.id) };
}

/** Aplica os kills do plano de dedup (com teto `max` se dado). */
async function dedupApplyEnv(max?: number) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const account = accountScope(config.debrid.apiKey);
  const plan = catalog.planDedup(account, adapter.id);
  const deletions: Array<{ serviceId: string | number; hash: string; reason: string }> = [];
  for (const g of plan.t1) for (const k of g.kill) deletions.push({ serviceId: k.serviceId, hash: k.hash, reason: 'duplicado' });
  for (const g of plan.t2) for (const k of g.kill) deletions.push({ serviceId: k.serviceId, hash: k.hash, reason: 'duplicado por arquivo' });
  const byId = new Map<string, (typeof deletions)[number]>();
  for (const d of deletions) byId.set(String(d.serviceId), d);
  let list = [...byId.values()];
  if (max != null && Number.isFinite(max)) list = list.slice(0, Math.max(0, Math.trunc(max)));
  try {
    const res = await catalog.applyDeletions(account, adapter.id, list, (ids) => adapter.deleteMagnets!(config.debrid.apiKey, ids));
    metrics.count('dashboard.catalog.dedup', res.ok);
    return { ok: true, deleted: res.ok, falhas: res.falhas };
  } catch (err: unknown) {
    log.warn(`[catalog] dedup falhou:`, log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

/** Auditoria em fundo: prova os arquivos das linhas sem evidência no índice. */
async function auditBackfillEnv({ max, concurrency }: { max?: number; concurrency?: number } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const account = accountScope(config.debrid.apiKey);
  const teto = max ?? config.catalog.auditMaxPerRound;
  const workers = Math.min(3, Math.max(1, Math.trunc(concurrency ?? config.catalog.auditConcurrency)));
  const rows = catalog.rowsNeedingAudit(account, teto);
  let scanned = 0;
  let evidenced = 0;
  let failed = 0;
  let idx = 0;
  const work = async () => {
    for (;;) {
      const row = rows[idx++];
      if (!row) break;
      try {
        const files = await adapter.magnetFiles!(config.debrid.apiKey, row.serviceId);
        scanned += 1;
        if (files && files.length > 0) {
          recordFileEvidence(row.hash, files as any);
          catalog.noteAudit(account, row.serviceId, row.hash, files);
          evidenced += 1;
        } else {
          // Pronto mas sem arquivos listados NESTA leitura: nada a aprender,
          // então marca auditada para a fila não re-visitar o mesmo ítem a cada
          // rodada. Mas NÃO congela quem está condenado SÓ PELO TÍTULO: uma
          // condenação de título ainda pode ser ABSOLVIDA pelos arquivos reais
          // numa rodada futura (o post pode mentir o áudio, o .mkv não), e
          // marcar aqui perpetuaria a condenação via keepAudited — falso
          // positivo apaga acervo BR bom. A janela "Ready sem arquivos" é
          // transiente; um magnet verdadeiramente Ready enumera arquivos numa
          // destas. O helper marca só quando foreignProof=='' (unknown/dual/
          // lixo sem condenação), mantendo o dreno principal inalterado.
          catalog.markAuditedUnlessCondemned(account, row.serviceId);
        }
      } catch (err: unknown) {
        failed += 1;
        log.warn(`[catalog] auditoria do magnet ${row.serviceId} falhou:`, log.errorMessage(err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => work()));
  return { ok: true, scanned, evidenced, failed };
}

/**
 * Acervo que JÁ ERA da conta do operador, para a limpeza BR com prova. Mesma
 * regra do sweepUndubbed: sem snapshot (`null`/adapter sem a função) o
 * fail-safe FECHA — ausência de referência nunca autoriza remoção.
 */
async function operatorKnownHashes(adapter: DebridAdapter): Promise<Set<string> | null> {
  if (typeof adapter.preexistingHashes !== 'function') return null;
  try {
    return await adapter.preexistingHashes(config.debrid.apiKey);
  } catch (err: unknown) {
    log.warn('[catalog] inventário de preexistentes falhou:', log.errorMessage(err));
    return null;
  }
}

/**
 * Plano da limpeza de estrangeiro provado (leitura pura).
 *
 * `includeKnown` liga a limpeza pelo OPERADOR sobre o acervo que JÁ ERA da
 * conta. No processo recém-subido, o `knownBefore` do alldebrid monta o
 * snapshot com TUDO que está na conta (o `submitted` em memória está vazio) —
 * a guarda que protege o acervo do usuário anulava a limpeza iniciada no
 * painel. Com `includeKnown` true o wrapper NÃO fica preso ao snapshot: tenta
 * o inventário se já estiver quente (para o painel marcar "(preexistente)"),
 * mas `null` não bloqueia mais. Com `includeKnown` falso/ausente mantém o
 * fail-closed de hoje (sem snapshot → `inventario-frio`).
 */
async function cleanupPreviewEnv({ includeKnown }: { includeKnown?: boolean } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const conhecidos = await operatorKnownHashes(adapter);
  if (!includeKnown && conhecidos === null) return { ok: false, reason: 'inventario-frio' };
  const plan = catalog.planForeignCleanup(accountScope(config.debrid.apiKey), adapter.id, {
    minAgeMs: config.catalog.cleanupMinAgeMs,
    max: config.catalog.cleanupMaxPerRound,
    knownHashes: conhecidos,
    includeKnown: includeKnown === true,
  });
  return { ok: true, ...plan };
}

/** Aplica a limpeza de estrangeiro provado (com teto `max` se dado). */
async function cleanupApplyEnv(max?: number, { includeKnown }: { includeKnown?: boolean } = {}) {
  const { adapter, guardos } = catalogContext();
  if (adapter == null || guardos) return guardos || { ok: false, reason: 'sem-adapter' };
  const account = accountScope(config.debrid.apiKey);
  const conhecidos = await operatorKnownHashes(adapter);
  if (!includeKnown && conhecidos === null) return { ok: false, reason: 'inventario-frio' };
  const plan = catalog.planForeignCleanup(account, adapter.id, {
    minAgeMs: config.catalog.cleanupMinAgeMs,
    max: config.catalog.cleanupMaxPerRound,
    knownHashes: conhecidos,
    includeKnown: includeKnown === true,
  });
  const list = max != null && Number.isFinite(max) ? plan.targets.slice(0, Math.max(0, Math.trunc(max))) : plan.targets;
  const deletions = list.map((t) => ({ serviceId: t.serviceId, hash: t.hash, reason: t.reason }));
  try {
    const res = await catalog.applyDeletions(
      account,
      adapter.id,
      deletions,
      (ids) => adapter.deleteMagnets!(config.debrid.apiKey, ids),
    );
    metrics.count('dashboard.catalog.cleanup', res.ok);
    return { ok: true, total: list.length, deleted: res.ok, falhas: res.falhas };
  } catch (err: unknown) {
    log.warn(`[catalog] limpeza falhou:`, log.errorMessage(err));
    return { ok: false, reason: 'erro' };
  }
}

export default {
  SERVICES, BY_ID, current, checkCached, noteAvailable, accountStatus, dashboardAccounts, resolveLink, enqueue, inventory, inventoryPeek, refreshInventory, warmupEnv, sweepDeadEnv, sweepUndubbedEnv, sweepDeadCurrent, knownInstant, catalogScanEnv, catalogStatusEnv, dedupPreviewEnv, dedupApplyEnv, auditBackfillEnv, cleanupPreviewEnv, cleanupApplyEnv,
};
