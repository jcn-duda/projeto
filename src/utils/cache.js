const store = new Map();
const MAX_ENTRIES = 500;

function prune() {
  const now = Date.now();
  for (const [key, hit] of store) {
    if (hit.expiresAt && now > hit.expiresAt) store.delete(key);
  }
  // Se ainda estourou o teto, descarta as entradas mais antigas (Map preserva ordem de inserção).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt && Date.now() > hit.expiresAt) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function set(key, value, ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return;
  store.delete(key); // reinsere no fim para a ordem refletir o uso mais recente
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
  if (store.size > MAX_ENTRIES) prune();
}

function clear() {
  store.clear();
}

module.exports = { get, set, clear };
