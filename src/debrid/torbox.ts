import config from '../config.js';
import { json, batched, QuotaError, RateLimitError } from './common.js';
import type { AccountStatus } from '../../types/domain.js';
import { recordFileSizes } from './file-sizes.js';

const API = 'https://api.torbox.app/v1/api';
// O plano Pro documenta o maior teto (10 slots; Free/Essential/Standard têm
// 1/3/5). Sem endpoint de plano neste caminho, usar o máximo evita falso
// bloqueio — a recusa ACTIVE_LIMIT dos planos menores continua observável.
export const ACTIVE_LIMIT = 10;

function envelopeMessage(data: any) {
  const detail = data?.detail;
  const error = data?.error;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '';
}

function unwrapEnvelope(data: any) {
  // TorBox devolve erro de limite com HTTP 200. A checagem de cache também
  // precisa subir esse envelope: lista vazia seria lida como "nada em cache".
  if (data && data.success === false) {
    const code = String(data.error || '');
    const message = envelopeMessage(data) || code || 'torbox retornou erro';
    const full = code && !message.includes(code) ? `${message} (${code})` : message;
    if (/^(ACTIVE_LIMIT|MONTHLY_LIMIT)$/i.test(code)) throw new QuotaError(full);
    if (/^(COOLDOWN_LIMIT)$/i.test(code) || /rate.?limit/i.test(full)) throw new RateLimitError(full);
    throw new Error(full);
  }
  return data;
}

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {Object} [options.params]
 */
export async function call(apiKey: string, path: string, { method = 'GET', body, params = {} }: { method?: string; body?: BodyInit | null; params?: Record<string, string> } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = await json(url, { method, headers: { Authorization: `Bearer ${apiKey}` }, body });
  return unwrapEnvelope(data);
}

/** Um dos poucos que ainda expõe checagem de cache em lote.
 * @param {string} apiKey
 * @param {string[]} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
async function checkCached(
  apiKey: string,
  infoHashes: string[],
  { timeoutMs, fileHashes }: { timeoutMs?: number; fileHashes?: string[] } = {},
) {
  const wantFiles = new Set((fileHashes || []).map((hash) => String(hash).toLowerCase()));
  return batched(infoHashes, config.debrid.batchSize, async (batch, ctx) => {
    const url = new URL(`${API}/torrents/checkcached`);
    batch.forEach((hash) => url.searchParams.append('hash', hash));
    url.searchParams.set('format', 'list');
    // Só pede a lista quando o lote tem pack sem arquivos no memo: a resposta
    // com arquivos é bem maior, e episódio avulso não precisa dela.
    url.searchParams.set('list_files', batch.some((hash) => wantFiles.has(String(hash).toLowerCase())) ? 'true' : 'false');

    const res = unwrapEnvelope(await json(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout,
    }));
    // `data` vem como lista de objetos com hash, ou como mapa hash → info.
    const data = res?.data;
    const entries: any[] = Array.isArray(data)
      ? data
      : Object.entries(data || {}).map(([hash, info]) => ({ ...(info as object || {}), hash }));
    for (const item of entries) {
      const hash = String(item?.hash || '').toLowerCase();
      if (!hash || !wantFiles.has(hash) || !Array.isArray(item?.files)) continue;
      recordFileSizes(hash, item.files.map((f: any) => ({ path: f?.short_name || f?.name, size: f?.size })));
    }
    return entries.map((item) => String(item?.hash || '').toLowerCase()).filter(Boolean);
  }, { timeoutMs });
}

/**
 * Classificação de UMA linha do `/torrents/mylist`. Mora aqui porque o
 * `accountStatus` e o `torrentStatus` precisam da MESMA leitura: enquanto o
 * primeiro somava "tudo que não terminou" como ativo, torrent morto contava
 * como slot ocupado para sempre — e o gate de ocupação, que lê `active`,
 * travava o Chupim em silêncio. Um vocabulário só, sem chance de divergir.
 */
function rowState(row: any): { state: 'ready' | 'downloading' | 'dead' | 'unknown'; stalled: boolean } {
  if (
    row?.download_state === 'error' ||
    row?.download_state === 'failed' ||
    row?.download_state === 'broken' ||
    /error|failed|broken|dead/i.test(String(row?.download_state || ''))
  ) {
    return { state: 'dead', stalled: false };
  }
  if (row?.download_finished || row?.download_present) return { state: 'ready', stalled: false };
  if (row?.download_state === 'stalled') {
    // Estado nativo da API, não heurística: o TorBox marca explicitamente o
    // torrent que não avança mas ainda não errou. Não é dead (a morte tem
    // estado próprio) nem ready: o recheck o conta com o limiar de parada,
    // não o colapsa como um dead de 2 rechecks. Ocupa slot: conta como ativo.
    return { state: 'downloading', stalled: true };
  }
  if (
    row?.download_state === 'downloading' ||
    row?.download_state === 'queued' ||
    row?.download_state === 'processing' ||
    /downloading|queued|processing|uploading/i.test(String(row?.download_state || ''))
  ) {
    return { state: 'downloading', stalled: false };
  }
  return { state: 'unknown', stalled: false };
}

/**
 * Ocupação visível: quantos torrents a conta tem no mylist. TorBox não publica
 * um teto consultável de magnets (o que dói é ACTIVE_LIMIT / 60 createtorrent
 * por hora); o número ainda serve para ver a conta crescer antes do recusar.
 *
 * `active` exclui do balde APENAS o que já terminou e o que morreu. Antes,
 * "tudo que não terminou" era ativo, e morto segurava vaga para sempre.
 * O `unknown` (linha sem `download_state`) conta como ativo de propósito: aqui
 * a pergunta é "ocupa slot?", e sem prova de morte a resposta honesta é sim —
 * assimetria deliberada com o `torrentStatus`, onde `unknown` significa "não
 * julgue" porque lá a decisão é apagar torrent. Morto/erro segue no `magnets`
 * (o total é o total), só não segura vaga.
 */
async function accountStatus(apiKey: string) {
  const list = await call(apiKey, '/torrents/mylist');
  const rows = Array.isArray(list?.data) ? list.data : (list?.data ? [list.data] : []);
  let ready = 0;
  let active = 0;
  for (const row of rows) {
    const { state } = rowState(row);
    if (state === 'ready') ready += 1;
    else if (state !== 'dead') active += 1;
  }
  return { magnets: rows.length, ready, active };
}

/** TorBox é limitado por downloads ATIVOS, não pelo tamanho total do mylist. */
function occupancy(status: AccountStatus) {
  const active = Number(status?.active);
  return Number.isFinite(active) ? { used: active, max: ACTIVE_LIMIT } : null;
}

export const id = 'torbox';
export const label = 'TorBox';
export const short = 'TB';
export const cacheCheck = true;
export const enqueueHourlyLimit = 50;
export const keyUrl = 'https://torbox.app/settings';
export { accountStatus, occupancy, checkCached, rowState };

