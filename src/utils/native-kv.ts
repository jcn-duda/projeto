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
  /** Grava JSON; `ttlSeconds <= 0` é permanente. */
  setJson(key: string, valueJson: string, ttlSeconds: number, nowMs: number): void;
  /** Remove a chave; `false` = não havia nada. */
  forget(key: string): boolean;
  /** TTL restante em segundos; `null` = ausente, permanente ou vencida. */
  remainingSeconds(key: string, nowMs: number): number | null;
  /** Apaga as chaves VENCIDAS com o prefixo e devolve quantas saíram. */
  pruneExpired(prefix: string, nowMs: number): number;
  /** Apaga o namespace inteiro e devolve quantas linhas saíram. */
  forgetPrefix(prefix: string): number;
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

/**
 * Grava uma chave Rust-owned (`ttlSeconds <= 0` = permanente). `false` = a
 * escrita não aconteceu (núcleo ausente/falha de disco): quem conta métrica
 * de estado durável precisa disto para não mentir no painel.
 */
export function kvSet(key: string, value: unknown, ttlSeconds = 0, nowMs = Date.now()): boolean {
  try {
    nativeKv().setJson(String(key), JSON.stringify(value ?? null), Math.trunc(ttlSeconds), nowMs);
    return true;
  } catch {
    return false;
  }
}

/** Remove uma chave Rust-owned; `false` = não havia nada (idempotente). */
export function kvForget(key: string): boolean {
  try {
    return nativeKv().forget(String(key || ''));
  } catch {
    return false;
  }
}

/** TTL restante em segundos (régua do `cache.peekRemaining`); `null` = sem TTL. */
export function kvRemaining(key: string, nowMs = Date.now()): number | null {
  try {
    return nativeKv().remainingSeconds(String(key || ''), nowMs);
  } catch {
    return null;
  }
}

/** Reset de namespace Rust-owned; devolve quantas linhas saíram. */
export function kvClearPrefix(prefix: string): number {
  try {
    return nativeKv().forgetPrefix(String(prefix || ''));
  } catch {
    return 0;
  }
}

/** Só para testes: semeia uma chave sem passar pelo caminho vivo (falha lança). */
export function kvSetForTest(key: string, value: unknown, ttlSeconds = 0): void {
  nativeKv().setJson(String(key), JSON.stringify(value ?? null), Math.trunc(ttlSeconds), Date.now());
}

/** Só para testes: descarta o handle (o próximo `nativeKv()` abre outro). */
export function resetNativeKvForTest(): void {
  handle = null;
}
