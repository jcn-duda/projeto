const config = require('../config');
const { magnetFor, json, pickFile, batched, wait } = require('./common');

const API = 'https://api.torbox.app/v1/api';

function call(apiKey, path, { method = 'GET', body, params = {} } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return json(url, { method, headers: { Authorization: `Bearer ${apiKey}` }, body });
}

/** Um dos poucos que ainda expõe checagem de cache em lote. */
async function checkCached(apiKey, infoHashes) {
  return batched(infoHashes, config.debrid.batchSize, async (batch) => {
    const url = new URL(`${API}/torrents/checkcached`);
    batch.forEach((hash) => url.searchParams.append('hash', hash));
    url.searchParams.set('format', 'list');
    url.searchParams.set('list_files', 'false');

    const res = await json(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    // `data` vem como lista de objetos com hash, ou como mapa hash → info.
    const data = res?.data;
    const hashes = Array.isArray(data)
      ? data.map((item) => item?.hash).filter(Boolean)
      : Object.keys(data || {});
    return hashes.map((hash) => String(hash).toLowerCase());
  });
}

async function resolveLink(apiKey, infoHash, { season, episode } = {}) {
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
    console.warn('[torbox] torrent não está pronto para leitura');
    return null;
  }

  const files = (entry.files || []).map((f) => ({
    path: f.short_name || f.name,
    size: f.size,
    id: f.id,
  }));
  const file = pickFile(files, { season, episode });
  if (!file) return null;

  const dl = await call(apiKey, '/torrents/requestdl', {
    params: { token: apiKey, torrent_id: torrentId, file_id: file.id, redirect: 'false' },
  });
  return typeof dl?.data === 'string' ? dl.data : dl?.data?.url || null;
}

module.exports = {
  id: 'torbox',
  label: 'TorBox',
  cacheCheck: true,
  keyUrl: 'https://torbox.app/settings',
  checkCached,
  resolveLink,
};
