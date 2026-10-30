/**
 * Fatos do play AllDebrid para o POST /debrid/link em Rust. O Rust apaga o
 * magnet frio quando `dropUncached` está ligado e `held` é false. O hold e a
 * proteção durável moram neste processo; sem o fato o Rust trata o hash como
 * protegido e não apaga. `held: true` significa "não apague".
 */
import { assertSafeTestDb } from '../../db-guard.js';
import config from '../../../../src/config.js';
import { accountScope } from '../../../../src/utils/request-key.js';
import { id } from '../../../../src/debrid/alldebrid-api.js';
import { isCleanupProtected } from '../../../../src/debrid/protected.js';

// Grava davail/posse no MESMO cache.db: sem setup-env o destino seria o banco real.
assertSafeTestDb('pipeline-oracle/play/rust-link-facts');

export function alldebridLinkFacts(apiKey: string, infoHash: string): { held: boolean; dropUncached: boolean } {
  // Chave vazia não identifica conta. Não consultar a proteção e não apagar.
  if (!apiKey) return { held: true, dropUncached: config.debrid.dropUncached };
  // Mesma resposta de skipCleanup, sem a métrica de limpeza: isto é uma
  // consulta do play, não um delete que foi poupado.
  return {
    held: isCleanupProtected(infoHash, accountScope(apiKey), id),
    dropUncached: config.debrid.dropUncached,
  };
}
