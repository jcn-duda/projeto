const crypto = require('crypto');

/**
 * Identifica uma conta sem colocar a credencial no cache, nos logs ou em
 * estruturas inspecionáveis. A API key continua sendo o segredo que viaja no
 * install URL; aqui precisamos apenas impedir que duas contas dividam estado.
 */
function accountScope(apiKey) {
  if (!apiKey) return 'none';
  return crypto.createHash('sha256').update(String(apiKey), 'utf8').digest('hex');
}

function streamsCacheKey(type, id, options = {}) {
  const { debridApiKey, ...shape } = options;
  return `streams:${type}:${id}:${JSON.stringify(shape)}:account:${accountScope(debridApiKey)}`;
}

module.exports = { accountScope, streamsCacheKey };
