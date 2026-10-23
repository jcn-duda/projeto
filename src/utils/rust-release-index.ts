/**
 * Fonte de mídia (BluRay/WEB-DL/CAM) gravada pelo índice de releases, decidida
 * em Rust (`releaseIndexMediaMerge`): CAM do magnet/dn vence título limpo, o
 * acervo cobre item só com infoHash e o merge com o valor anterior mantém CAM.
 * O Node lê o acervo (SQLite) e manda as linhas planas pelo `IdxStore`
 * (`release-index-store.ts`); o TS da regra saiu do branch (oráculo no `esm`).
 * Aqui ficam só o tipo da superfície napi e o achatamento das linhas.
 */
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

/** Achata o mapa do acervo (já lido pelo Node) em linhas planas para o napi. */
export function bankRowsNapi(bankByHash: Map<string, { hash: string; uri?: string; title?: string }>): BankRowNapi[] {
  return [...bankByHash.values()].map((row) => ({ hash: row.hash, uri: row.uri || '', title: row.title || '' }));
}
