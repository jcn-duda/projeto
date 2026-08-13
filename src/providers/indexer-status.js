const config = require('../config');

const TTL_MS = config.jackett.statusTtl * 1000;
const statuses = new Map();

function normalize(id) {
  return String(id || '').trim().toLowerCase();
}

function stateFor({ ok, ms, budgetMs, results = 0 } = {}) {
  if (!ok) return results > 0 ? 'degraded' : 'offline';
  return Number(ms) > Number(budgetMs) ? 'slow' : 'online';
}

function record(id, sample = {}) {
  const key = normalize(id);
  if (!key) return null;
  const value = {
    state: stateFor(sample),
    ms: Number.isFinite(Number(sample.ms)) ? Math.max(0, Math.trunc(Number(sample.ms))) : null,
    checkedAt: new Date().toISOString(),
  };
  statuses.set(key, value);
  return value;
}

function get(id, now = Date.now()) {
  const value = statuses.get(normalize(id));
  if (!value) return null;
  const checked = Date.parse(value.checkedAt);
  if (!Number.isFinite(checked) || now - checked > TTL_MS) return null;
  return { ...value };
}

function decorate(items = []) {
  return items.map((item) => ({ ...item, status: get(item.id) }));
}

function clear() {
  statuses.clear();
}

module.exports = { TTL_MS, stateFor, record, get, decorate, clear };
