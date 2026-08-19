// @ts-check
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

/**
 * Assina `${infoHash}${ep}` (+ `&w=${hint}` quando há dica de obra).
 *
 * `hint` é a dica de obra (JSON com nomes/ano) usada pelo /resolve para
 * escolher o arquivo certo dentro de pack multi-filme. Ela entra na string
 * assinada — sem isso a rota aceitaria dica forjada e viraria um jeito de
 * escolher arquivo arbitrário na conta alheia.
 *
 * Compatibilidade: sem dica a string assinada é IDÊNTICA à antiga, então
 * URLs já cacheadas nos clientes (sem `w`) continuam verificando.
 */
function signResolve(infoHash, ep = '', hint = '') {
  const key = secret();
  if (!key) return '';
  const payload = `${infoHash}${ep}${hint ? `&w=${hint}` : ''}`;
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

/** Comparação em tempo constante; sem segredo ativo a rota não é assinável. */
function verifyResolve(infoHash, ep, sig, hint = '') {
  const expected = signResolve(infoHash, ep, hint);
  if (!expected || typeof sig !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signResolve, verifyResolve };
