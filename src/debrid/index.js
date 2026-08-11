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
const SERVICES = ADAPTERS.map(({ id, label, cacheCheck, keyUrl }) => ({
  id,
  label,
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
 */
async function checkCached(infoHashes) {
  const adapter = current();
  if (!adapter || infoHashes.length === 0) return { cached: new Set(), known: false };
  if (!adapter.cacheCheck) return { cached: new Set(), known: false };

  try {
    const cached = await adapter.checkCached(opts().debridApiKey, infoHashes);
    return { cached, known: true };
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

module.exports = { SERVICES, BY_ID, current, checkCached, resolveLink };
