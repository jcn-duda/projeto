const pending = new Map();
const searches = new Map();
const LOCK_TTL_MS = 60_000;

function markerKey(adapterId, account, infoHash) {
  return `autofetch:v2:${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

/**
 * Trava apenas enquanto a API responde. Persistir antes do aceite criava seis
 * horas de falso positivo quando o processo reiniciava ou a chamada falhava.
 */
function acquire(key) {
  if (pending.has(key)) return false;
  const token = Symbol(key);
  pending.set(key, token);
  setTimeout(() => {
    if (pending.get(key) === token) pending.delete(key);
  }, LOCK_TTL_MS).unref();
  return true;
}

function release(key) {
  pending.delete(key);
}

/** Um passe parcial e o tardio pertencem à mesma busca e só podem baixar um. */
function acquireSearch(searchKey) {
  if (!searchKey || searches.has(searchKey)) return false;
  const token = Symbol(searchKey);
  searches.set(searchKey, token);
  // O lote tardio pode terminar dezenas de segundos depois. A trava só precisa
  // cobrir a vida da busca; depois libera sozinha para uma nova busca legítima.
  setTimeout(() => {
    if (searches.get(searchKey) === token) searches.delete(searchKey);
  }, LOCK_TTL_MS).unref();
  return true;
}

function releaseSearch(searchKey) {
  searches.delete(searchKey);
}

module.exports = { LOCK_TTL_MS, markerKey, acquire, release, acquireSearch, releaseSearch };
