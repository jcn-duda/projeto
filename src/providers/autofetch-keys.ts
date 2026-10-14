// Chaves folha do autofetch: sem imports do registry/debrid, para consumidores
// de baixo nível não criarem o ciclo de inicialização de `debrid/index`.
import { prefix } from '../utils/cache-keys.js';

export function deadKey(adapterId: string, account: string, infoHash: string): string {
  return `${prefix('autofetch')}dead:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}
