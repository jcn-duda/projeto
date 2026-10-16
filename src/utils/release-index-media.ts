import { magnetDisplayName } from './title-normalization.js';
import { readEngine } from './magnet-bank.js';
import type { MagnetRow } from './magnet-bank.js';

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
