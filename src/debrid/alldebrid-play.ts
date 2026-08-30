import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import { pickFile, wait } from './common.js';
import * as log from '../utils/logger.js';
import { call, flattenFiles, DEAD, ACTIVE_STATES, id, type AllDebridMagnet } from './alldebrid-api.js';
import { rememberSubmitted } from './alldebrid-inventory.js';
import { skipCleanup } from './alldebrid-cleanup.js';
import { assertDubbedFiles, recordFileEvidence } from './audio-audit.js';
import type { PlayHint, TorrentStatusEntry } from '../../types/domain.js';

/**
 * Anota o negativo medido pelo play (davail=0 pela janela do availNegTtl) para
 * o atalho do histórico (`DEBRID_ALIVE_AS_CACHE`) não pintar ⚡ no hash que o
 * play acabou de provar frio. Import dinâmico DE PROPÓSITO: um estático
 * criaria o ciclo alldebrid-play → cache-check → registry → alldebrid →
 * alldebrid-play, e o grafo dos irmãos alldebrid é sem ciclo por contrato
 * (ver cabeçalho de alldebrid.ts). Best-effort: falha de anotação nunca
 * derruba o play.
 */
async function annotateUnavailable(apiKey: string, infoHash: string) {
  try {
    const { noteUnavailable } = await import('./cache-check.js');
    noteUnavailable(id, apiKey, infoHash);
  } catch (err) {
    log.warn('[alldebrid] não consegui anotar davail=0 do play:', log.errorMessage(err));
  }
}

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
export async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  const account = accountScope(apiKey);
  const upload = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  const magnet = (upload?.magnets || [])[0];
  if (!magnet?.id) return null;

  let status = await call(apiKey, '/magnet/status', { id: magnet.id });
  let info = status?.magnets;
  // A resposta às vezes vem como lista de um item só.
  if (Array.isArray(info)) info = info[0];

  // Em cache, vira "Ready" na hora. Se não, o torrent entraria em download e o
  // play ficaria travado — melhor devolver nada e deixar escolher outro.
  for (let attempt = 0; attempt < 3 && info && info.status !== 'Ready'; attempt += 1) {
    await wait(700);
    status = await call(apiKey, '/magnet/status', { id: magnet.id });
    info = Array.isArray(status?.magnets) ? status.magnets[0] : status?.magnets;
  }
  if (!info || info.status !== 'Ready') {
    log.warn(`[alldebrid] torrent não está em cache (status: ${info?.status})`);
    // Sem isso o magnet fica baixando na conta pra sempre: como a AllDebrid não
    // tem consulta de cache, TODO play que falha deixa um download fantasma
    // (foram 226 acumulados até este bug aparecer). O upload é idempotente,
    // então apagar não custa nada — se o usuário voltar, ele é reenviado.
    // Idem no play: se o usuário clicou num BR que está baixando por nossa
    // conta, apagar aqui jogaria fora o progresso.
    if (config.debrid.dropUncached && !skipCleanup(account, infoHash)) {
      try {
        await call(apiKey, '/magnet/delete', { id: magnet.id });
      } catch (err) {
        log.warn('[alldebrid] não consegui remover o magnet:', err.message);
      }
      // MESMA GUARDA do delete: só onde o magnet saiu (ou sairia) da conta é
      // que "não está pronto" é evidência sobre o cache. Magnet protegido
      // (hold/adprot) continua na conta baixando — gravar 0 aqui esconderia o
      // ⚡ do download que o próprio autofetch está fazendo.
      await annotateUnavailable(apiKey, infoHash);
    }
    return null;
  }

  const files = flattenFiles(info.files);
  const file = pickFile(files, { season, episode, work });
  recordFileEvidence(infoHash, files);
  assertDubbedFiles(files, Boolean(dubbed));
  if (!file) return null;

  const unlocked = await call(apiKey, '/link/unlock', { link: file.link });
  return unlocked?.link || null;
}

/**
 * O /magnet/upload já é o próprio "começa a baixar" da AllDebrid: o mesmo
 * endpoint que responde `ready` para o cache é o que enfileira o que não está.
 */
export async function enqueue(apiKey: string, infoHash: string) {
  const data = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  if (data?.magnets?.length) rememberSubmitted(accountScope(apiKey), infoHash);
  return Boolean(data?.magnets?.length);
}

/**
 * Status detalhado de torrents na conta para o ciclo de recheck / detecção de mortos.
 */
export async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const data = await call(apiKey, '/magnet/status');
  const list: AllDebridMagnet[] = Array.isArray(data?.magnets) ? data.magnets : [];
  const out: Record<string, TorrentStatusEntry> = {};
  for (const magnet of list) {
    const hash = String(magnet.hash || '').toLowerCase();
    if (!hash) continue;
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    const statusStr = String(magnet.status || '');
    if (magnet.ready || /^ready$/i.test(statusStr)) {
      state = 'ready';
    } else if (DEAD.test(statusStr)) {
      state = 'dead';
    } else if (ACTIVE_STATES.test(statusStr)) {
      state = 'downloading';
    }
    out[hash] = { state, id: magnet.id };
  }
  return out;
}

/**
 * Remove torrent específico pelo id na AllDebrid.
 */
export async function removeTorrent(apiKey: string, id: string | number) {
  try {
    await call(apiKey, '/magnet/delete', { id });
    return true;
  } catch (err) {
    log.warn(`[alldebrid] falha ao remover torrent ${id}:`, err?.message || err);
    return false;
  }
}
