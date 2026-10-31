import * as held from './protected.js';
import * as metrics from '../../../src/utils/metrics.js';
import { id } from '../../../src/debrid/alldebrid-api.js';
import { assertSafeTestDb } from '../db-guard.js';

assertSafeTestDb('alldebrid-cleanup');

/**
 * Um magnet está a salvo da limpeza se há proteção VOLÁTIL (hold, autofetch em
 * voo) OU DURÁVEL (`adprot:v1`, acervo BR retido). Quando a proteção durável é
 * a que poupou o item, conta a métrica própria — o volátil é o comportamento
 * antigo e não é acervo retido, então não conta aqui.
 */
export function skipCleanup(account: string, hash: string): boolean {
  if (!held.isCleanupProtected(hash, account, id)) return false;
  if (held.isDurablyProtected(id, account, hash)) metrics.count('debrid.cleanup.protectedBrSkipped');
  return true;
}
