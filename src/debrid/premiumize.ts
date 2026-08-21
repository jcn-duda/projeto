import config from '../config.js';
import * as metrics from '../utils/metrics.js';
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
 * Resolve o link direto de reprodução — só na hora do play, porque o directdl
 * é caro demais pra rodar em cima da lista inteira de torrents.
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

/**
 * Identifica o infoHash de uma transferência do Premiumize em cascata, na
 * ordem em que cada campo tem confiabilidade decrescente:
 *
 *   1. `src` → magnet do torrent, quando chega completo (`btih:40hex`);
 *   2. `name` → hash v1 cru de 40 hex no nome; o Premiumize às vezes converte
 *      o próprio filename no hash (sem um nome legível que o vista);
 *   3. `hash`/`info_hash` → campo direto quando a transferência o publica.
 *
 * Quem não casa com nenhum dos três não pode ser indexado no lote do recheck:
 * volta null e o chamador o conta em `debrid.pm.status.unmatched`, em vez de
 * inventar um hash com o qual limpar a conta por engano.
 */
function transferHash(t: any): string | null {
  const fromSrc = String(t?.src || '').match(/btih:([a-f0-9]{40})/i);
  if (fromSrc) return fromSrc[1].toLowerCase();
  const fromName = String(t?.name || '').match(/(?:^|[\s._-])([a-f0-9]{40})(?:[\s._-]|$)/i);
  if (fromName) return fromName[1].toLowerCase();
  const direct = String(t?.hash || t?.info_hash || '');
  if (/^[a-f0-9]{40}$/i.test(direct)) return direct.toLowerCase();
  return null;
}

// Mensagem que denuncia uma parada real (sem avanço): sem pares de onde ler
// nem progresso para mostrar. O Premiumize reporta "0 Bytes of 0 Bytes" com
// capitalização variável; o par costuma aparecer como "0 peers"/"0 peer(s)".
const STALLED_TRANSFER = /0 bytes of 0 bytes|from 0 peer/i;

/**
 * Status das transferências do Premiumize para detecção de prontos, mortos e
 * parados. Uma transferência `running` com progresso ausente ou 0 e mensagem
 * atascada ("0 Bytes of 0 Bytes" ou "from 0 peer") não avança: se marca
 * `stalled:true` para que o recheck a conte com o próprio limite, em vez de
 * derrubá-la pela mesma via que um dead de 2 rechecks.
 */
async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const data = await call(apiKey, '/transfer/list');
  const transfers = Array.isArray(data?.transfers) ? data.transfers : [];
  const out: Record<string, { state: 'ready' | 'downloading' | 'dead' | 'unknown'; stalled?: boolean; id?: any }> = {};
  for (const t of transfers) {
    const hash = transferHash(t);
    if (!hash) {
      // Não dá pra mapeá-la ao lote do recheck: não serve para saber se ficou
      // pronto nem para limpar. Contá-la torna visível que a conta arrasta
      // transferências órfãs que o ciclo nunca vai alcançar.
      metrics.count('debrid.pm.status.unmatched');
      continue;
    }
    const status = String(t?.status || '').toLowerCase();
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    let stalled = false;
    if (status === 'finished' || status === 'seeding') {
      state = 'ready';
    } else if (status === 'queued') {
      state = 'downloading';
    } else if (status === 'running') {
      state = 'downloading';
      const progress = Number(t?.progress);
      const moving = Number.isFinite(progress) && progress !== 0;
      const message = String(t?.message || '');
      if (!moving && STALLED_TRANSFER.test(message)) {
        stalled = true;
      }
    } else if (status === 'error') {
      state = 'dead';
    }
    out[hash] = { state, stalled, id: t?.id };
  }
  return out;
}

/**
 * Remove transferência pelo id no Premiumize.
 */
async function removeTorrent(apiKey: string, id: any) {
  try {
    const body = new URLSearchParams({ id: String(id) });
    await call(apiKey, '/transfer/delete', { method: 'POST', body });
    return true;
  } catch (err) {
    return false;
  }
}

export const id = 'premiumize';
export const label = 'Premiumize';
export const short = 'PM';
// Lote instantâneo que não escreve na conta (TorBox também; AllDebrid mede
// via upload). Sem isso o orquestrador trata todos como "não sei".
export const cacheCheck = true;
export const keyUrl = 'https://www.premiumize.me/account';
export { enqueue, accountStatus, checkCached, resolveLink, torrentStatus, removeTorrent };