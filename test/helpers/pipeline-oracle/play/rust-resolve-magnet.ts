import { assertSafeTestDb } from '../../db-guard.js';
import * as magnetdbWrites from './magnetdb-writes.js';
import { accountScope } from '../../../../src/utils/request-key.js';
import * as protectedApi from '../../../../src/debrid/protected.js';

// Grava davail/posse no MESMO cache.db: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/play/rust-resolve-magnet');

/**
 * O Rust devolve o efeito já classificado. Aqui só a escrita que o Node já
 * lê no L1/L2: TTL, hash recusado e kill-switch ficam em markBad/markLie.
 * `null` cobre o play que não é evidência (inclusive 451) — gravar bad ali
 * esconderia um magnet tocável em outro debrid.
 */
export function applyMagnetEffect(
  effect: { mark: 'bad' | 'lie' | null; unprotect?: boolean },
  adapterId: string,
  apiKey: string,
  infoHash: string,
): void {
  if (!adapterId || !apiKey) return;
  if (effect.mark === 'bad') {
    magnetdbWrites.markBad(adapterId, apiKey, infoHash);
    return;
  }
  if (effect.mark === 'lie') {
    magnetdbWrites.markLie(adapterId, apiKey, infoHash);
    // Mesmo caminho do DubLieError em resolve: a promessa de dublado
    // caiu, então a proteção durável dessa conta deixa de valer.
    if (effect.unprotect) {
      protectedApi.unprotect(adapterId, accountScope(apiKey), infoHash);
    }
  }
}
