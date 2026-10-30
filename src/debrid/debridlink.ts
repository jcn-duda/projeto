import { magnetForPlay, json } from './common.js';
import type { TorrentStatusEntry } from '../../types/domain.js';
import { apiBaseFromEnv } from './api-base.js';

const API = 'https://debrid-link.com/api/v2';

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {Object} [options.params]
 */
export async function call(apiKey: string, path: string, { method = 'GET', body, params = {} }: { method?: string; body?: BodyInit | null; params?: Record<string, string> } = {}) {
  const url = new URL(`${apiBaseFromEnv('DEBRIDLINK_API_BASE', API)}${path}`);
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

async function enqueue(apiKey: string, infoHash: string) {
  const added = await call(apiKey, '/seedbox/add', {
    method: 'POST',
    body: new URLSearchParams({ url: magnetForPlay(infoHash), async: 'true' }),
  });
  return Boolean(added?.id);
}

/**
 * Inventário PRONTO da conta Debrid-Link (`{ title, infoHash, size }`).
 */
async function inventory(apiKey: string) {
  const list = await call(apiKey, '/seedbox/list');
  const rows = Array.isArray(list) ? list : [];
  const out: any[] = [];
  for (const row of rows) {
    if (Number(row?.downloadPercent) < 100) continue;
    const infoHash = String(row?.hash || row?.infoHash || '').toLowerCase();
    const title = String(row?.name || '').trim();
    if (!infoHash || !title || title.toLowerCase() === infoHash) continue;
    out.push({ title, infoHash, size: Number(row?.totalSize || row?.size) || 0 });
  }
  return out;
}

/**
 * Status de torrents na conta Debrid-Link para o ciclo de recheck / detecção de mortos.
 */
async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const list = await call(apiKey, '/seedbox/list');
  const rows = Array.isArray(list) ? list : [];
  const out: Record<string, TorrentStatusEntry> = {};
  for (const row of rows) {
    const infoHash = String(row?.hash || row?.infoHash || '').toLowerCase();
    if (!infoHash) continue;
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'downloading';
    if (Number(row?.downloadPercent) >= 100) {
      state = 'ready';
    } else if (row?.status === 'error' || row?.error || /error|failed|dead/i.test(String(row?.status || ''))) {
      state = 'dead';
    }
    out[infoHash] = { state, id: row?.id };
  }
  return out;
}

/**
 * Remove torrent da seedbox na Debrid-Link.
 */
async function removeTorrent(apiKey: string, id: string | number) {
  try {
    await call(apiKey, `/seedbox/${id}/remove`, { method: 'DELETE' });
    return true;
  } catch (err) {
    return false;
  }
}

export const id = 'debridlink';
export const label = 'Debrid-Link';
export const short = 'DL';
export const cacheCheck = false;
export const autofetchSource = true;
export const keyUrl = 'https://debrid-link.com/webapp/apikey';
export { enqueue, inventory, torrentStatus, removeTorrent };

