const { opts } = require('../runtime');

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
    console.warn(`[debrid] serviço desconhecido: ${debridService}`);
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
  // A checagem da AllDebrid faz upload de verdade. Abortá-la depois que o
  // servidor aceitou o magnet impediria ler o id e limpar os não cacheados,
  // recriando downloads-fantasma. No passo limitado adiamos a consulta inteira;
  // o passe tardio, sem teto, executa upload + limpeza normalmente.
  if (timeoutMs != null && adapter.abortSafeCacheCheck === false) {
    return { cached: new Set(), known: false };
  }

  try {
    const result = await adapter.checkCached(opts().debridApiKey, infoHashes, { timeoutMs });
    // Adaptador pode devolver só o Set (sem lotes) ou { cached, complete }.
    const cached = result instanceof Set ? result : result?.cached || new Set();
    const complete = result instanceof Set ? true : result?.complete !== false;
    if (!complete) {
      console.warn(
        `[${adapter.id}] checagem de cache incompleta; tratando como "não sei" em vez de "não tem"`,
      );
    }
    return { cached, known: complete };
  } catch (err) {
    console.warn(`[${adapter.id}] falha na checagem de cache:`, err.message);
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
    console.warn(`[${adapter.id}] falha ao enfileirar ${infoHash}:`, err.message);
    return false;
  }
}

module.exports = { SERVICES, BY_ID, current, checkCached, resolveLink, enqueue };
