const { magnetFor, json, pickFile, wait } = require('./common');
const log = require('../utils/logger');

const API = 'https://debrid-link.com/api/v2';

async function call(apiKey, path, { method = 'GET', body, params = {} } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const data = await json(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  if (data.success === false) {
    throw new Error(data.error || 'debrid-link retornou erro');
  }
  return data.value;
}

/**
 * A Debrid-Link não publica endpoint de disponibilidade em lote; tratamos como
 * "não sei" e deixamos o orquestrador decidir.
 */
async function checkCached() {
  return new Set();
}

async function resolveLink(apiKey, infoHash, { season, episode } = {}) {
  const added = await call(apiKey, '/seedbox/add', {
    method: 'POST',
    body: new URLSearchParams({ url: magnetFor(infoHash), async: 'true' }),
  });
  if (!added?.id) return null;

  let entry = added;
  for (let attempt = 0; attempt < 4 && Number(entry?.downloadPercent) < 100; attempt += 1) {
    await wait(700);
    const list = await call(apiKey, '/seedbox/list', { params: { ids: added.id } });
    entry = Array.isArray(list) ? list[0] : list;
  }
  if (Number(entry?.downloadPercent) < 100) {
    log.warn('[debridlink] torrent ainda não está pronto para leitura');
    return null;
  }

  const files = (entry.files || []).map((f) => ({
    path: f.name,
    size: f.size,
    link: f.downloadUrl,
  }));
  const file = pickFile(files, { season, episode });
  return file?.link || null;
}

/** `async: true` devolve na hora e deixa a seedbox baixando. */
async function enqueue(apiKey, infoHash) {
  const added = await call(apiKey, '/seedbox/add', {
    method: 'POST',
    body: new URLSearchParams({ url: magnetFor(infoHash), async: 'true' }),
  });
  return Boolean(added?.id);
}

module.exports = {
  enqueue,
  id: 'debridlink',
  label: 'Debrid-Link',
  short: 'DL',
  cacheCheck: false,
  keyUrl: 'https://debrid-link.com/webapp/apikey',
  checkCached,
  resolveLink,
};
