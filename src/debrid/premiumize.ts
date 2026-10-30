import config from '../config.js';
import {
  json, batched,
  AuthError, QuotaError, RateLimitError,
} from './common.js';
import { recordTorrentTotal } from './file-sizes.js';
import { apiBaseFromEnv } from './api-base.js';

const API = 'https://www.premiumize.me/api';

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Object} [options.params]
 * @param {*} [options.body]
 * @param {number} [options.timeout]
 */
export async function call(apiKey: string, path: string, { method = 'GET', params = {}, body, timeout }: { method?: string; params?: Record<string, string | string[]>; body?: BodyInit | null; timeout?: number } = {}) {
  const url = new URL(`${apiBaseFromEnv('PREMIUMIZE_API_BASE', API)}${path}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const data = await json(url, { method, body, timeout });
  // HTTP 200 com status:error — rate_limit e account_limit chegam assim.
  if (data.status && data.status !== 'success') {
    const code = String(data.code || '');
    const message = data.message || code || 'premiumize retornou erro';
    const full = code && !message.includes(code) ? `${message} (${code})` : message;
    if (code === 'authentication_failed' || code === 'permission_denied') {
      throw new AuthError(full);
    }
    if (code === 'account_limit_reached') throw new QuotaError(full);
    if (code === 'rate_limit_reached') throw new RateLimitError(full);
    throw new Error(full);
  }
  return data;
}

/**
 * Quais desses infoHashes já estão no cache do Premiumize (play instantâneo).
 * Retorna um Set com os hashes disponíveis.
 *
 * @param {string} apiKey
 * @param {string[]} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
async function checkCached(apiKey: string, infoHashes: string[], { timeoutMs }: { timeoutMs?: number; fileHashes?: string[] } = {}) {
  // A lista de arquivos (`fileHashes`) não é mais disparada daqui: quem a agenda
  // é o serviço nativo (`adom-debrid`, `file_list`). O campo fica no TIPO porque
  // o chamador (`cache-check.ts`) o passa neste contrato, e este corpo só roda
  // no 501 do recorte nativo (`rust-remote.ts:307`).
  // A API aceita lote; mantemos blocos pra não montar URLs gigantes.
  return batched(infoHashes, config.debrid.batchSize, async (batch, ctx) => {
    const data = await call(apiKey, '/cache/check', {
      params: { 'items[]': batch },
      timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout,
    });
    const flags = data.response || [];
    // O `filesize` que vem junto é o torrent inteiro (ver `recordTorrentTotal`):
    // é o 💾 de quem o tracker deixou sem tamanho. Só dos cacheados — o do
    // não-cacheado é 0 ou ausente.
    const sizes = Array.isArray(data.filesize) ? data.filesize : [];
    batch.forEach((hash, idx) => { if (flags[idx]) recordTorrentTotal(hash, sizes[idx]); });
    const cached = batch.filter((_, idx) => flags[idx]);
    return cached;
  }, { timeoutMs });
}

/**
 * Fair-use da conta (`limit_used` em [0, 1]). É o sinal que falta: o teto do
 * Premiumize é tráfego, e até estourar (`account_limit_reached`) não havia
 * aviso nenhum.
 */
async function accountStatus(apiKey: string) {
  const data = await call(apiKey, '/account/info');
  const raw = Number(data.limit_used);
  const limitUsed = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null;
  return {
    limitUsed,
    premiumUntil: data.premium_until == null ? null : Number(data.premium_until) || null,
  };
}

export const id = 'premiumize';
export const label = 'Premiumize';
export const short = 'PM';
// Lote instantâneo que não escreve na conta (TorBox também; AllDebrid mede
// via upload). Sem isso o orquestrador trata todos como "não sei".
export const cacheCheck = true;
export const keyUrl = 'https://www.premiumize.me/account';
export { accountStatus, checkCached };
