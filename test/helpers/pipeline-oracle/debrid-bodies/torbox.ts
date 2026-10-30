/**
 * Corpos TS do TorBox (`resolveLink`, `enqueue`, `inventory`, `torrentStatus`
 * e `removeTorrent`), tirados de `src/debrid/torbox.ts`.
 * Produção não roda isto: `current()` embrulha o adaptador na ponte nativa, que
 * sobrepõe o método. Só o oráculo de paridade chama, via `rawAdapter()`.
 *
 * O `checkCached` NÃO saiu de `src/`: o `liveCheck` (/stream-trace.json) usa o
 * GET cru de lote do adaptador de `BY_ID` (ver nota em `premiumize.ts`).
 */
import { magnetForPlay, pickFile, wait } from '../../../../src/debrid/common.js';
import * as log from '../../../../src/utils/logger.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import { call, rowState } from '../../../../src/debrid/torbox.js';
import type { PlayHint, TorrentStatusEntry } from '../../../../types/domain.js';

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  const form = new FormData();
  form.append('magnet', magnetForPlay(infoHash));
  form.append('seed', '3'); // não semear: só queremos o link de leitura
  form.append('allow_zip', 'false');

  const created = await call(apiKey, '/torrents/createtorrent', { method: 'POST', body: form });
  const torrentId = created?.data?.torrent_id ?? created?.data?.id;
  if (torrentId == null) return null;

  let entry: any = null;
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

  const files = (entry.files || []).map((f: any) => ({
    path: f.short_name || f.name,
    size: f.size,
    id: f.id,
  }));
  const file = pickFile(files, { season, episode, work });
  recordFileEvidence(infoHash, files);
  assertDubbedFiles(files, Boolean(dubbed));
  if (!file) return null;

  const dl = await call(apiKey, '/torrents/requestdl', {
    params: { token: apiKey, torrent_id: torrentId, file_id: file.id, redirect: 'false' },
  });
  return typeof dl?.data === 'string' ? dl.data : dl?.data?.url || null;
}
/** Mesmo createtorrent do resolveLink, mas sem esperar ficar pronto. */
export async function enqueue(apiKey: string, infoHash: string) {
  const form = new FormData();
  form.append('magnet', magnetForPlay(infoHash));
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
export async function inventory(apiKey: string) {
  const list = await call(apiKey, '/torrents/mylist');
  const rows = Array.isArray(list?.data) ? list.data : (list?.data ? [list.data] : []);
  const out: any[] = [];
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
 * Status de torrents na conta TorBox para o ciclo de recheck / detecção de mortos.
 */
export async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const list = await call(apiKey, '/torrents/mylist');
  const rows = Array.isArray(list?.data) ? list.data : (list?.data ? [list.data] : []);
  const out: Record<string, TorrentStatusEntry> = {};
  for (const row of rows) {
    const hash = String(row?.hash || '').toLowerCase();
    if (!hash) continue;
    const { state, stalled } = rowState(row);
    out[hash] = { state, stalled, id: row?.id };
  }
  return out;
}

/**
 * Remove torrent pelo id na TorBox.
 */
export async function removeTorrent(apiKey: string, id: string | number) {
  try {
    await call(apiKey, `/torrents/delete/${id}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    log.warn(`[torbox] falha ao remover torrent ${id}:`, err?.message || err);
    return false;
  }
}

export const bodies = { resolveLink, enqueue, inventory, torrentStatus, removeTorrent };
