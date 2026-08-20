import config from '../config.js';
import {
  magnetFor, json, pickFile, batched,
  AuthError, QuotaError, RateLimitError,
} from './common.js';

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
async function call(apiKey: string, path: string, { method = 'GET', params = {}, body, timeout }: { method?: string; params?: Record<string, any>; body?: any; timeout?: number } = {}) {
  const url = new URL(`${API}${path}`);
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
async function checkCached(apiKey: string, infoHashes: string[], { timeoutMs }: { timeoutMs?: number } = {}) {
  // A API aceita lote; mantemos blocos pra não montar URLs gigantes.
  return batched(infoHashes, config.debrid.batchSize, async (batch, ctx) => {
    const data = await call(apiKey, '/cache/check', {
      params: { 'items[]': batch },
      timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout,
    });
    const flags = data.response || [];
    return batch.filter((_, idx) => flags[idx]);
  }, { timeoutMs });
}

/**
 * Resolve o link direto de reprodução — só na hora do play, porque o
 * directdl é caro demais pra rodar em cima da lista inteira de torrents.
 *
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work }: { season?: number | null; episode?: number | null; work?: any } = {}) {
  const body = new URLSearchParams({ src: magnetFor(infoHash) });
  const data = await call(apiKey, '/transfer/directdl', { method: 'POST', body });
  const file = pickFile(data.content || [], { season, episode, work });
  return file ? file.stream_link || file.link : null;
}

/**
 * Cria a transferência e sai. O directdl do resolveLink também baixaria, mas
 * ele espera o arquivo ficar pronto — aqui só queremos disparar.
 */
async function enqueue(apiKey: string, infoHash: string) {
  const body = new URLSearchParams({ src: magnetFor(infoHash) });
  const data = await call(apiKey, '/transfer/create', { method: 'POST', body });
  return Boolean(data?.id);
}

/**
 * Fair-use da conta (`limit_used` em [0, 1]). É o sinal que falta: magnets
 * AllDebrid não se aplicam aqui — o teto do Premiumize é tráfego, e até
 * estourar (`account_limit_reached`) não havia aviso nenhum.
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
// via upload). Sem isto o orquestrador trata todos como "não sei".
export const cacheCheck = true;
export const keyUrl = 'https://www.premiumize.me/account';
export { enqueue, accountStatus, checkCached, resolveLink };
