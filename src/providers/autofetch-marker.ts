// Marker do autofetch: a chave e o VALOR gravados quando um enqueue é aceito.
//
// Extraído de autofetch.ts ao estourar a catraca de 400 linhas. Fica junto
// porque chave e valor têm que mudar em par: quem grava um formato novo e
// quem o lê são o mesmo contrato, e separá-los foi o que já deixou o marker
// significar coisas diferentes em pontos diferentes do ciclo.
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';

function markerKey(adapterId: string, account: string, infoHash: string) {
  return `${prefix('autofetch')}m:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

/**
 * Valor gravado no marker. Historicamente `1`: só a presença importava. Quando
 * o adapter devolve o ID da transferência no aceite, guarda-o — é a âncora
 * para reencontrá-la depois em serviço que não publica o hash na listagem (o
 * Premiumize é o caso medido). Os leitores testam TRUTHINESS, nunca `=== 1`,
 * então o objeto convive com os `1` já gravados: marker antigo apenas não tem
 * id, e o recheck volta a enxergá-lo no próximo enqueue.
 */
function markerValue(accepted: boolean | string) {
  return typeof accepted === 'string' && accepted ? { id: accepted } : 1;
}

/** ID da transferência guardado no marker, quando o adapter devolveu um. */
function markerTransferId(adapterId: string, account: string, infoHash: string): string | null {
  const value = cache.get(markerKey(adapterId, account, infoHash)) as { id?: unknown } | null;
  if (!value || typeof value !== 'object') return null;
  return value.id == null || value.id === '' ? null : String(value.id);
}

export { markerKey, markerValue, markerTransferId };
