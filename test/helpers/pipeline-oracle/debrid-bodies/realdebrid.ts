/**
 * Corpos TS do Real-Debrid, tirados de `src/debrid/realdebrid.ts`:
 * `checkCached` (sem API em lote: o ledger decide), e o lado de AUTOFETCH e
 * conta (`inventory`, `torrentStatus`, `removeTorrent`), que em produção é
 * nativo (gateway). Produção não roda isto: `current()` embrulha o adaptador na
 * ponte nativa. Só o oráculo de paridade chama, via `rawAdapter()`.
 */
import * as rdLedger from '../../../../src/debrid/rd-ledger.js';
import type { TorrentStatusEntry } from '../../../../types/domain.js';
import {
  READY, WORKING, listTorrents, rawRemoveTorrent,
} from '../../../../src/debrid/realdebrid-core.js';

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

export const bodies = {
  checkCached, inventory, torrentStatus, removeTorrent,
};
