/**
 * Fonte de mídia (BluRay/WEB-DL/CAM) gravada pelo índice de releases, decidida
 * em Rust (`releaseIndexMediaMerge`): CAM do magnet/dn vence título limpo, o
 * acervo cobre item só com infoHash e o merge com o valor anterior mantém CAM.
 * O Node lê o acervo (SQLite) e manda as linhas planas; o TS da regra saiu do
 * branch (oráculo no `esm`). Uma chamada napi por release, síncrona.
 */
import { requireCore } from './rust-core.js';
import * as metrics from './metrics.js';
import type { IndexedRelease } from './release-index-types.js';

type MagnetLike = { magnet?: string; MagnetUri?: string; Guid?: string } | null | undefined;

/** Linha do acervo já lida pelo Node (`bankByHash` achatada); sem SQLite no Rust. */
export type BankRowNapi = { hash: string; uri: string; title: string };

export type ReleaseIndexCore = {
  releaseIndexMediaMerge(
    magnet: string | null,
    magnetUri: string | null,
    guid: string | null,
    title: string,
    hash: string,
    priorMediaSource: string | null,
    bank: BankRowNapi[],
  ): string | null;
};

/** Fonte de mídia que o `record` grava; ausente = desconhecida. */
export function mediaSourceOf(
  item: MagnetLike,
  title: string,
  hash: string,
  prior: IndexedRelease | undefined,
  bank: BankRowNapi[],
): string | undefined {
  metrics.count('rust.release_index.calls');
  const core = requireCore() as unknown as ReleaseIndexCore;
  return core.releaseIndexMediaMerge(
    String(item?.magnet || '') || null,
    String(item?.MagnetUri || '') || null,
    String(item?.Guid || '') || null,
    title,
    hash,
    prior?.mediaSource || null,
    bank,
  ) ?? undefined;
}

/** Achata o mapa do acervo (já lido pelo Node) em linhas planas para o napi. */
export function bankRowsNapi(bankByHash: Map<string, { hash: string; uri?: string; title?: string }>): BankRowNapi[] {
  return [...bankByHash.values()].map((row) => ({ hash: row.hash, uri: row.uri || '', title: row.title || '' }));
}
