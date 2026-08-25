import {
  magnetFor, json, pickFile, isBlockedError, isNoVideoError, isRateLimitError, isQuotaError, wait,
} from './common.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as memo from './inventory-memo.js';
import { assertDubbedFiles, recordFileEvidence } from './audio-audit.js';
import type { PlayHint, TorrentStatusEntry } from '../../types/domain.js';
import { accountScope } from '../utils/request-key.js';
import { rdGate } from './rd-gate.js';
import * as rdLedger from './rd-ledger.js';

/** Resultado da sonda de disponibilidade (substituto honesto do instantAvailability). */
export type ProbeInstantResult = {
  instant: boolean;
  reason: 'ready' | 'pending' | 'blocked' | 'active' | 'error' | 'memo';
};

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

function readCall(apiKey: string, path: string) {
  return request(apiKey, path);
}

function rawWrite(apiKey: string, path: string, options: CallOptions) {
  return request(apiKey, path, options);
}

/**
 * Listagem completa da conta, paginada. O Real-Debrid devolve só a primeira
 * página sem `?limit` (e `offset` anda em passos de `limit`), então uma conta
 * com mais de 2500 magnets perderia o inventário silenciosamente numa chamada só.
 */
async function listTorrents(apiKey: string) {
  const rows: any[] = [];
  for (let offset = 0; offset < LIST_MAX_ROWS; offset += LIST_LIMIT) {
    const page = await readCall(apiKey, `/torrents?limit=${LIST_LIMIT}&offset=${offset}`);
    const chunk = Array.isArray(page) ? page : [];
    rows.push(...chunk);
    if (chunk.length < LIST_LIMIT) break;
  }
  return rows;
}

/**
 * O Real-Debrid aposentou o /torrents/instantAvailability: não há mais como
 * perguntar em lote o que está em cache. Devolvemos vazio e o orquestrador
 * trata todos como "não sei" — ver `cacheCheck: false` no final do arquivo.
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

const READY = 'downloaded';
const WORKING = ['magnet_conversion', 'queued', 'downloading', 'compressing', 'uploading'];
const WAITING_SELECTION = 'waiting_files_selection';

type TorrentInfo = { status?: string; files?: any[]; links?: string[]; filename?: string; bytes?: number | string; id?: string | number };

/** Seleciona uma única vez o arquivo que o RD liberou para escolha. */
async function selectWaitingFiles(
  apiKey: string,
  torrentId: string | number,
  info: TorrentInfo,
  hint: PlayHint,
) {
  const wanted = pickFile(
    (info.files || []).map((file: any) => ({ ...file, path: file.path, size: file.bytes })),
    hint,
  );
  await rawWrite(apiKey, `/torrents/selectFiles/${torrentId}`, {
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
  let info: TorrentInfo = await readCall(apiKey, `/torrents/info/${torrentId}`);
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
    info = await readCall(apiKey, `/torrents/info/${torrentId}`);
  }

  return { info, selected };
}

/**
 * Id do torrent JA baixado na conta para este infoHash, ou '' se nao houver.
 * Serve pro resolve reusar o que o usuario ja tem em vez de re-adicionar.
 */
async function readyTorrentId(apiKey: string, infoHash: string) {
  const hash = infoHash.toLowerCase();
  // Memo quente responde sem tocar na rede: a listagem completa custava uma
  // chamada larga em TODO play, e o memo é a mesma evidência servida da
  // memória. Item sem id (formato antigo) cai no caminho de rede.
  const peeked = memo.peek(id, apiKey);
  if (peeked) {
    const hit = peeked.find((i) => String(i.infoHash || '').toLowerCase() === hash);
    if (hit?.id) {
      metrics.count('debrid.rd.readyFromMemo');
      return String(hit.id);
    }
  }
  try {
    const rows = await listTorrents(apiKey);
    const hit = rows.find((t: any) => String(t?.hash || '').toLowerCase() === hash && t?.status === READY);
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
async function finishResolve(
  apiKey: string,
  infoHash: string,
  torrentId: string | number,
  info: TorrentInfo,
  { season, episode, work, dubbed }: PlayHint,
) {
  // Já em cache o status vira "downloaded" quase imediatamente. Se ainda
  // estiver baixando, não há o que tocar agora — o play falharia num buffer
  // eterno, então é melhor devolver nada e deixar o usuário escolher outro.
  if (info.status !== READY) {
    log.warn(`[realdebrid] torrent não está em cache (status: ${info.status})`);
    return null;
  }

  // `downloaded` é confirmação gratuita do CDN do serviço. Ao contrário do
  // magnetdb por conta, este ledger global pode beneficiar outra instalação RD.
  rdLedger.noteHit([infoHash]);

  // Pronto na conta atualiza o memo quente: a próxima busca marca ⚡ sem
  // esperar o TTL do inventário. Memo frio continua lazy (não cria retrato).
  memo.note(id, apiKey, {
    title: String(info.filename || '').trim(),
    infoHash,
    size: Number(info.bytes) || 0,
    id: String(torrentId),
  });

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

  const unrestricted = await rawWrite(apiKey, '/unrestrict/link', {
    method: 'POST',
    body: new URLSearchParams({ link }),
  });
  return unrestricted?.download || null;
}

async function resolveLink(apiKey: string, infoHash: string, hint: PlayHint = {}) {
  try {
    // O que já está pronto evita addMagnet e espera do fluxo composto. Só a
    // escrita inevitável de unrestrict passa por uma admissão de play.
    const readyId = await readyTorrentId(apiKey, infoHash);
    if (readyId) {
      const info: TorrentInfo = await readCall(apiKey, `/torrents/info/${readyId}`);
      return rdGate.run(
        accountScope(apiKey),
        'play',
        () => finishResolve(apiKey, infoHash, readyId, info, hint),
      );
    }

    // addMagnet, seleção e unrestrict formam um job só: concorrência 1 sem
    // reentrância. O teto do play só fura cooldown/gap; job já em voo termina
    // antes, pois o gate não preempta escrita composta.
    return await rdGate.run(accountScope(apiKey), 'play', async () => {
      const add = await rawWrite(apiKey, '/torrents/addMagnet', {
        method: 'POST',
        body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
      });
      if (!add?.id) return null;
      try {
        const { info } = await pollTorrent(apiKey, add.id, hint);
        return finishResolve(apiKey, infoHash, add.id, info, hint);
      } catch (error) {
        // Sem vídeo, o torrent ficaria preso ocupando vaga. A limpeza pertence
        // ao mesmo job para não reentrar no gate.
        if (isNoVideoError(error)) {
          await rawRemoveTorrent(apiKey, add.id);
          memo.forget(id, apiKey, infoHash);
        }
        throw error;
      }
    });
  } catch (err) {
    // 451 é uma decisão do catálogo global do RD, não um problema da conta.
    if (isBlockedError(err)) rdLedger.noteBlocked(infoHash);
    throw err;
  }
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
async function enqueueUngated(apiKey: string, infoHash: string, { season, episode }: { season?: number | null; episode?: number | null } = {}) {
  let add: any;
  try {
    add = await rawWrite(apiKey, '/torrents/addMagnet', {
      method: 'POST',
      body: new URLSearchParams({ magnet: magnetFor(infoHash) }),
    });
  } catch (err) {
    // O 451 recusa o magnet antes de existir um id; não há torrent para limpar
    // nem motivo para o runner tentar de novo como se fosse falha transitória.
    if (isBlockedError(err)) {
      rdLedger.noteBlocked(infoHash);
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
      await rawRemoveTorrent(apiKey, add.id);
      memo.forget(id, apiKey, infoHash);
      log.warn(`[realdebrid] ${infoHash} não tem arquivo de vídeo; recusando o autofetch`);
      return false;
    }
    if (isBlockedError(err)) {
      rdLedger.noteBlocked(infoHash);
      log.warn(`[realdebrid] torrent ${infoHash.slice(0, 8)} bloqueado por motivo legal; recusando o autofetch`);
      return false;
    }
    throw err;
  }
  // Pronto na conta entra no memo quente agora: o ⚡ da próxima busca não
  // espera o TTL do inventário.
  if (result.info.status === READY) {
    rdLedger.noteHit([infoHash]);
    memo.note(id, apiKey, {
      title: String(result.info.filename || '').trim(),
      infoHash,
      size: Number(result.info.bytes) || 0,
      id: String(add.id),
    });
  }
  // Torrent já pronto não precisa selecionar. Fora isso, só é sucesso depois
  // que esta execução selecionou ou o RD prova que já havia arquivo escolhido.
  // magnet_conversion/queued sem essa evidência não pode ganhar marker de
  // autofetch: uma tentativa futura ainda pode receber o catálogo e selecionar.
  return result.info.status === READY || result.selected || Boolean(result.info.files?.some((file: any) => file.selected));
}

async function enqueue(apiKey: string, infoHash: string, options: { season?: number | null; episode?: number | null } = {}) {
  return rdGate.run(accountScope(apiKey), 'autofetch', () => enqueueUngated(apiKey, infoHash, options));
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
 * Remove torrent pelo id no Real-Debrid.
 */
async function rawRemoveTorrent(apiKey: string, id: string | number) {
  await rawWrite(apiKey, `/torrents/delete/${id}`, { method: 'DELETE' });
  return true;
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

function looksAlreadyActive(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /torrent already active|error_code["']?\s*:\s*33|\b33\b.*already/i.test(msg);
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
      await rawRemoveTorrent(apiKey, torrentId);
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

export const id = 'realdebrid';
export const label = 'Real-Debrid';
export const short = 'RD';
export const cacheCheck = false;
export const autofetchSource = true;
export const keyUrl = 'https://real-debrid.com/apitoken';
export {
  enqueue, checkCached, resolveLink, inventory, torrentStatus, removeTorrent,
  accountStatus, activeTorrentCount, probeInstant,
};
