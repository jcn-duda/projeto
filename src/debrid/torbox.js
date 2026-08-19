// @ts-check
const config = require('../config');
const { magnetFor, json, pickFile, batched, wait, QuotaError, RateLimitError } = require('./common');
const log = require('../utils/logger');

const API = 'https://api.torbox.app/v1/api';

function envelopeMessage(data) {
  const detail = data?.detail;
  const error = data?.error;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '';
}

function unwrapEnvelope(data) {
  // TorBox devolve erro de limite com HTTP 200. A checagem de cache também
  // precisa subir esse envelope: lista vazia seria lida como "nada em cache".
  if (data && data.success === false) {
    const code = String(data.error || '');
    const message = envelopeMessage(data) || code || 'torbox retornou erro';
    const full = code && !message.includes(code) ? `${message} (${code})` : message;
    if (/^(ACTIVE_LIMIT|MONTHLY_LIMIT)$/i.test(code)) throw new QuotaError(full);
    if (/^(COOLDOWN_LIMIT)$/i.test(code) || /rate.?limit/i.test(full)) throw new RateLimitError(full);
    throw new Error(full);
  }
  return data;
}

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {Object} [options.params]
 */
async function call(apiKey, path, { method = 'GET', body, params = {} } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = await json(url, { method, headers: { Authorization: `Bearer ${apiKey}` }, body });
  return unwrapEnvelope(data);
}

/** Um dos poucos que ainda expõe checagem de cache em lote.
 * @param {string} apiKey
 * @param {string[]} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
async function checkCached(apiKey, infoHashes, { timeoutMs } = {}) {
  return batched(infoHashes, config.debrid.batchSize, async (batch, ctx) => {
    const url = new URL(`${API}/torrents/checkcached`);
    batch.forEach((hash) => url.searchParams.append('hash', hash));
    url.searchParams.set('format', 'list');
    url.searchParams.set('list_files', 'false');

    const res = unwrapEnvelope(await json(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout,
    }));
    // `data` vem como lista de objetos com hash, ou como mapa hash → info.
    const data = res?.data;
    const hashes = Array.isArray(data)
      ? data.map((item) => item?.hash).filter(Boolean)
      : Object.keys(data || {});
    return hashes.map((hash) => String(hash).toLowerCase());
  }, { timeoutMs });
}

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey, infoHash, { season, episode, work } = {}) {
  const form = new FormData();
  form.append('magnet', magnetFor(infoHash));
  form.append('seed', '3'); // não semear: só queremos o link de leitura
  form.append('allow_zip', 'false');

  const created = await call(apiKey, '/torrents/createtorrent', { method: 'POST', body: form });
  const torrentId = created?.data?.torrent_id ?? created?.data?.id;
  if (torrentId == null) return null;

  let entry = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const list = await call(apiKey, '/torrents/mylist', {
      params: { id: torrentId, bypass_cache: 'true' },
    });
    entry = Array.isArray(list?.data) ? list.data[0] : list?.data;
    if (entry && (entry.download_finished || entry.download_present)) break;
    await wait(700);
  }
  if (!entry || !(entry.download_finished || entry.download_present)) {
    log.warn('[torbox] torrent não está pronto para leitura');
    return null;
  }

  const files = (entry.files || []).map((f) => ({
    path: f.short_name || f.name,
    size: f.size,
    id: f.id,
  }));
  const file = pickFile(files, { season, episode, work });
  if (!file) return null;

  const dl = await call(apiKey, '/torrents/requestdl', {
    params: { token: apiKey, torrent_id: torrentId, file_id: file.id, redirect: 'false' },
  });
  return typeof dl?.data === 'string' ? dl.data : dl?.data?.url || null;
}

/** Mesmo createtorrent do resolveLink, mas sem esperar ficar pronto. */
async function enqueue(apiKey, infoHash) {
  const form = new FormData();
  form.append('magnet', magnetFor(infoHash));
  form.append('seed', '3'); // não semear
  form.append('allow_zip', 'false');
  const created = await call(apiKey, '/torrents/createtorrent', { method: 'POST', body: form });
  return (created?.data?.torrent_id ?? created?.data?.id) != null;
}

/**
 * Inventário PRONTO da conta (`{ title, infoHash, size }`): base da
 * conta-como-fonte. É o `/torrents/mylist` SEM `id` — a mesma chamada que o
 * resolveLink faz para UM torrent, agora para a lista inteira. O par
 * download_finished/download_present é o que o resolveLink já considera
 * "pronto para leitura".
 */
async function inventory(apiKey) {
  const list = await call(apiKey, '/torrents/mylist');
  const rows = Array.isArray(list?.data) ? list.data : (list?.data ? [list.data] : []);
  const out = [];
  for (const row of rows) {
    if (!(row?.download_finished || row?.download_present)) continue;
    const infoHash = String(row.hash || '').toLowerCase();
    const title = String(row.name || '').trim();
    if (!infoHash || !title) continue;
    if (title.toLowerCase() === infoHash) continue;
    out.push({ title, infoHash, size: Number(row.size) || 0 });
  }
  return out;
}

/**
 * Ocupação visível: quantos torrents a conta tem no mylist. TorBox não publica
 * um teto consultável de magnets (o que dói é ACTIVE_LIMIT / 60 createtorrent
 * por hora); o número ainda serve para ver a conta crescer antes do recusar.
 */
async function accountStatus(apiKey) {
  const list = await call(apiKey, '/torrents/mylist');
  const rows = Array.isArray(list?.data) ? list.data : (list?.data ? [list.data] : []);
  let ready = 0;
  let active = 0;
  for (const row of rows) {
    if (row?.download_finished || row?.download_present) ready += 1;
    else active += 1;
  }
  return { magnets: rows.length, ready, active };
}

module.exports = {
  enqueue,
  inventory,
  accountStatus,
  id: 'torbox',
  label: 'TorBox',
  short: 'TB',
  cacheCheck: true,
  keyUrl: 'https://torbox.app/settings',
  checkCached,
  resolveLink,
};
