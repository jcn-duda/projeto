/**
 * Ponte de LEITURA do KV nativo (`NativeKv` do napi, sobre a tabela `cache` do
 * `data/cache.db`). É o mesmo desenho do `raw-store-native.ts`: o Node não
 * mantém L1 nem regrava no SQLite os namespaces que o Rust passou a possuir
 * (fila/estado do Chupim, posse/proteção do AllDebrid) — ele só espia por aqui.
 */
import config from '../config.js';
import { requireCore } from './rust-core.js';

export type NativeKvNapi = {
  /** JSON cru da chave viva; `null` = ausente ou expirada. */
  getJson(key: string, nowMs: number): string | null;
  /** Chaves vivas com o prefixo (as vencidas são podadas na varredura). */
  keys(prefix: string, nowMs: number): string[];
  /** Grava JSON; `ttlSeconds <= 0` é permanente (testes e fatias seguintes). */
  setJson(key: string, valueJson: string, ttlSeconds: number, nowMs: number): void;
};

let handle: NativeKvNapi | null = null;

/** Handle único do processo; cria na primeira chamada. */
export function nativeKv(): NativeKvNapi {
  if (handle) return handle;
  const core = requireCore();
  if (!core.NativeKv) {
    throw new Error('[kv] núcleo sem NativeKv — recarregue o .node (cargo build -p adom-napi)');
  }
  const dbPath = config.cache.persist ? config.cache.dbPath : ':memory:';
  handle = new core.NativeKv(dbPath);
  return handle;
}

/** Leitura quiet de uma chave do estado Rust-owned; miss vira `null`. */
export function kvPeek(key: string, nowMs = Date.now()): unknown {
  try {
    const raw = nativeKv().getJson(String(key || ''), nowMs);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Chaves vivas com o prefixo (diagnóstico e as fatias de fila/posse). */
export function kvKeys(prefix: string, nowMs = Date.now()): string[] {
  try {
    return nativeKv().keys(String(prefix || ''), nowMs);
  } catch {
    return [];
  }
}

/** Só para testes: semeia uma chave sem passar pelo caminho vivo. */
export function kvSetForTest(key: string, value: unknown, ttlSeconds = 0): void {
  nativeKv().setJson(String(key), JSON.stringify(value), ttlSeconds, Date.now());
}

/** Só para testes: descarta o handle (o próximo `nativeKv()` abre outro). */
export function resetNativeKvForTest(): void {
  handle = null;
}
