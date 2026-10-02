// Guarda de posse do `expired-unready` (auditoria adversarial P1.2).
//
// O settle expirado ANTES apagava por id/hash sem provar que o magnet era
// NOSSO. A expiração diz que o download não ficou pronto na janela — não diz
// quem o subiu. Sem prova, o magnet pode ser acervo do usuário que a busca
// tocou; apagá-lo é irreversível para ele.
//
// A remoção direta fica restrita a hash com PROVA de que o addon subiu
// (marker do enqueue OU etiqueta durável `adsub`, que sobrevive ao restart) e
// sem proteção vigente (hold volátil do autofetch ou retenção durável
// `adprot`). Além disso, a AllDebrid exige o snapshot de pré-existentes
// carregado — a MESMA autoridade que `dropReady`/`dropUncached` usam. Snapshot
// ausente (inventário frio, refresh em voo) fecha o fail-safe: NÃO remove.
// Qualquer condição não provada manda o hash para represados
// (`autofetch-suppressed`), não para o delete.
import * as cache from '../utils/cache.js';
import * as held from '../debrid/protected.js';
import { knownBefore, submittedAt } from '../debrid/alldebrid-inventory.js';
import * as autofetch from './autofetch.js';
import type { DebridAdapter } from '../../types/domain.js';

/**
 * `true` só quando é seguro apagar o hash do lote expirado direto. Serviço fora
 * da AllDebrid preserva a remoção histórica (o snapshot de pré-existentes só
 * existe lá); dentro dela, exige posse provada e ausência de proteção.
 */
export function expiredRemovalAllowed(adapter: DebridAdapter, account: string, hash: string, apiKey: string): boolean {
  const h = String(hash || '').toLowerCase();
  if (!h) return false;
  if (held.isCleanupProtected(h, account, adapter.id)) return false;
  if (adapter.id !== 'alldebrid') return true;
  const provaMarker = cache.peek(autofetch.markerKey(adapter.id, account, h)) != null;
  const provaAdsub = submittedAt(account, h) != null;
  if (!provaMarker && !provaAdsub) return false;
  const snapshot = knownBefore(apiKey, account);
  if (!snapshot) return false;
  return !snapshot.has(h);
}
