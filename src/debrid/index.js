// @ts-check
const { opts } = require('../runtime');
const config = require('../config');
const { accountScope } = require('../utils/request-key');
const { prefix } = require('../utils/cache-keys');
const { raceWithDeadline } = require('../utils/deadline');
const { isAuthError, isQuotaError, isRateLimitError } = require('./common');
const cache = require('../utils/cache');
const metrics = require('../utils/metrics');
const log = require('../utils/logger');

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

function trackCheckedHashes(infoHashes) {
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
    fix: (adapter) =>
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

function unusable(adapter, reason, err) {
  const kind = UNUSABLE[reason];
  metrics.count(kind.metric);
  log.warn(`[${adapter.id}] ${kind.label} (${err.message}); a lista volta como P2P — ${kind.fix(adapter)}`);
  return { cached: new Set(), known: false, unusable: { reason, message: err.message } };
}

/** Classifica o que impede o serviço de funcionar, ou null se for transitório. */
function unusableReason(err) {
  if (isAuthError(err)) return 'auth';
  if (isQuotaError(err)) return 'quota';
  return null;
}

/** Rate limit é transitório: não entra em unusable. Só classifica o diagnóstico. */
function failureReason(err) {
  return unusableReason(err) || (isRateLimitError(err) ? 'rate' : 'falha');
}

function normalizeCacheResult(adapter, result) {
  const cached = result instanceof Set ? result : result?.cached || new Set();
  const complete = result instanceof Set ? true : result?.complete !== false;
  if (!complete) {
    log.warn(
      `[${adapter.id}] checagem de cache incompleta; tratando como "não sei" em vez de "não tem"`,
    );
  }
  return { cached, known: complete };
}

function nonAbortableKey(adapter, apiKey, infoHashes) {
  const hashes = [...new Set(infoHashes.map((hash) => String(hash).toLowerCase()))].sort();
  return `${adapter.id}:${accountScope(apiKey)}:${hashes.join(',')}`;
}

function nonAbortableCheck(adapter, apiKey, infoHashes) {
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
    .catch((err) => {
      // A AllDebrid é justamente o serviço que passa por aqui, então a
      // credencial recusada precisa ser reconhecida NESTE catch também — não
      // só no caminho abortável lá embaixo.
      const reason = unusableReason(err);
      if (reason) return unusable(adapter, reason, err);
      log.warn(`[${adapter.id}] falha na checagem de cache:`, err.message);
      return { cached: new Set(), known: false };
    });
  nonAbortableChecks.set(key, entry);
  entry.promise.then(({ known }) => {
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
const ADAPTERS = [
  require('./premiumize'),
  require('./realdebrid'),
  require('./alldebrid'),
  require('./torbox'),
  require('./debridlink'),
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

/** Adaptador da requisição corrente, ou null quando o usuário está em P2P puro. */
function current() {
  const { debridService, debridApiKey } = opts();
  if (!debridService || !debridApiKey) return null;
  const adapter = BY_ID.get(debridService);
  if (!adapter) {
    log.warn(`[debrid] serviço desconhecido: ${debridService}`);
    return null;
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
async function checkCached(infoHashes, { timeoutMs } = {}) {
  const adapter = current();
  if (!adapter || infoHashes.length === 0) return { cached: new Set(), known: false };
  if (!adapter.cacheCheck) return { cached: new Set(), known: false };

  // Tempo restante esgotado: degrada na hora, sem rede. É a MESMA semântica de
  // resposta incompleta (lista inteira via debrid, sem ⚡ falso).
  if (timeoutMs != null && timeoutMs <= 0) return { cached: new Set(), known: false };
  // A checagem da AllDebrid faz upload de verdade. Ela pode disputar o prazo,
  // mas nunca é abortada: se perder, continua em background, lê os ids e limpa
  // os não cacheados. O passe tardio junta a mesma promise.
  if (adapter.abortSafeCacheCheck === false) {
    if (timeoutMs != null && timeoutMs < config.debrid.nonAbortableRaceFloor) {
      return { cached: new Set(), known: false };
    }
    // Medição fica no ponto onde a checagem REAL acontece: degradação por
    // prazo ou ausência de serviço não é pergunta feita ao debrid.
    trackCheckedHashes(infoHashes);
    const task = nonAbortableCheck(adapter, opts().debridApiKey, infoHashes);
    if (timeoutMs == null) return task;
    return raceWithDeadline(task, timeoutMs, () => {
      metrics.count('debrid.check.raceLost');
      return { cached: new Set(), known: false };
    });
  }

  trackCheckedHashes(infoHashes);
  try {
    const result = await adapter.checkCached(opts().debridApiKey, infoHashes, { timeoutMs });
    return normalizeCacheResult(adapter, result);
  } catch (err) {
    const reason = unusableReason(err);
    if (reason) return unusable(adapter, reason, err);
    if (isRateLimitError(err)) {
      metrics.count('debrid.rate_limit');
      log.warn(`[${adapter.id}] rate limit na checagem de cache (${err.message}); tentando de novo no passe tardio`);
      return { cached: new Set(), known: false };
    }
    log.warn(`[${adapter.id}] falha na checagem de cache:`, err.message);
    return { cached: new Set(), known: false };
  }
}

// Acima disto o verificador avisa: encher a conta derruba a checagem de cache
// inteira (ela é um upload), e o sintoma na tela — o ⚡ sumindo de TODOS os
// streams — não aponta para a causa.
//
// É um limiar nosso, não o limite do serviço: a AllDebrid tem dois tetos que
// não batem entre si (30 "ativos" na doc, 1000 na mensagem de erro real) e
// nenhum é consultável. 800 dá margem para limpar antes de quebrar; ajuste se
// a sua conta aguentar mais.
const ACCOUNT_WARN_TOTAL = Number(process.env.DEBRID_ACCOUNT_WARN_TOTAL || 800);
// Fair-use do Premiumize (`limit_used` em [0, 1]). 0 desliga o aviso.
const parsedWarnLimit = Number(process.env.DEBRID_ACCOUNT_WARN_LIMIT_USED ?? 0.8);
const ACCOUNT_WARN_LIMIT_USED = Number.isFinite(parsedWarnLimit)
  ? Math.min(1, Math.max(0, parsedWarnLimit))
  : 0.8;

/**
 * Saúde da conta do serviço corrente, para o endpoint de diagnóstico.
 *
 * Nunca lança: o verificador precisa responder justamente quando o serviço está
 * ruim. Os motivos vêm classificados igual ao da busca (`auth`/`quota`), então
 * a mesma linguagem serve para o log e para o JSON.
 */
async function accountStatus() {
  const adapter = current();
  if (!adapter) return { ok: false, reason: 'sem-debrid', service: null };
  if (typeof adapter.accountStatus !== 'function') {
    return { ok: true, service: adapter.id, label: adapter.label, supported: false };
  }

  try {
    const status = await adapter.accountStatus(opts().debridApiKey);
    const byFairUse = Number.isFinite(status.limitUsed);
    const warn = byFairUse
      ? ACCOUNT_WARN_LIMIT_USED > 0 && status.limitUsed >= ACCOUNT_WARN_LIMIT_USED
      : Number(status.magnets) >= ACCOUNT_WARN_TOTAL;
    const warnAt = byFairUse ? ACCOUNT_WARN_LIMIT_USED : ACCOUNT_WARN_TOTAL;
    const warnAtUnit = byFairUse ? 'fair-use' : 'magnets';
    if (warn) {
      if (byFairUse) {
        log.warn(
          `[${adapter.id}] fair-use ${Math.round(status.limitUsed * 100)}% ` +
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
    return { ok: false, service: adapter.id, label: adapter.label, reason, error: err.message };
  }
}

async function resolveLink(infoHash, episode) {
  const adapter = current();
  if (!adapter) return null;
  return adapter.resolveLink(opts().debridApiKey, infoHash, episode);
}

// Inventário em voo por serviço+conta: buscas concorrentes não pagam a mesma
// leitura da conta.
const inventoryInFlight = new Map();

function inventoryFor(adapter, apiKey) {
  const key = `${prefix('dinv')}${adapter.id}:${accountScope(apiKey)}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  let task = inventoryInFlight.get(key);
  if (!task) {
    task = Promise.resolve()
      .then(() => adapter.inventory(apiKey))
      .then((items) => {
        // Teto defensivo: a conta real medida tem 1208 prontos; resposta
        // degenerada não pode entrar inteira no cache.
        const list = (Array.isArray(items) ? items : []).slice(0, config.debrid.inventoryMax);
        cache.set(key, list, config.debrid.inventoryTtl);
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

/**
 * Manda o torrent baixar no serviço e volta na hora — NÃO espera ficar pronto.
 * É o que sustenta o download automático da fonte BR dublada: o play só
 * funciona depois, quando o serviço terminar.
 */
async function enqueue(infoHash, episode) {
  const adapter = current();
  if (!adapter || typeof adapter.enqueue !== 'function') return false;
  try {
    return await adapter.enqueue(opts().debridApiKey, infoHash, episode || {});
  } catch (err) {
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
    inventoryFor(adapter, config.debrid.apiKey).catch((err) => {
      log.warn(`[${adapter.id}] não consegui aquecer o inventário como fonte:`, err.message);
    });
  }

  if (typeof adapter.warmInventory !== 'function') return Promise.resolve(null);
  if (!config.debrid.apiKey || !config.debrid.allowEnvKey || !config.debrid.dropReady) return Promise.resolve(null);
  return adapter.warmInventory(config.debrid.apiKey).catch((err) => {
    log.warn(`[${adapter.id}] não consegui aquecer o inventário:`, err.message);
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

module.exports = {
  SERVICES, BY_ID, current, checkCached, accountStatus, resolveLink, enqueue, inventory, warmupEnv, sweepDeadEnv,
};
