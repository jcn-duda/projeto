'use strict';

function createCache(limit) {
  const values = new Map();
  const inFlight = new Map();
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
