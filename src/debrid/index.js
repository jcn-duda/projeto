const { opts } = require('../runtime');
const config = require('../config');
const { accountScope } = require('../utils/request-key');
const { raceWithDeadline } = require('../utils/deadline');
const { isAuthError, isQuotaError } = require('./common');
const metrics = require('../utils/metrics');
const log = require('../utils/logger');

// Consulta não abortável em andamento (hoje, AllDebrid). O passe tardio junta
// a mesma promise quando o conjunto de hashes é idêntico; se o balde cresceu,
// uma nova consulta é necessária para não tratar os hashes novos como checados.
const nonAbortableChecks = new Map();
const NON_ABORTABLE_CHECK_TTL_MS = 60_000;

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
 * `cacheCheck` é a diferença que mais importa na prática: Real-Debrid,
 * AllDebrid e Debrid-Link aposentaram os endpoints de disponibilidade
 * instantânea, então não dá pra saber de antemão o que toca na hora. Quem
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
 * @param {object} [opts.timeoutMs] Teto dinâmico do passo de resposta (restante
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
    const task = nonAbortableCheck(adapter, opts().debridApiKey, infoHashes);
    if (timeoutMs == null) return task;
    return raceWithDeadline(task, timeoutMs, () => {
      metrics.count('debrid.check.raceLost');
      return { cached: new Set(), known: false };
    });
  }

  try {
    const result = await adapter.checkCached(opts().debridApiKey, infoHashes, { timeoutMs });
    return normalizeCacheResult(adapter, result);
  } catch (err) {
    const reason = unusableReason(err);
    if (reason) return unusable(adapter, reason, err);
    log.warn(`[${adapter.id}] falha na checagem de cache:`, err.message);
    return { cached: new Set(), known: false };
  }
}

async function resolveLink(infoHash, episode) {
  const adapter = current();
  if (!adapter) return null;
  return adapter.resolveLink(opts().debridApiKey, infoHash, episode);
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

module.exports = { SERVICES, BY_ID, current, checkCached, resolveLink, enqueue };
