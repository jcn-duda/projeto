/**
 * Handle ÚNICO do índice de releases (`idx:v14`) no núcleo Rust (`IdxStore`,
 * `adom-napi/src/idx_store.rs`, sobre o `adom-index`). O Rust é o dono do
 * namespace: lê e grava o MESMO `cache.db`, e o Node chama de forma síncrona,
 * então uma leitura logo depois de uma escrita já vê o que foi gravado (o
 * `harvest-worker` depende disso).
 *
 * Com `CACHE_PERSIST=false` o handle sobe em memória (`:memory:`), como o
 * resto do cache. O clear do namespace (clear-cache, `cache.clear()`) passa
 * por `clearIdxStore()`, que não cria o handle só para limpar.
 */
import config from '../config.js';
import { requireCore } from './rust-core.js';
import type { BankRowNapi } from './rust-release-index.js';
import type { FileEvidence, IndexedRelease, ObraLocation } from './release-index-types.js';


/** Opções do `record`, na forma que o napi lê. */
export type RecordOpts = { partial?: boolean; keepPartial?: boolean; source?: 'autofetch' };

export type IdxStoreNapi = {
  lookup(imdb: string, season: number | null | undefined, episode: number | null | undefined, nowMs: number): IndexedRelease[];
  isPartial(imdb: string, season: number | null | undefined, episode: number | null | undefined, nowMs: number): boolean;
  isMissing(imdb: string, season: number | null | undefined, episode: number | null | undefined, hash: string, nowMs: number): boolean;
  markMissing(imdb: string, season: number | null | undefined, episode: number | null | undefined, hash: string, nowMs: number): boolean;
  markMissingSeason(imdb: string, season: number, hash: string, nowMs: number): boolean;
  markFileEvidence(hash: string, evidence: FileEvidence, nowMs: number): boolean;
  fileEvidence(hash: string, nowMs: number): FileEvidence | null;
  markLied(imdb: string, season: number | null | undefined, episode: number | null | undefined, hash: string, nowMs: number): number;
  clearPartial(imdb: string, nowMs: number): number;
  forgetAutofetchHash(imdb: string, hash: string, nowMs: number): number;
  snapshotWorks(imdbs: string[], nowMs: number): Record<string, IndexedRelease[]>;
  snapshotAllWorks(nowMs: number): Record<string, IndexedRelease[]>;
  record(
    imdb: string,
    season: number | null | undefined,
    episode: number | null | undefined,
    items: unknown[],
    opts: RecordOpts,
    bank: BankRowNapi[],
    nowMs: number,
  ): number;
  entries(nowMs: number): number;
  hasKey(key: string, nowMs: number): boolean;
  clear(): number;
};

let handle: IdxStoreNapi | null = null;

/** Handle único do processo; cria na primeira chamada. */
export function idxStore(): IdxStoreNapi {
  if (handle) return handle;
  const { IdxStore } = requireCore();
  if (!IdxStore) throw new Error('[idx] núcleo sem IdxStore — recarregue o .node (cargo build -p adom-napi)');
  const dbPath = config.cache.persist ? config.cache.dbPath : ':memory:';
  handle = new IdxStore(dbPath, config.releaseIndex.ttl, config.releaseIndex.maxReleases);
  return handle;
}

/** Limpa o namespace `idx` no Rust (as linhas ficam no disco mesmo sem handle aberto). */
export function clearIdxStore(): number {
  return idxStore().clear();
}

/** Só para testes: descarta o handle (o próximo `idxStore()` abre outro). */
export function resetIdxStoreForTest(): void {
  handle = null;
}
