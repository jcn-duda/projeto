// Chaves folha do autofetch: sem imports do registry/debrid, para consumidores
// de baixo nível não criarem o ciclo de inicialização de `debrid/index`.
import { prefix } from '../utils/cache-keys.js';

/**
 * Chave da blacklist de mortos (`autofetch:v3:dead:<adapter>:<conta>:<hash>`): o
 * MESMO formato do `dead_key` do núcleo (`adom-autofetch::v3`). Quem grava e lê
 * é o KV nativo (`autofetchV3MarkDead`/`autofetchV3IsDead`); aqui só se monta a
 * string — o purgador de represados precisa dela para esquecer a marca.
 */
export function deadKey(adapterId: string, account: string, infoHash: string): string {
  return `${prefix('autofetch')}dead:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}
