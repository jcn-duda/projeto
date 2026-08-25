import { magnetFor, json, pickFile, isBlockedError, isNoVideoError, wait } from './common.js';
import * as log from '../utils/logger.js';
import { assertDubbedFiles, recordFileEvidence } from './audio-audit.js';
import type { PlayHint, TorrentStatusEntry } from '../../types/domain.js';

const API = 'https://api.real-debrid.com/rest/1.0';

// O Real-Debrid nao tem /torrents/list: a listagem e GET /torrents, e sem
// ?limit ela devolve so a primeira pagina (100). Com o endpoint errado o
// inventario 404ava, nada era marcado como cacheado e a lista inteira saia
// como [RD Download].
const LIST_LIMIT = 2500;

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
function call(apiKey: string, path: string, { method = 'GET', body }: { method?: string; body?: BodyInit | null } = {}) {
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
const WAITING_SELECTION = 'waiting_files_selection';

type TorrentInfo = { status?: string; files?: any[]; links?: string[] };

/** Seleciona uma única vez o arquivo que o RD liberou para escolha. */
async function selectWaitingFiles(apiKey: string, torrentId: string | number, info: TorrentInfo, hint: PlayHint) {
  const wanted = pickFile(
    (info.files || []).map((file: any) => ({ ...file, path: file.path, size: file.bytes })),
    hint,
  );
  await call(apiKey, `/torrents/selectFiles/${torrentId}`, {
    method: 'POST',
    body: new URLSearchParams({ files: wanted ? String(wanted.id) : 'all' }),
  });
}

/**
 * O RD pode expor magnet_conversion/queued antes de pedir os arquivos. A
 * seleção precisa acontecer no primeiro poll que chegar nesse estado, não só
 * no snapshot logo após addMagnet; depois disso seguimos o mesmo orçamento de
 * polls até ficar pronto ou estabilizar fora de um estado de trabalho.
 */
async function pollTorrent(apiKey: string, torrentId: string | number, hint: PlayHint) {
  let info: TorrentInfo = await call(apiKey, `/torrents/info/${torrentId}`);
  let selected = false;

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    // O RD às vezes anuncia o estado antes de materializar o catálogo. Sem
    // arquivos não há prova para escolher nem motivo para mandar `all`.
    if (info.status === WAITING_SELECTION && !selected && (info.files || []).length > 0) {
      await selectWaitingFiles(apiKey, torrentId, info, hint);
      selected = true;
    }
    if (info.status === READY || (!WORKING.includes(String(info.status)) && info.status !== WAITING_SELECTION) || attempt === 3) {
      return { info, selected };
    }
    await wait(700);
    info = await call(apiKey, `/torrents/info/${torrentId}`);
  }

  return { info, selected };
}

/**
 * Id do torrent JA baixado na conta para este infoHash, ou '' se nao houver.
 * Serve pro resolve reusar o que o usuario ja tem em vez de re-adicionar.
 */
async function readyTorrentId(apiKey: string, infoHash: string) {
  try {
    const list = await call(apiKey, '/torrents?limit=' + LIST_LIMIT);
    const rows = Array.isArray(list) ? list : [];
    const hit = rows.find((t: any) => String(t?.hash || '').toLowerCase() === infoHash.toLowerCase() && t?.status === READY);
    return hit ? String(hit.id) : '';
  } catch {
    // Listagem indisponivel nao pode derrubar o play: segue pelo addMagnet.
    return '';
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
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  // O que ja esta pronto na conta nao passa pelo addMagnet de novo: re-adicionar
  // duplicava o torrent na conta e, pior, esbarrava no 451 `infringing_file` do
  // Real-Debrid — o play morria em conteudo que o usuario JA tinha baixado.
  let torrentId = await readyTorrentId(apiKey, infoHash);
  if (!torrentId) {
    const add = await call(apiKey, '/torrents/addMagnet', {
      method: 'POST',
      body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
    });
    if (!add?.id) return null;
    torrentId = add.id;
  }

  let info: TorrentInfo;
  try {
    ({ info } = await pollTorrent(apiKey, torrentId, { season, episode, work }));
  } catch (err) {
    // Sem vídeo na listagem: o torrent JÁ foi adicionado e ficaria preso em
    // waiting_files_selection ocupando vaga da conta. O NoVideoError precisa
    // continuar chegando ao /resolve para condenar o hash no banco.
    if (isNoVideoError(err)) await removeTorrent(apiKey, torrentId);
    throw err;
  }

  // Já em cache o status vira "downloaded" quase imediatamente. Se ainda
  // estiver baixando, não há o que tocar agora — o play falharia num buffer
  // eterno, então é melhor devolver nada e deixar o usuário escolher outro.
  if (info.status !== READY) {
    log.warn(`[realdebrid] torrent não está em cache (status: ${info.status})`);
    return null;
  }

  // `links` traz só os arquivos selecionados, na ordem dos selecionados —
  // por isso a escolha do arquivo é refeita sobre esse subconjunto.
  const selected = (info.files || []).filter((f: any) => f.selected);
  const normalizados = selected.map((f: any) => ({ ...f, path: f.path, size: f.bytes }));
  recordFileEvidence(infoHash, normalizados);
  assertDubbedFiles(normalizados, Boolean(dubbed));
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
  let add: any;
  try {
    add = await call(apiKey, '/torrents/addMagnet', {
      method: 'POST',
      body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
    });
  } catch (err) {
    // O 451 recusa o magnet antes de existir um id; não há torrent para limpar
    // nem motivo para o runner tentar de novo como se fosse falha transitória.
    if (isBlockedError(err)) {
      log.warn(`[realdebrid] torrent ${infoHash.slice(0, 8)} bloqueado por motivo legal; recusando o autofetch`);
      return false;
    }
    throw err;
  }
  if (!add?.id) return false;

  let result: { info: TorrentInfo; selected: boolean };
  try {
    result = await pollTorrent(apiKey, add.id, { season, episode });
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
    if (isBlockedError(err)) {
      log.warn(`[realdebrid] torrent ${infoHash.slice(0, 8)} bloqueado por motivo legal; recusando o autofetch`);
      return false;
    }
    throw err;
  }
  // Torrent já pronto não precisa selecionar. Fora isso, só é sucesso depois
  // que esta execução selecionou ou o RD prova que já havia arquivo escolhido.
  // magnet_conversion/queued sem essa evidência não pode ganhar marker de
  // autofetch: uma tentativa futura ainda pode receber o catálogo e selecionar.
  return result.info.status === READY || result.selected || Boolean(result.info.files?.some((file: any) => file.selected));
}

/**
 * Inventário PRONTO da conta Real-Debrid (`{ title, infoHash, size }`).
 */
async function inventory(apiKey: string) {
  const list = await call(apiKey, '/torrents?limit=' + LIST_LIMIT);
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
  const list = await call(apiKey, '/torrents?limit=' + LIST_LIMIT);
  const rows = Array.isArray(list) ? list : [];
  const out: Record<string, TorrentStatusEntry> = {};
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
async function removeTorrent(apiKey: string, id: string | number) {
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
