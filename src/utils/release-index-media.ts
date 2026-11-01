import { magnetDisplayName } from './title-normalization.js';
import { bankRowsForMediaSourceNative } from './magnet-bank-native.js';

type MagnetLike = { magnet?: string; MagnetUri?: string; Guid?: string } | null | undefined;

/**
 * Uma leitura em lote dos hashes que ainda não têm dn= no item — evita N
 * `lookup` no SQLite quando o record grava dezenas de releases de uma vez.
 * A leitura é a ponte read-only (`magnet-bank-native.ts`): quem abre o banco
 * vivo é o núcleo; aqui só resta o filtro dos hashes e o mapa por hash. Banco
 * vazio/desligado devolve Map vazio — o `record` segue sem banco, como antes.
 */
export function bankRowsForMediaSource(
  lote: ReadonlyArray<{ item: MagnetLike; hash: string }>,
): Map<string, { hash: string; uri: string; title: string }> {
  const need: string[] = [];
  for (const { item, hash } of lote) {
    if (hash && !magnetDisplayName(item)) need.push(hash);
  }
  if (need.length === 0) return new Map();
  return new Map(bankRowsForMediaSourceNative(need).map((row) => [row.hash, row]));
}
