/**
 * Adaptador Real-Debrid — montagem e superfície pública.
 *
 * Dividido por fronteiras reais para respeitar o teto de 400 linhas:
 * - `realdebrid-core.ts`: plumbing HTTP compartilhado, constantes de estado
 *   do torrent, limpeza best-effort e identidade do adaptador.
 * Este arquivo mantém a checagem via ledger, o inventário, o status da conta e
 * a remoção de torrent, e REEXPORTA a identidade. O play/enqueue de produção é
 * NATIVO (gateway): não há mais corpo TS de play/autofetch aqui.
 */
import * as rdLedger from './rd-ledger.js';
import type { TorrentStatusEntry } from '../../types/domain.js';
import {
  READY, WORKING, readCall, rawRemoveTorrent, listTorrents,
} from './realdebrid-core.js';

export { id, label, short, cacheCheck, autofetchSource, keyUrl } from './realdebrid-core.js';

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

/**
 * Remove o torrent da conta. Sem gate de escrita (o dono do gate é o nativo);
 * o consumidor (limpeza do autofetch-suppressed) só quer o veredito booleano.
 */
async function removeTorrent(apiKey: string, id: string | number) {
  try {
    return await rawRemoveTorrent(apiKey, id);
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

export {
  checkCached, inventory, torrentStatus, removeTorrent, accountStatus,
};
