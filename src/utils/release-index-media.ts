import { sourceFromTitle } from './audio-quality.js';
import { magnetDisplayName } from './title-normalization.js';
import * as magnetBank from './magnet-bank.js';
import type { IndexedRelease } from './release-index-types.js';

/**
 * Fonte de mídia (BluRay/WEB-DL/CAM) para o índice. CAM do magnet/dn vence
 * título limpo; bank cobre item só com infoHash quando a URI/título do acervo
 * revela a gravação. Merge com prior: CAM vence; senão novo || prior.
 */
export function mergeMediaSource(
  item: { magnet?: string; MagnetUri?: string; Guid?: string } | null | undefined,
  title: string,
  hash: string,
  prior?: IndexedRelease,
): string | undefined {
  const titleSource = sourceFromTitle(title);
  let magnetDn = magnetDisplayName(item);
  let magnetSource = sourceFromTitle(magnetDn);
  // Item só com infoHash: o bank pode ter a URI/título com CAMRip.
  if (!magnetDn && hash) {
    const row = magnetBank.lookup(hash);
    if (row) {
      magnetDn = magnetDisplayName({ magnet: row.uri }) || '';
      if (!magnetDn && row.title) magnetDn = row.title;
      magnetSource = sourceFromTitle(magnetDn);
    }
  }
  const novo = (magnetSource === 'CAM' && titleSource !== 'CAM')
    ? (magnetSource || titleSource)
    : (titleSource || magnetSource);
  const priorMs = prior?.mediaSource || '';
  const merged = (novo === 'CAM' || priorMs === 'CAM') ? 'CAM' : (novo || priorMs);
  return merged || undefined;
}
