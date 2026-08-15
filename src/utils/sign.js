const crypto = require('crypto');
const config = require('../config');
const { opts } = require('../runtime');

/**
 * Assinatura da rota /resolve. Sem ela, quem descobrisse a PUBLIC_URL e um
 * infoHash (os hashes aparecem nos resultados públicos dos indexers) podia
 * consumir a conta debrid alheia montando URLs na mão.
 *
 * O segredo é o RESOLVE_SECRET do operador ou, na falta dele, a API key de
 * debrid efetiva da requisição — que viaja dentro do próprio segmento de
 * config da URL, então a assinatura continua verificável no /resolve sem
 * estado no servidor.
 */
function secret() {
  return config.debrid.resolveSecret || opts().debridApiKey || '';
}

/** Assina `${infoHash}${ep}` (ep no formato "?s=1&e=2" ou ""). */
function signResolve(infoHash, ep = '') {
  const key = secret();
  if (!key) return '';
  return crypto.createHmac('sha256', key).update(`${infoHash}${ep}`).digest('hex');
}

/** Comparação em tempo constante; sem segredo ativo a rota não é assinável. */
function verifyResolve(infoHash, ep, sig) {
  const expected = signResolve(infoHash, ep);
  if (!expected || typeof sig !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signResolve, verifyResolve };
