import crypto from 'node:crypto';
import { prefix } from './cache-keys.js';

/**
 * Identifica uma conta sem colocar a credencial no cache, nos logs ou em
 * estruturas inspecionáveis. A API key continua sendo o segredo que viaja no
 * install URL; aqui precisamos apenas impedir que duas contas dividam estado.
 */
function accountScope(apiKey: string | null | undefined) {
  if (!apiKey) return 'none';
  return crypto.createHash('sha256').update(String(apiKey), 'utf8').digest('hex');
}

function streamsCacheKey(type: string, id: string, options: { debridApiKey?: string | null; [key: string]: unknown } = {}) {
  const { debridApiKey, ...shape } = options;
  // Matching e plano de queries fazem parte do conteúdo cacheado. O namespace
  // evita que um deploy continue servindo por 15 minutos listas antigas com
  // spin-offs já rejeitados pela versão nova do pipeline.
  return `${prefix('streams')}${type}:${id}:${JSON.stringify(shape)}:account:${accountScope(debridApiKey)}`;
}

export { accountScope, streamsCacheKey };
