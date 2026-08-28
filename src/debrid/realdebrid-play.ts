/**
 * Fluxo de play/autofetch do Real-Debrid: resolução de link (addMagnet →
 * poll → selectFiles → unrestrict), reuso do torrent já pronto na conta e o
 * enqueue do autofetch. A recusa legal 451/error_code 35 grava
 * `rdLedger.noteBlocked` e NUNCA o banco de magnets (regra de AGENTS.md).
 */
import {
  magnetFor, pickFile, isBlockedError, isNoVideoError, wait,
} from './common.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as memo from './inventory-memo.js';
import { assertDubbedFiles, recordFileEvidence } from './audio-audit.js';
import type { PlayHint } from '../../types/domain.js';
import { accountScope } from '../utils/request-key.js';
import { rdGate } from './rd-gate.js';
import * as rdLedger from './rd-ledger.js';
import { id, READY, WORKING, WAITING_SELECTION, readCall, rawWrite, listTorrents, cleanupTorrent } from './realdebrid-core.js';
import type { TorrentInfo } from './realdebrid-core.js';

/** Seleciona uma única vez o arquivo que o RD liberou para escolha. */
export async function selectWaitingFiles(
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

export async function resolveLink(apiKey: string, infoHash: string, hint: PlayHint = {}) {
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
          await cleanupTorrent(apiKey, add.id);
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
      await cleanupTorrent(apiKey, add.id);
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

export async function enqueue(apiKey: string, infoHash: string, options: { season?: number | null; episode?: number | null } = {}) {
  return rdGate.run(accountScope(apiKey), 'autofetch', () => enqueueUngated(apiKey, infoHash, options));
}
