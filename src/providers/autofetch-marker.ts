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

/**
 * Mapa reverso id da transferência -> infoHash, para o adapter que precisa
 * reencontrar o hash SEM ter o lote do recheck em mãos.
 *
 * O recheck monta essa ponte a partir das hashes do lote (que vivem em
 * memória e somem no restart). A varredura de mortas existe justamente para
 * o que o restart deixou para trás: lá não há lote nenhum, e transferência de
 * nome humano ("[WWW.BLUDV.TV] ... [DUBLADO]") não carrega hash em campo
 * nenhum da listagem. Reconstruir o mapa dos markers devolve a identificação
 * — e com ela a checagem do `held` e a memória de parada por hash.
 *
 * Só enxerga marker presente no L1 (hidratado do disco no boot): o que a cota
 * de hidratação deixou fora continua invisível, como já era antes.
 */
function markerIdIndex(adapterId: string, account: string): Map<string, string> {
  const pre = `${prefix('autofetch')}m:${adapterId}:${account}:`;
  const out = new Map<string, string>();
  for (const key of cache.keysMatching(pre)) {
    const infoHash = key.slice(pre.length);
    if (!/^[a-f0-9]{40}$/.test(infoHash)) continue;
    const value = cache.peek(key) as { id?: unknown } | null;
    if (!value || typeof value !== 'object') continue;
    if (value.id == null || value.id === '') continue;
    out.set(String(value.id), infoHash);
  }
  return out;
}

export { markerKey, markerValue, markerTransferId, markerIdIndex };
