/**
 * Handle ÚNICO do cache bruto `raw:v1` no núcleo Rust (`RawStore` do napi,
 * sobre o `RawCacheStore` do `adom-index`, no MESMO `cache.db`). O Node não
 * carrega nem regrava o namespace no L1/L2 (`RUST_OWNED`, `cache-keys.ts`):
 * quem escreve no vivo é o gateway (coletor BLUDV); daqui só saem a leitura
 * quiet do diagnóstico (`trace-recompute`) e o clear do clear-cache — o mesmo
 * desenho do `IdxStore` (`release-index-store.ts`).
 */
import config from '../config.js';
import { requireCore } from './rust-core.js';

export type RawStoreNapi = {
  /** Envelope cru da linha viva em JSON texto; `null` = miss/expirada. */
  peekJson(key: string, nowMs: number): string | null;
  setJson(key: string, valueJson: string, ttlSeconds: number, nowMs: number): void;
  clear(): number;
  len(): number;
};

let handle: RawStoreNapi | null = null;

/** Handle único do processo; cria na primeira chamada. */
export function rawStore(): RawStoreNapi {
  if (handle) return handle;
  const core = requireCore();
  if (!core.RawStore) throw new Error('[raw] núcleo sem RawStore — recarregue o .node (cargo build -p adom-napi)');
  const dbPath = config.cache.persist ? config.cache.dbPath : ':memory:';
  handle = new core.RawStore(dbPath);
  return handle;
}

/** Leitura SEM efeito da linha crua (parsed). Falha de parse ou de chave fora
 * do namespace é dado legado: miss, nunca exceção — o recompute é diagnóstico. */
export function rawPeek(key: string, nowMs = Date.now()): unknown {
  try {
    const raw = rawStore().peekJson(String(key || ''), nowMs);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Grava o envelope cru (`{items}`); só teste semeia por aqui — o caminho vivo
 * de escrita é o coletor BLUDV dentro do gateway. */
export function rawSetForTest(key: string, value: unknown, ttlSeconds: number): void {
  rawStore().setJson(String(key), JSON.stringify(value), ttlSeconds, Date.now());
}

/** Limpa o namespace `raw` no Rust (as linhas ficam no disco mesmo sem handle aberto). */
export function clearRawStore(): number {
  return rawStore().clear();
}

/** Só para testes: descarta o handle (o próximo `rawStore()` abre outro). */
export function resetRawStoreForTest(): void {
  handle = null;
}
