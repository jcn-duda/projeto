/**
 * Corpo TS do `resolveLink` do TorBox, tirado de `src/debrid/torbox.ts`.
 * Produção não roda isto: `current()` embrulha o adaptador na ponte nativa, que
 * sobrepõe o método. Só o oráculo de paridade chama, via `rawAdapter()`.
 *
 * O `checkCached` NÃO saiu de `src/`: o `liveCheck` (/stream-trace.json) usa o
 * GET cru de lote do adaptador de `BY_ID` (ver nota em `premiumize.ts`).
 */
import { magnetForPlay, pickFile, wait } from '../../../../src/debrid/common.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import { call } from '../../../../src/debrid/torbox.js';
import * as log from '../../../../src/utils/logger.js';
import type { PlayHint } from '../../../../types/domain.js';

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
export const bodies = { resolveLink };
