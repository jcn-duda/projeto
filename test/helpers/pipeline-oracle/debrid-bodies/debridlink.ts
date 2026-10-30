/**
 * Corpos TS do Debrid-Link (`checkCached`, `resolveLink` e o lado de AUTOFETCH:
 * `enqueue`, `inventory`, `torrentStatus`, `removeTorrent`), tirados de
 * `src/debrid/debridlink.ts`. Produção não roda isto: `current()` embrulha o
 * adaptador na ponte nativa, que sobrepõe esses métodos. Só o oráculo de
 * paridade chama, via `rawAdapter()`.
 */
import { magnetForPlay, pickFile, wait } from '../../../../src/debrid/common.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import { call } from '../../../../src/debrid/debridlink.js';
import * as log from '../../../../src/utils/logger.js';
import type { PlayHint, TorrentStatusEntry } from '../../../../types/domain.js';

/**
 * A Debrid-Link não publica endpoint de disponibilidade em lote; tratamos como
 * "não sei" e deixamos o orquestrador decidir.
 */
async function checkCached() {
  return new Set<string>();
}

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  const added = await call(apiKey, '/seedbox/add', {
    method: 'POST',
    body: new URLSearchParams({ url: magnetForPlay(infoHash), async: 'true' }),
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

  const files = (entry.files || []).map((f: any) => ({
    path: f.name,
    size: f.size,
    link: f.downloadUrl,
  }));
  const file = pickFile(files, { season, episode, work });
  recordFileEvidence(infoHash, files);
  assertDubbedFiles(files, Boolean(dubbed));
  return file?.link || null;
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

export const bodies = {
  checkCached, resolveLink, enqueue, inventory, torrentStatus, removeTorrent,
};
