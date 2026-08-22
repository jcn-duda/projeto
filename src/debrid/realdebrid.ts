import { magnetFor, json, pickFile, isNoVideoError, wait } from './common.js';
import * as log from '../utils/logger.js';
import { assertDubbedFiles } from './audio-audit.js';

const API = 'https://api.real-debrid.com/rest/1.0';

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
function call(apiKey: string, path: string, { method = 'GET', body }: { method?: string; body?: any } = {}) {
  return json(`${API}${path}`, {
    method,
    headers: {
      ...auth(apiKey),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
}

/**
 * O Real-Debrid aposentou o /torrents/instantAvailability: não há mais como
 * perguntar em lote o que está em cache. Devolvemos vazio e o orquestrador
 * trata todos como "não sei" — ver `cacheCheck: false` no final do arquivo.
 */
async function checkCached() {
  return new Set<string>();
}

const READY = 'downloaded';
const WORKING = ['magnet_conversion', 'queued', 'downloading', 'compressing', 'uploading'];

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: { season?: number | null; episode?: number | null; work?: any; dubbed?: boolean } = {}) {
  const add = await call(apiKey, '/torrents/addMagnet', {
    method: 'POST',
    body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
  });
  if (!add?.id) return null;

  let info = await call(apiKey, `/torrents/info/${add.id}`);

  // O torrent entra sem nenhum arquivo selecionado; sem selectFiles ele nunca
  // sai de "waiting_files_selection" e a lista de links fica vazia.
  if (info.status === 'waiting_files_selection') {
    let wanted;
    try {
      wanted = pickFile(
        (info.files || []).map((f: any) => ({ ...f, path: f.path, size: f.bytes })),
        { season, episode, work },
      );
    } catch (err) {
      // Sem vídeo na listagem: o torrent JÁ foi adicionado e ficaria preso em
      // waiting_files_selection ocupando vaga da conta, porque nada seleciona
      // arquivo depois daqui. Remove antes de deixar o erro subir — quem
      // condena o hash é o /resolve, no catch do NoVideoError.
      if (isNoVideoError(err)) await removeTorrent(apiKey, add.id);
      throw err;
    }
    await call(apiKey, `/torrents/selectFiles/${add.id}`, {
      method: 'POST',
      body: new URLSearchParams({ files: wanted ? String(wanted.id) : 'all' }),
    });
    info = await call(apiKey, `/torrents/info/${add.id}`);
  }

  // Já em cache o status vira "downloaded" quase imediatamente. Se ainda
  // estiver baixando, não há o que tocar agora — o play falharia num buffer
  // eterno, então é melhor devolver nada e deixar o usuário escolher outro.
  for (let attempt = 0; attempt < 3 && WORKING.includes(info.status); attempt += 1) {
    await wait(700);
    info = await call(apiKey, `/torrents/info/${add.id}`);
  }
  if (info.status !== READY) {
    log.warn(`[realdebrid] torrent não está em cache (status: ${info.status})`);
    return null;
  }

  // `links` traz só os arquivos selecionados, na ordem dos selecionados —
  // por isso a escolha do arquivo é refeita sobre esse subconjunto.
  const selected = (info.files || []).filter((f: any) => f.selected);
  assertDubbedFiles(selected.map((f: any) => ({ ...f, path: f.path, size: f.bytes })), Boolean(dubbed));
  const idx = selected.length > 1
    ? selected.indexOf(
        pickFile(selected.map((f: any) => ({ ...f, path: f.path, size: f.bytes })), { season, episode, work }),
      )
    : 0;
  const link = (info.links || [])[idx >= 0 ? idx : 0];
  if (!link) return null;

  const unrestricted = await call(apiKey, '/unrestrict/link', {
    method: 'POST',
    body: new URLSearchParams({ link }),
  });
  return unrestricted?.download || null;
}

/**
 * Só ENFILEIRA o download e sai; quem quer o link usa resolveLink.
 * O selectFiles não é opcional: sem ele o torrent fica parado em
 * "waiting_files_selection" para sempre e nada é baixado.
 *
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 */
async function enqueue(apiKey: string, infoHash: string, { season, episode }: { season?: number | null; episode?: number | null } = {}) {
  const add = await call(apiKey, '/torrents/addMagnet', {
    method: 'POST',
    body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
  });
  if (!add?.id) return false;

  const info = await call(apiKey, `/torrents/info/${add.id}`);
  if (info.status !== 'waiting_files_selection') return true;

  let wanted;
  try {
    wanted = pickFile(
      (info.files || []).map((f: any) => ({ ...f, path: f.path, size: f.bytes })),
      { season, episode },
    );
  } catch (err) {
    // Antes do NoVideoError, `null` caía no `files: 'all'` e o autofetch baixava
    // um torrent sem vídeo nenhum. Agora a prova existe: remove o torrent (ele
    // ficaria preso em waiting_files_selection) e RECUSA. `false` é o contrato
    // que o chamador entende — ele conta `autofetch.refused` e loga "não
    // aceitou"; deixar subir viraria "[autofetch] falhou" genérico.
    if (isNoVideoError(err)) {
      await removeTorrent(apiKey, add.id);
      log.warn(`[realdebrid] ${infoHash} não tem arquivo de vídeo; recusando o autofetch`);
      return false;
    }
    throw err;
  }
  await call(apiKey, `/torrents/selectFiles/${add.id}`, {
    method: 'POST',
    body: new URLSearchParams({ files: wanted ? String(wanted.id) : 'all' }),
  });
  return true;
}

/**
 * Inventário PRONTO da conta Real-Debrid (`{ title, infoHash, size }`).
 */
async function inventory(apiKey: string) {
  const list = await call(apiKey, '/torrents/list');
  const rows = Array.isArray(list) ? list : [];
  const out: any[] = [];
  for (const t of rows) {
    if (t?.status !== READY) continue;
    const infoHash = String(t.hash || '').toLowerCase();
    const title = String(t.filename || '').trim();
    if (!infoHash || !title || title.toLowerCase() === infoHash) continue;
    out.push({ title, infoHash, size: Number(t.bytes) || 0 });
  }
  return out;
}

/**
 * Status de torrents na conta Real-Debrid para o ciclo de recheck / detecção de mortos.
 */
async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const list = await call(apiKey, '/torrents/list');
  const rows = Array.isArray(list) ? list : [];
  const out: Record<string, { state: 'ready' | 'downloading' | 'dead' | 'unknown'; id?: any }> = {};
  for (const t of rows) {
    const hash = String(t.hash || '').toLowerCase();
    if (!hash) continue;
    const status = String(t.status || '').toLowerCase();
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    if (status === READY) {
      state = 'ready';
    } else if (/^(magnet_error|error|virus|dead)$/i.test(status)) {
      state = 'dead';
    } else if (WORKING.includes(status) || status === 'waiting_files_selection') {
      state = 'downloading';
    }
    out[hash] = { state, id: t.id };
  }
  return out;
}

/**
 * Remove torrent pelo id no Real-Debrid.
 */
async function removeTorrent(apiKey: string, id: any) {
  try {
    await call(apiKey, `/torrents/delete/${id}`, { method: 'DELETE' });
    return true;
  } catch (err) {
    return false;
  }
}

export const id = 'realdebrid';
export const label = 'Real-Debrid';
export const short = 'RD';
export const cacheCheck = false;
export const autofetchSource = true;
export const keyUrl = 'https://real-debrid.com/apitoken';
export { enqueue, checkCached, resolveLink, inventory, torrentStatus, removeTorrent };
