/**
 * Corpos TS do Debrid-Link (`checkCached` e `resolveLink`), tirados de
 * `src/debrid/debridlink.ts`. Produção não roda isto: `current()` embrulha o
 * adaptador na ponte nativa, que sobrepõe os dois métodos. Só o oráculo de
 * paridade chama, via `rawAdapter()`.
 */
import { magnetForPlay, pickFile, wait } from '../../../../src/debrid/common.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import { call } from '../../../../src/debrid/debridlink.js';
import * as log from '../../../../src/utils/logger.js';
import type { PlayHint } from '../../../../types/domain.js';

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

export const bodies = { checkCached, resolveLink };
