import { prefix } from '../utils/cache-keys.js';

const pending = new Map();
const searchSlots = new Map();
const LOCK_TTL_MS = 60_000;

function markerKey(adapterId: string, account: string, infoHash: string) {
  return `${prefix('autofetch')}${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

/**
 * Trava apenas enquanto a API responde. Persistir antes do aceite criava seis
 * horas de falso positivo quando o processo reiniciava ou a chamada falhava.
 */
function acquire(key: string) {
  if (pending.has(key)) return false;
  const token = Symbol(key);
  pending.set(key, token);
  setTimeout(() => {
    if (pending.get(key) === token) pending.delete(key);
  }, LOCK_TTL_MS).unref();
  return true;
}

function release(key: string) {
  pending.delete(key);
}

/**
 * Contador de vagas por busca, compartilhado entre o passe parcial e o tardio
 * (os dois usam o mesmo searchKey). Substitui o boolean antigo: permitia só um
 * torrent por busca, qualquer que fosse; agora cabem até `max` candidatos.
 *
 * A TTL limpa a entrada inteira quando a busca morre (o lote tardio pode
 * terminar dezenas de segundos depois); cada `releaseSearchSlot` em refusa/erro
 * devolve a vaga sem vazar o contador.
 */
function acquireSearchSlot(searchKey: string, max = 1) {
  if (!searchKey) return false;
  const limit = Math.max(1, Math.trunc(Number(max) || 1));
  const entry = searchSlots.get(searchKey);
  if (entry) {
    if (entry.used >= limit) return false;
    entry.used += 1;
    return true;
  }
  const token = Symbol(searchKey);
  searchSlots.set(searchKey, { used: 1, token });
  setTimeout(() => {
    if (searchSlots.get(searchKey)?.token === token) searchSlots.delete(searchKey);
  }, LOCK_TTL_MS).unref();
  return true;
}

function releaseSearchSlot(searchKey: string) {
  const entry = searchSlots.get(searchKey);
  if (!entry) return;
  entry.used -= 1;
  if (entry.used <= 0) searchSlots.delete(searchKey);
}

/** Compatibilidade com o contrato antigo: uma vaga só por busca. */
function acquireSearch(searchKey: string) {
  return acquireSearchSlot(searchKey, 1);
}

function releaseSearch(searchKey: string) {
  releaseSearchSlot(searchKey);
}

export {
  LOCK_TTL_MS,
  markerKey,
  acquire,
  release,
  acquireSearch,
  releaseSearch,
  acquireSearchSlot,
  releaseSearchSlot,
};
