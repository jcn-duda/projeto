import { sourceFromTitle } from './audio-quality.js';
import { magnetDisplayName } from './title-normalization.js';
import { readEngine } from './magnet-bank.js';
import type { MagnetRow } from './magnet-bank.js';
import type { IndexedRelease } from './release-index-types.js';

type MagnetLike = { magnet?: string; MagnetUri?: string; Guid?: string } | null | undefined;

/**
 * Uma leitura em lote dos hashes que ainda não têm dn= no item — evita N
 * `lookup` no SQLite quando o record grava dezenas de releases de uma vez.
 */
export function bankRowsForMediaSource(
  lote: ReadonlyArray<{ item: MagnetLike; hash: string }>,
): Map<string, MagnetRow> {
  const need: string[] = [];
  for (const { item, hash } of lote) {
    if (hash && !magnetDisplayName(item)) need.push(hash);
  }
  const e = readEngine();
  if (!e || need.length === 0) return new Map();
  return new Map(e.listMagnetsMany(need).map((m) => [m.hash, m]));
}

/**
 * Fonte de mídia (BluRay/WEB-DL/CAM) para o índice. CAM do magnet/dn vence
 * título limpo; bank cobre item só com infoHash quando a URI/título do acervo
 * revela a gravação. Merge com prior: CAM vence; senão novo || prior.
 * Ausente = desconhecido (entrada legada sem o campo até a próxima gravação).
 */
export function mergeMediaSource(
  item: MagnetLike,
  title: string,
  hash: string,
  prior?: IndexedRelease,
  bankByHash?: Map<string, MagnetRow>,
): string | undefined {
  const titleSource = sourceFromTitle(title);
  let magnetDn = magnetDisplayName(item);
  let magnetSource = sourceFromTitle(magnetDn);
  if (!magnetDn && hash) {
    const row = bankByHash?.get(hash);
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
