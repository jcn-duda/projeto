const crypto = require('crypto');

function authorized(expected, supplied) {
  if (!expected || !supplied) return false;
  const left = crypto.createHash('sha256').update(String(expected)).digest();
  const right = crypto.createHash('sha256').update(String(supplied)).digest();
  return crypto.timingSafeEqual(left, right);
}

function createDiagnosticGate({ limit = 200, windowMs = 60_000, maxConcurrent = 1, now = Date.now } = {}) {
  const clients = new Map();
  let active = 0;

  function enter(client) {
    const time = now();
    const key = String(client || 'unknown');
    const recent = (clients.get(key) || []).filter((stamp) => time - stamp < windowMs);
    if (recent.length === 0) clients.delete(key);
    if (recent.length >= limit) return { ok: false, status: 429, error: 'limite de testes atingido' };
    if (active >= maxConcurrent) return { ok: false, status: 429, error: 'já existe um teste em andamento' };

    recent.push(time);
    clients.set(key, recent);
    active += 1;
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      },
    };
  }

  return { enter };
}

module.exports = { authorized, createDiagnosticGate };
