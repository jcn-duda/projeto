import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';

const TTL_MS = config.jackett.statusTtl * 1000;
// Memória é o L1; o cache em disco só existe pra sobreviver ao restart. O
// status só é medido em busca real, então sem disco a página voltava a abrir
// tudo "desconhecido" a cada subida do container, mesmo com o indexador no ar.
const KEY_PREFIX = 'indexer-status:';
const statuses = new Map();

function normalize(id) {
  return String(id || '').trim().toLowerCase();
}

/**
 * @typedef {{ ok?: boolean, ms?: (number|string|null), budgetMs?: number, results?: number }} StateSample
 */

/**
 * @param {StateSample} [sample]
 */
function stateFor({ ok, ms, budgetMs, results = 0 } = {}) {
  if (!ok) return results > 0 ? 'degraded' : 'offline';
  return Number(ms) > Number(budgetMs) ? 'slow' : 'online';
}

/**
 * @param {*} id
 * @param {StateSample} [sample]
 */
function record(id, sample = {}) {
  const key = normalize(id);
  if (!key) return null;
  const measured = sample.ms == null ? null : Number(sample.ms);
  const state = stateFor(sample);
  // Streak de falhas duras consecutivas — insumo do circuit breaker do
  // jackett. slow/degraded não contam: ainda entregam algo. O get() (e não o
  // Map cru) respeita o TTL: falha de horas atrás não é "consecutiva", e o
  // valor viaja no disco junto com o resto — restart não perde o circuito.
  const previous = get(key);
  const value = {
    state,
    // `null` significa que a falha não trouxe medição. Number(null) seria 0 e
    // faria a UI inventar "offline · 0.0s" em vez de mostrar só offline.
    // `Number.isFinite(null)` já é false no runtime (não converte), então o cast
    // só repete o fato para a assinatura `(number) => boolean` do lib.
    ms: Number.isFinite(/** @type {number} */ (measured)) ? Math.max(0, Math.trunc(/** @type {number} */ (measured))) : null,
    checkedAt: new Date().toISOString(),
    failStreak: state === 'offline' ? (previous?.failStreak || 0) + 1 : 0,
  };
  statuses.set(key, value);
  cache.set(KEY_PREFIX + key, value, config.jackett.statusTtl);
  // Todo caminho de busca e de teste passa por aqui, então é o único lugar que
  // precisa medir. O status guardado é só a ÚLTIMA amostra; as métricas somam a
  // série, que é o que responde "quem está puxando o prazo".
  metrics.count(`indexer.${key}.${value.state}`);
  if (value.ms != null) metrics.observe(`indexer.${key}`, value.ms);
  return value;
}

function get(id, now = Date.now()) {
  const key = normalize(id);
  let value = statuses.get(key);
  // Primeira leitura depois do restart: o disco ainda sabe. O TTL do cache é o
  // mesmo, então o que ele devolve já passou pela validade — a checagem abaixo
  // continua valendo para o `now` explícito que os testes injetam.
  if (!value) {
    value = cache.get(KEY_PREFIX + key);
    if (value) statuses.set(key, value);
  }
  if (!value) return null;
  const checked = Date.parse(value.checkedAt);
  if (!Number.isFinite(checked) || now - checked > TTL_MS) return null;
  return { ...value };
}

function decorate(items = []) {
  return items.map((item) => ({ ...item, status: get(item.id) }));
}

function clear() {
  // Só as chaves de status: o cache é compartilhado com as buscas, e um
  // clear() de teste não pode levar o resto junto.
  for (const key of statuses.keys()) cache.forget(KEY_PREFIX + key);
  statuses.clear();
}

/** Esvazia só o L1, preservando o disco: é como o processo sobe após restart. */
function dropMemory() {
  statuses.clear();
}

export { TTL_MS, stateFor, record, get, decorate, clear, dropMemory };
