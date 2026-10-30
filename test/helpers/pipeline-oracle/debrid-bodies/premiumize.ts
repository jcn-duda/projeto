/**
 * Corpos TS do Premiumize (`resolveLink`, `enqueue`, `torrentStatus` e
 * `removeTorrent`), tirados de `src/debrid/premiumize.ts`.
 * Produção não roda isto: `current()` embrulha o adaptador na ponte nativa, que
 * sobrepõe o método. Só o oráculo de paridade chama, via `rawAdapter()`.
 *
 * O `checkCached` NÃO saiu de `src/`: o diagnóstico `liveCheck`
 * (`live-check.ts`, /stream-trace.json) lê o GET cru de lote pelo adaptador de
 * `BY_ID`, e essa leitura crua é justamente o contrato dele.
 */
import { magnetForPlay, pickFile } from '../../../../src/debrid/common.js';
import * as metrics from '../../../../src/utils/metrics.js';
import { assertDubbedFiles, recordFileEvidence } from '../../../../src/debrid/audio-audit.js';
import { call } from '../../../../src/debrid/premiumize.js';
import type { PlayHint, TorrentStatusEntry } from '../../../../types/domain.js';

/**
 * Resolve o link direto de reprodução — só na hora do play, porque o directdl
 * é caro demais pra rodar em cima da lista inteira de torrents.
 *
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: PlayHint = {}) {
  const body = new URLSearchParams({ src: magnetForPlay(infoHash) });
  const data = await call(apiKey, '/transfer/directdl', { method: 'POST', body });
  const file = pickFile(data.content || [], { season, episode, work });
  recordFileEvidence(infoHash, data.content || []);
  assertDubbedFiles(data.content || [], Boolean(dubbed));
  return file ? file.stream_link || file.link : null;
}
/**
 * Cria a transferência e sai. O directdl do resolveLink também baixaria, mas
 * ele espera o arquivo ficar pronto — aqui só queremos disparar.
 *
 * Devolve o ID da transferência, não um booleano: é a ÚNICA âncora que sobra
 * para reencontrá-la no `/transfer/list`. Medido na conta do operador: de 60
 * transferências, 58 não expunham hash nenhum (o `src` da listagem volta como
 * `/api/job/src?id=…`, e não existe campo `hash`), então o recheck só
 * alcançava as 2 cujo nome por acaso era o hash cru. Jogar o id fora aqui era
 * o que cegava o ciclo. String vazia/ausente continua sendo recusa.
 */
export async function enqueue(apiKey: string, infoHash: string) {
  const body = new URLSearchParams({ src: magnetForPlay(infoHash) });
  const data = await call(apiKey, '/transfer/create', { method: 'POST', body });
  return data?.id == null || data.id === '' ? false : String(data.id);
}

/**
 * Identifica o infoHash de uma transferência do Premiumize em cascata, na
 * ordem em que cada campo tem confiabilidade decrescente:
 *
 *   1. `src` → magnet do torrent, quando chega completo (`btih:40hex`);
 *   2. `name` → hash v1 cru de 40 hex no nome; o Premiumize às vezes converte
 *      o próprio filename no hash (sem um nome legível que o vista);
 *   3. `hash`/`info_hash` → campo direto quando a transferência o publica.
 *
 * Quem não casa com nenhum dos três não pode ser indexado no lote do recheck:
 * volta null e o chamador o conta em `debrid.pm.status.unmatched`, em vez de
 * inventar um hash com o qual limpar a conta por engano.
 */
function hashFromSrc(t: any): string | null {
  const m = String(t?.src || '').match(/btih:([a-f0-9]{40})/i);
  return m ? m[1].toLowerCase() : null;
}

function hashFromName(t: any): string | null {
  const m = String(t?.name || '').match(/(?:^|[\s._-])([a-f0-9]{40})(?:[\s._-]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

function hashFromField(t: any): string | null {
  const direct = String(t?.hash || t?.info_hash || '');
  return /^[a-f0-9]{40}$/i.test(direct) ? direct.toLowerCase() : null;
}

export function transferHash(t: any): string | null {
  return hashFromSrc(t) || hashFromName(t) || hashFromField(t);
}

/**
 * Mesma cascata, mais o id que o enqueue registrou — e ele entra em SEGUNDO,
 * logo depois do `src`.
 *
 * A posição importa: o id é prova de PRIMEIRA mão (fomos nós que submetemos
 * aquele hash e guardamos o id que o serviço devolveu), enquanto o `name` é
 * heurística ("às vezes o Premiumize converte o filename no hash"). Deixar o
 * id por último faria um nome com 40 hex que NÃO é o hash da transferência
 * ganhar de uma identificação que sabíamos correta — e o hash resultante
 * alimenta blacklist e removeTorrent, que é exatamente o engano que a cascata
 * existe para evitar. Só o `src` tem autoridade maior: é o magnet real.
 */
export function resolveTransfer(
  t: any,
  byId: Map<string, string>,
): { hash: string; via: 'hash' | 'id' } | null {
  const fromSrc = hashFromSrc(t);
  if (fromSrc) return { hash: fromSrc, via: 'hash' };
  const fromId = byId.get(String(t?.id ?? ''));
  if (fromId) return { hash: fromId, via: 'id' };
  const resto = hashFromName(t) || hashFromField(t);
  return resto ? { hash: resto, via: 'hash' } : null;
}

// Mensagem que denuncia uma parada real (sem avanço): sem pares de onde ler
// nem progresso para mostrar. O Premiumize reporta "0 Bytes of 0 Bytes" com
// capitalização variável; o par costuma aparecer como "0 peers"/"0 peer(s)".
export const STALLED_TRANSFER = /0 bytes of 0 bytes|from 0 peer/i;

/**
 * Status das transferências do Premiumize para detecção de prontos, mortos e
 * parados. Uma transferência `running` com progresso ausente ou 0 e mensagem
 * atascada ("0 Bytes of 0 Bytes" ou "from 0 peer") não avança: se marca
 * `stalled:true` para que o recheck a conte com o próprio limite, em vez de
 * derrubá-la pela mesma via que um dead de 2 rechecks.
 */
export async function torrentStatus(
  apiKey: string,
  _infoHashes?: string[],
  ids?: Record<string, string | number>,
) {
  const data = await call(apiKey, '/transfer/list');
  const transfers = Array.isArray(data?.transfers) ? data.transfers : [];
  // id da transferência -> hash, invertido do que o enqueue registrou. É o
  // que devolve visibilidade sobre a conta: a listagem do Premiumize não
  // publica hash, então sem esta ponte 58 de 60 transferências ficavam
  // invisíveis ao recheck (medido na conta do operador).
  const byId = new Map<string, string>();
  for (const [hash, id] of Object.entries(ids || {})) {
    if (id != null && id !== '') byId.set(String(id), String(hash).toLowerCase());
  }
  const out: Record<string, TorrentStatusEntry> = {};
  // Totais DESTA leitura. Vão para gauge, não para contador: a pergunta é
  // "quantas a ponte alcança agora", e um `count` dentro do laço somaria a
  // cada poll — foi assim que o `unmatched` chegou a 330 com meia dúzia de
  // transferências órfãs, um número que engana quem tenta lê-lo como estoque.
  let viaId = 0;
  let semHash = 0;
  for (const t of transfers) {
    const achado = resolveTransfer(t, byId);
    if (!achado) {
      // Não dá pra mapeá-la ao lote do recheck: não serve para saber se ficou
      // pronto nem para limpar. Contá-la torna visível que a conta arrasta
      // transferências órfãs que o ciclo nunca vai alcançar.
      metrics.count('debrid.pm.status.unmatched');
      semHash += 1;
      continue;
    }
    const { hash, via } = achado;
    if (via === 'id') viaId += 1;
    const status = String(t?.status || '').toLowerCase();
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    let stalled = false;
    if (status === 'finished' || status === 'seeding') {
      state = 'ready';
    } else if (status === 'queued') {
      state = 'downloading';
    } else if (status === 'running') {
      state = 'downloading';
      const progress = Number(t?.progress);
      const moving = Number.isFinite(progress) && progress !== 0;
      const message = String(t?.message || '');
      if (!moving && STALLED_TRANSFER.test(message)) {
        stalled = true;
      }
    } else if (status === 'error') {
      state = 'dead';
    }
    out[hash] = { state, stalled, id: t?.id, via };
  }
  metrics.gauge('debrid.pm.status.byId', viaId);
  metrics.gauge('debrid.pm.status.orphans', semHash);
  return out;
}

/**
 * Remove transferência pelo id no Premiumize.
 */
export async function removeTorrent(apiKey: string, id: string | number) {
  try {
    const body = new URLSearchParams({ id: String(id) });
    await call(apiKey, '/transfer/delete', { method: 'POST', body });
    return true;
  } catch (err) {
    return false;
  }
}

export const bodies = { resolveLink, enqueue, torrentStatus, removeTorrent };
