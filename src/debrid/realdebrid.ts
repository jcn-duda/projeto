/**
 * Adaptador Real-Debrid — montagem e superfície pública.
 *
 * Dividido por fronteiras reais para respeitar o teto de 400 linhas:
 * - `realdebrid-core.ts`: plumbing HTTP compartilhado, constantes de estado
 *   do torrent, limpeza best-effort e identidade do adaptador;
 * - `realdebrid-play.ts`: fluxo de play/autofetch (resolve, poll, enqueue).
 * Este arquivo mantém a checagem via ledger, inventário, status da conta e a
 * sonda, e REEXPORTA os demais nomes — a superfície de exports é a MESMA de
 * antes da divisão (o registry faz spread do namespace e não muda).
 */
import { magnetFor, isBlockedError, isRateLimitError, isQuotaError } from './common.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as memo from './inventory-memo.js';
import type { TorrentStatusEntry } from '../../types/domain.js';
import { accountScope } from '../utils/request-key.js';
import { rdGate } from './rd-gate.js';
import * as rdLedger from './rd-ledger.js';
import {
  id, READY, WORKING, WAITING_SELECTION, readCall, rawWrite, rawRemoveTorrent, listTorrents,
  cleanupTorrent, looksAlreadyActive,
} from './realdebrid-core.js';
import type { TorrentInfo, ProbeInstantResult } from './realdebrid-core.js';
import { selectWaitingFiles } from './realdebrid-play.js';

export { id, label, short, cacheCheck, autofetchSource, keyUrl } from './realdebrid-core.js';
export { resolveLink, enqueue } from './realdebrid-play.js';
export type { ProbeInstantResult } from './realdebrid-core.js';

/**
 * O Real-Debrid aposentou o /torrents/instantAvailability: não há mais como
 * perguntar em lote o que está em cache. Devolvemos vazio e o orquestrador
 * trata todos como "não sei" — ver `cacheCheck` em `realdebrid-core.ts`.
 */
async function checkCached(_apiKey: string, hashes: string[]) {
  // O endpoint oficial aposentou a disponibilidade em lote. Quando o oráculo
  // está ativo, ele já gravou no ledger antes desta chamada; só afirmamos
  // complete se TODO hash possui evidência (hit/miss/blocked), nunca por falta.
  const cached = new Set<string>();
  let known = true;
  for (const raw of hashes) {
    const hash = String(raw || '').toLowerCase();
    const state = rdLedger.peek(hash);
    if (state === 'hit') cached.add(hash);
    else if (state === 'unknown') known = false;
  }
  return { cached, complete: known };
}

/**
 * Inventário PRONTO da conta Real-Debrid (`{ title, infoHash, size }`).
 */
async function inventory(apiKey: string) {
  const rows = await listTorrents(apiKey);
  const out: any[] = [];
  const readyHashes: string[] = [];
  for (const t of rows) {
    if (t?.status !== READY) continue;
    const infoHash = String(t.hash || '').toLowerCase();
    const title = String(t.filename || '').trim();
    if (!infoHash || !title || title.toLowerCase() === infoHash) continue;
    readyHashes.push(infoHash);
    // O id viaja junto: com ele o play resolve pelo memo sem re-listar a conta.
    out.push({ title, infoHash, size: Number(t.bytes) || 0, ...(t.id != null ? { id: String(t.id) } : {}) });
  }
  rdLedger.noteHit(readyHashes);
  return out;
}

/**
 * Status de torrents na conta Real-Debrid para o ciclo de recheck / detecção de mortos.
 */
async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const rows = await listTorrents(apiKey);
  const out: Record<string, TorrentStatusEntry> = {};
  const readyHashes: string[] = [];
  for (const t of rows) {
    const hash = String(t.hash || '').toLowerCase();
    if (!hash) continue;
    const status = String(t.status || '').toLowerCase();
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    if (status === READY) {
      state = 'ready';
      readyHashes.push(hash);
    } else if (/^(magnet_error|error|virus|dead)$/i.test(status)) {
      state = 'dead';
    } else if (WORKING.includes(status) || status === 'waiting_files_selection') {
      state = 'downloading';
    }
    out[hash] = { state, id: t.id };
  }
  rdLedger.noteHit(readyHashes);
  return out;
}

async function removeTorrentWithPriority(apiKey: string, id: string | number, priority: 'cleanup') {
  return rdGate.run(accountScope(apiKey), priority, () => rawRemoveTorrent(apiKey, id));
}

async function removeTorrent(apiKey: string, id: string | number) {
  try {
    return await removeTorrentWithPriority(apiKey, id, 'cleanup');
  } catch {
    return false;
  }
}

/**
 * Saúde da conta para o `/debrid-status.json`: ocupação (o aviso por contagem
 * vem do `DEBRID_ACCOUNT_WARN_TOTAL`, como na AllDebrid) e validade do
 * premium. O RD não publica teto consultável — o limiar é nosso.
 */
async function accountStatus(apiKey: string) {
  const [user, rows] = await Promise.all([readCall(apiKey, '/user'), listTorrents(apiKey)]);
  let ready = 0;
  let active = 0;
  let error = 0;
  for (const t of rows) {
    const status = String(t?.status || '').toLowerCase();
    if (status === READY) ready += 1;
    else if (/^(magnet_error|error|virus|dead)$/.test(status)) error += 1;
    else active += 1;
  }
  const expiration = user?.expiration ? new Date(String(user.expiration)).getTime() : NaN;
  return {
    magnets: rows.length,
    ready,
    active,
    error,
    premiumUntil: Number.isFinite(expiration) ? expiration : null,
  };
}

/**
 * Torrents ativos agora (`GET /torrents/activeCount`). Doc oficial: erro 21
 * quando o teto estoura. Usado pela sonda antes de addMagnet — se já estamos
 * no limite, a rodada inteira pula em vez de gerar 21 em série.
 */
async function activeTorrentCount(apiKey: string): Promise<{ nb: number; limit: number } | null> {
  try {
    const data = await readCall(apiKey, '/torrents/activeCount');
    const nb = Number(data?.nb);
    const limit = Number(data?.limit);
    if (!Number.isFinite(nb) || !Number.isFinite(limit)) return null;
    return { nb, limit };
  } catch (err) {
    log.warn('[realdebrid] activeCount falhou:', (err as Error)?.message || err);
    return null;
  }
}

/**
 * Sonda se um hash toca NA HORA no CDN do Real-Debrid — o substituto honesto
 * do `/torrents/instantAvailability` (aposentado, erro 37).
 *
 * Fluxo: addMagnet → poll curto (com selectFiles se precisar) → se
 * `downloaded`, é instant; caso contrário, não. Em TODOS os caminhos que
 * criaram o torrent, ele é apagado: a evidência fica no magnetdb/davail, não
 * ocupando vaga na conta. Inventário do usuário (memo quente) short-circuita.
 */
async function probeInstantUngated(apiKey: string, infoHash: string): Promise<ProbeInstantResult> {
  const hash = String(infoHash || '').toLowerCase();

  let torrentId: string | number | null = null;
  let created = false;
  try {
    const add = await rawWrite(apiKey, '/torrents/addMagnet', {
      method: 'POST',
      body: new URLSearchParams({ magnet: magnetFor(hash) }),
    });
    if (!add?.id) {
      metrics.count('debrid.rd.probe.error');
      return { instant: false, reason: 'error' };
    }
    torrentId = add.id;
    created = true;
  } catch (err) {
    if (isBlockedError(err)) {
      metrics.count('debrid.rd.probe.blocked');
      return { instant: false, reason: 'blocked' };
    }
    if (looksAlreadyActive(err)) {
      metrics.count('debrid.rd.probe.active');
      return { instant: false, reason: 'active' };
    }
    // Rate/quota sobem: o orquestrador interrompe o lote.
    if (isRateLimitError(err) || isQuotaError(err)) throw err;
    metrics.count('debrid.rd.probe.error');
    return { instant: false, reason: 'error' };
  }

  try {
    // Sem espera longa: cache global costuma estar `downloaded` já no primeiro
    // info (ou logo após selectFiles). Ficar em downloading/queued = miss —
    // esperar viraria autofetch disfarçado e atrasaria o lote da sonda.
    const idToPoll = torrentId as string | number;
    let info: TorrentInfo = await readCall(apiKey, `/torrents/info/${idToPoll}`);
    if (info.status === WAITING_SELECTION && (info.files || []).length > 0) {
      await selectWaitingFiles(apiKey, idToPoll, info, {});
      info = await readCall(apiKey, `/torrents/info/${idToPoll}`);
    }
    if (info.status === READY) {
      metrics.count('debrid.rd.probe.instant');
      return { instant: true, reason: 'ready' };
    }
    metrics.count('debrid.rd.probe.miss');
    return { instant: false, reason: 'pending' };
  } catch (err) {
    if (isBlockedError(err)) {
      metrics.count('debrid.rd.probe.blocked');
      return { instant: false, reason: 'blocked' };
    }
    if (isRateLimitError(err) || isQuotaError(err)) throw err;
    metrics.count('debrid.rd.probe.error');
    return { instant: false, reason: 'error' };
  } finally {
    if (created && torrentId != null) {
      await cleanupTorrent(apiKey, torrentId);
    }
  }
}


async function probeInstant(apiKey: string, infoHash: string): Promise<ProbeInstantResult> {
  const hash = String(infoHash || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return { instant: false, reason: 'error' };
  const peeked = memo.peek(id, apiKey);
  if (peeked?.some((item) => String(item.infoHash || '').toLowerCase() === hash)) {
    metrics.count('debrid.rd.probe.instant');
    return { instant: true, reason: 'memo' };
  }
  return rdGate.run(accountScope(apiKey), 'probe', () => probeInstantUngated(apiKey, infoHash));
}

export {
  checkCached, inventory, torrentStatus, removeTorrent,
  accountStatus, activeTorrentCount, probeInstant,
};
