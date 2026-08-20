import crypto from 'node:crypto';
import config from '../config.js';
import * as log from './logger.js';

/**
 * Cifra a chave de debrid que viaja no segmento de config da URL.
 *
 * O segmento sempre foi base64url de um JSON — codificação, não proteção: quem
 * visse o install URL (histórico do navegador, print, log de proxy, mensagem
 * encaminhada) lia a chave inteira. TLS cobre o transporte e não cobre nada
 * disso.
 *
 * O que muda com o selo: a URL passa a carregar um blob que só ESTA instância
 * abre, porque a chave da cifra é derivada do RESOLVE_SECRET do operador. O
 * preço é a URL deixar de ser portável entre instâncias — em self-hosted isso
 * não custa nada, e quem quiser o comportamento antigo é só não definir o
 * RESOLVE_SECRET.
 *
 * O que NÃO muda: quem tem o install URL continua conseguindo usar o debrid
 * através desta instância. O selo protege a credencial, não o acesso — para
 * isso existe o basic_auth do Caddyfile.
 */
const PREFIX = 'enc.v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;
// Salt fixo: aqui ele serve para separar domínio, não para variar por usuário
// (não há onde guardar um salt por chave num esquema sem estado). O que carrega
// a entropia é o RESOLVE_SECRET.
const SALT = Buffer.from('stremio-adom/dk/v1', 'utf8');

// scrypt é caro de propósito — o RESOLVE_SECRET costuma ser uma senha escolhida
// a dedo, não 32 bytes aleatórios. Derivar a cada requisição colocaria ~100ms no
// caminho de busca, então o resultado fica em cache por segredo.
/** @type {{ secret: (string | null), key: (Buffer | null) }} */
let cached = { secret: null, key: null };

/** @returns {Buffer} */
function keyFor(secret) {
  // Se `cached.secret === secret` (strings idênticas), o `key` correspondente já
  // foi derivado — nunca é null nesse ramo. O cast repete a garantia.
  if (cached.secret === secret) return /** @type {Buffer} */ (cached.key);
  const key = crypto.scryptSync(secret, SALT, 32);
  cached = { secret, key };
  return key;
}

/** Vazio = selo desligado; sem segredo do operador não há o que derivar. */
function enabled() {
  return Boolean(config.debrid.resolveSecret);
}

function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Devolve o valor cifrado, ou o próprio valor quando o selo está desligado. */
function seal(plaintext) {
  const secret = config.debrid.resolveSecret;
  if (!secret || !plaintext || isSealed(plaintext)) return plaintext;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/**
 * Abre o valor selado. Texto puro passa direto: install URL antigo continua
 * valendo, e é isso que impede que ligar o RESOLVE_SECRET quebre quem já
 * instalou.
 *
 * Falha ao abrir devolve '' — nunca o blob cru. Sem isso, um selo corrompido
 * (ou feito com outro segredo) viraria uma "API key" literal mandada ao
 * serviço de debrid a cada busca.
 */
function open(value) {
  if (!isSealed(value)) return value;
  const secret = config.debrid.resolveSecret;
  if (!secret) {
    log.warn('[secret-box] chave selada na URL, mas RESOLVE_SECRET não está definido');
    return '';
  }

  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('blob curto demais');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      keyFor(secret),
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return (
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES), undefined, 'utf8') + decipher.final('utf8')
    );
  } catch (err) {
    // Motivo mais comum: o operador trocou o RESOLVE_SECRET e os links antigos
    // pararam de abrir. Vale dizer isso em vez de degradar em silêncio.
    log.warn('[secret-box] não consegui abrir a chave selada:', err.message);
    return '';
  }
}

export { PREFIX, enabled, isSealed, seal, open };
