import config from '../config.js';
import { TRACKERS } from '../utils/format.js';
import * as log from '../utils/logger.js';
export {
  WorkPickError, isWorkPickError, EpisodePickError, isEpisodePickError,
  NoVideoError, isNoVideoError, DubLieError, isDubLieError,
  VIDEO_EXT, SAMPLE, EXTRA, isSiteAd, baseName,
  workCoverage, looksMultiWorkFiles, pickWorkFile, pickFile,
} from './file-selector.js';
export type { DebridFile } from './file-selector.js';

/** Erro como ele chega aqui: Error, envelope da API ou nada. */
export type MaybeError = any;

function magnetFor(infoHash: string) {
  const trackers = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash}${trackers}`;
}

/**
 * Conteúdo que o debrid se recusa a servir (HTTP 451 `infringing_file` no
 * Real-Debrid). É permanente por torrent: não adianta tentar de novo, e o
 * usuário merece ouvir isso em vez de um "falha ao resolver" genérico.
 */
class BlockedError extends Error {
  isBlockedError = true;
  constructor(message: string) { super(message); this.name = 'BlockedError'; }
}
function isBlockedError(error: MaybeError) {
  return Boolean(error && error.isBlockedError);
}

/** Credencial recusada pelo serviço. */
class AuthError extends Error {
  isAuthError = true;
  constructor(message: string) { super(message); this.name = 'AuthError'; }
}
const AUTH_MESSAGE = /AUTH_(?:BAD_APIKEY|MISSING_APIKEY|BLOCKED|USER_BANNED)|authentication_failed|apikey is invalid|invalid (?:api )?(?:key|token)|unauthor[iz]|forbidden|bad token/i;
function isAuthError(error: MaybeError) {
  if (!error) return false;
  if (error.isAuthError) return true;
  return AUTH_MESSAGE.test(String(error.message || ''));
}

/** Conta no teto — a credencial está boa, o que acabou foi espaço. */
class QuotaError extends Error {
  isQuotaError = true;
  constructor(message: string) { super(message); this.name = 'QuotaError'; }
}
const QUOTA_MESSAGE = /MAGNET_TOO_MANY_ACTIVE|magnets? limit reached|too many active|quota exceeded|limit reached/i;
function isQuotaError(error: MaybeError) {
  if (!error) return false;
  if (error.isRateLimitError) return false;
  if (error.isQuotaError) return true;
  return QUOTA_MESSAGE.test(String(error.message || ''));
}

/** Rajada demais — a credencial e a cota estão boas, o serviço pediu para esperar. */
class RateLimitError extends Error {
  isRateLimitError = true;
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    if (retryAfterMs != null) this.retryAfterMs = retryAfterMs;
  }
}
const RATE_LIMIT_MESSAGE = /rate_limit_reached|too many (?:api )?requests|slow down/i;
function isRateLimitError(error: MaybeError) {
  if (!error) return false;
  if (error.isRateLimitError) return true;
  return RATE_LIMIT_MESSAGE.test(String(error.message || ''));
}

/** Converte Retry-After em milissegundos (delta-seconds ou data HTTP). */
function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

function retryAfterMsOf(error: MaybeError): number | undefined {
  const value = Number(error?.retryAfterMs);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Um fetch JSON com o timeout do debrid já aplicado. */
async function json(
  url: string | URL,
  { method = 'GET', headers = {}, body, timeout }: { method?: string; headers?: Record<string, string>; body?: BodyInit | null; timeout?: number } = {},
) {
  const res = await fetch(url, {
    method,
    body,
    headers: { Accept: 'application/json', 'User-Agent': 'stremio-adom/1.0', ...headers },
    signal: AbortSignal.timeout(timeout || config.debrid.timeout),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* corpo ilegível: o status já basta */ }
    const message = `HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
    if (res.status === 401 || res.status === 403) throw new AuthError(message);
    if (res.status === 429) {
      // Retry-After não é documentado pelo Real-Debrid, mas alguns proxies o
      // acrescentam. Preservamos a pista no erro; cada adaptador decide como
      // usá-la. Ausência ou valor ilegível continua com a semântica antiga.
      const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
      throw new RateLimitError(message, retryAfterMs);
    }
    if (res.status === 451) throw new BlockedError(message);
    throw new Error(message);
  }
  // 204 sem corpo e resposta legitima: o /torrents/selectFiles do Real-Debrid
  // sempre responde assim. Mandar isso pro res.json() estourava "Unexpected end
  // of JSON input" no meio do resolve, e o play virava 502 mesmo com o arquivo
  // ja 100% pronto na conta.
  if (res.status === 204) return null;
  return res.json();
}

/** Percorre os hashes em lotes, acumulando os que estiverem em cache. */
async function batched(infoHashes: string[], size: number, fn: (batch: string[], ctx?: any) => Promise<any>, { timeoutMs }: { timeoutMs?: number } = {}) {
  const slices: any[][] = [];
  for (let i = 0; i < infoHashes.length; i += size) slices.push(infoHashes.slice(i, i + size));
  const settled = await Promise.allSettled(slices.map((slice) => fn(slice, { timeoutMs })));
  const cached = new Set<string>();
  let failures = 0;
  let authFailures = 0;
  let quotaFailures = 0;
  let rateFailures = 0;
  let lastCause = '';
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      result.value.forEach((hash: string) => cached.add(hash));
    } else {
      failures += 1;
      const message = result.reason?.message || String(result.reason);
      if (isAuthError(result.reason)) { authFailures += 1; lastCause = message; }
      else if (isQuotaError(result.reason)) { quotaFailures += 1; lastCause = message; }
      else if (isRateLimitError(result.reason)) { rateFailures += 1; lastCause = message; }
      log.warn('[debrid] lote de cache falhou:', message);
    }
  }
  if (slices.length > 0 && failures === slices.length) {
    if (authFailures === failures) throw new AuthError(lastCause);
    if (quotaFailures === failures) throw new QuotaError(lastCause);
    if (rateFailures === failures) throw new RateLimitError(lastCause);
    throw new Error('nenhum lote de checagem de cache respondeu');
  }
  return { cached, complete: failures === 0 };
}

/** Espera curta entre polls — o serviço acabou de receber o magnet. */
function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms).unref()); }

export {
  magnetFor, json, batched, wait,
  AuthError, isAuthError, QuotaError, isQuotaError, RateLimitError, isRateLimitError,
  parseRetryAfter, retryAfterMsOf,
  BlockedError, isBlockedError,
};
