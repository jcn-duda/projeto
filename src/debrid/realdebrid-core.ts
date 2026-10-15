/**
 * Base compartilhada do adaptador Real-Debrid: plumbing HTTP (auth, request,
 * paginação da listagem), constantes de estado do torrent, limpeza
 * best-effort e a identidade do adaptador (id/label/short/...). A identidade
 * mora aqui para os módulos irmãos a consumirem sem ciclo — `realdebrid.ts`
 * reexporta esses nomes, preservando a superfície pública de antes da divisão.
 */
import { json } from './common.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';

/** Resultado da sonda de disponibilidade (substituto honesto do instantAvailability). */
export type ProbeInstantResult = {
  instant: boolean;
  reason: 'ready' | 'pending' | 'blocked' | 'active' | 'error' | 'memo';
};

export const id = 'realdebrid';
export const label = 'Real-Debrid';
export const short = 'RD';
export const cacheCheck = false;
export const autofetchSource = true;
export const keyUrl = 'https://real-debrid.com/apitoken';

const API = 'https://api.real-debrid.com/rest/1.0';

// O Real-Debrid nao tem /torrents/list: a listagem e GET /torrents, e sem
// ?limit ela devolve so a primeira pagina (100). Com o endpoint errado o
// inventario 404ava, nada era marcado como cacheado e a lista inteira saia
// como [RD Download].
const LIST_LIMIT = 2500;
// Teto defensivo da paginação: a conta real medida tem ~1200 magnets; quatro
// páginas de 2500 cobrem dez vezes isso sem transformar resposta degenerada
// em laço infinito.
const LIST_MAX_ROWS = 10000;

function auth(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 */
type CallOptions = { method?: string; body?: BodyInit | null };

async function request(apiKey: string, path: string, { method = 'GET', body }: CallOptions = {}) {
  return json(`${API}${path}`, {
    method,
    headers: {
      ...auth(apiKey),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
}

export function readCall(apiKey: string, path: string) {
  return request(apiKey, path);
}

export function rawWrite(apiKey: string, path: string, options: CallOptions) {
  return request(apiKey, path, options);
}

/**
 * Listagem completa da conta, paginada. O Real-Debrid devolve só a primeira
 * página sem `?limit` (e `offset` anda em passos de `limit`), então uma conta
 * com mais de 2500 magnets perderia o inventário silenciosamente numa chamada só.
 */
export async function listTorrents(apiKey: string) {
  const rows: any[] = [];
  for (let offset = 0; offset < LIST_MAX_ROWS; offset += LIST_LIMIT) {
    const page = await readCall(apiKey, `/torrents?limit=${LIST_LIMIT}&offset=${offset}`);
    const chunk = Array.isArray(page) ? page : [];
    rows.push(...chunk);
    if (chunk.length < LIST_LIMIT) break;
  }
  return rows;
}

export const READY = 'downloaded';
export const WORKING = ['magnet_conversion', 'queued', 'downloading', 'compressing', 'uploading'];
export const WAITING_SELECTION = 'waiting_files_selection';

export type TorrentInfo = { status?: string; files?: any[]; links?: string[]; filename?: string; bytes?: number | string; id?: string | number };

/**
 * Remove torrent pelo id no Real-Debrid.
 */
export async function rawRemoveTorrent(apiKey: string, id: string | number) {
  await rawWrite(apiKey, `/torrents/delete/${id}`, { method: 'DELETE' });
  return true;
}

/**
 * Limpeza best-effort: NUNCA fala. Ela roda dentro de `finally`/`catch`, onde
 * uma exceção substituiria o valor de retorno ou o erro original — um DELETE
 * que falha chegava a transformar sonda com `downloaded` em miss gravado no
 * ledger durável, e NoVideoError em erro genérico.
 */
export async function cleanupTorrent(apiKey: string, id: string | number) {
  try {
    await rawRemoveTorrent(apiKey, id);
  } catch (err) {
    metrics.count('debrid.rd.cleanupFailed');
    log.warn(`[realdebrid] limpeza do torrent ${id} falhou:`, (err as Error)?.message || err);
  }
}

export function looksAlreadyActive(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /torrent already active|error_code["']?\s*:\s*33|\b33\b.*already/i.test(msg);
}
