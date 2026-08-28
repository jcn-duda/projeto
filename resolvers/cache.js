'use strict';

// options.inFlight é OPCIONAL (retrocompatível): permite compartilhar UM único
// mapa de coalescing entre várias instâncias de cache. Os perfis que expõem
// post/search/magnetCache precisam de um único `inFlight` — é o shape que
// testes e harnesses consomem (limpam e contam `mod.inFlight` diretamente).
function createCache(limit, options = {}) {
  const values = new Map();
  const inFlight = options.inFlight || new Map();
  async function cached(key, ttl, loader) {
    const hit = values.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    if (hit) values.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);
    const task = Promise.resolve().then(loader).then((value) => {
      values.set(key, { value, expiresAt: Date.now() + ttl });
      if (values.size > limit) values.delete(values.keys().next().value);
      return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }
  return { values, inFlight, cached, clear: () => values.clear() };
}

module.exports = { createCache };
