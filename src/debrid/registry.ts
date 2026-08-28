import { opts } from '../runtime.js';
import type { DebridAdapter } from '../../types/domain.js';
import config from '../config.js';
import * as log from '../utils/logger.js';
import * as rdOracle from './rd-oracle.js';

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

export { ADAPTERS, BY_ID, SERVICES, current };
