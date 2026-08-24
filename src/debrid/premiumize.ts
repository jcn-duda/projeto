import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import * as held from './protected.js';
import { accountScope } from '../utils/request-key.js';
import {
  magnetFor, json, pickFile, batched,
  AuthError, QuotaError, RateLimitError,
} from './common.js';
import { assertDubbedFiles, recordFileEvidence } from './audio-audit.js';
import type { PlayHint, TorrentStatusEntry } from '../../types/domain.js';

const API = 'https://www.premiumize.me/api';

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Object} [options.params]
 * @param {*} [options.body]
 * @param {number} [options.timeout]
 */
async function call(apiKey: string, path: string, { method = 'GET', params = {}, body, timeout }: { method?: string; params?: Record<string, string | string[]>; body?: BodyInit | null; timeout?: number } = {}) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const data = await json(url, { method, body, timeout });
  // HTTP 200 com status:error — rate_limit e account_limit chegam assim.
  if (data.status && data.status !== 'success') {
    const code = String(data.code || '');
    const message = data.message || code || 'premiumize retornou erro';
    const full = code && !message.includes(code) ? `${message} (${code})` : message;
    if (code === 'authentication_failed' || code === 'permission_denied') {
      throw new AuthError(full);
    }
    if (code === 'account_limit_reached') throw new QuotaError(full);
    if (code === 'rate_limit_reached') throw new RateLimitError(full);
    throw new Error(full);
  }
  return data;
}

/**
 * Quais desses infoHashes já estão no cache do Premiumize (play instantâneo).
 * Retorna um Set com os hashes disponíveis.
 *
 * @param {string} apiKey
 * @param {string[]} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
async function checkCached(apiKey: string, infoHashes: string[], { timeoutMs }: { timeoutMs?: number } = {}) {
  // A API aceita lote; mantemos blocos pra não montar URLs gigantes.
  return batched(infoHashes, config.debrid.batchSize, async (batch, ctx) => {
    const data = await call(apiKey, '/cache/check', {
      params: { 'items[]': batch },
      timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout,
    });
    const flags = data.response || [];
    return batch.filter((_, idx) => flags[idx]);
  }, { timeoutMs });
}

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
  const body = new URLSearchParams({ src: magnetFor(infoHash) });
  const data = await call(apiKey, '/transfer/directdl', { method: 'POST', body });
  const file = pickFile(data.content || [], { season, episode, work });
  recordFileEvidence(infoHash, data.content || []);
  assertDubbedFiles(data.content || [], Boolean(dubbed));
  return file ? file.stream_link || file.link : null;
}

/**
 * Cria a transferência e sai. O directdl do resolveLink também baixaria, mas
 * ele espera o arquivo ficar pronto — aqui só queremos disparar.
 */
async function enqueue(apiKey: string, infoHash: string) {
  const body = new URLSearchParams({ src: magnetFor(infoHash) });
  const data = await call(apiKey, '/transfer/create', { method: 'POST', body });
  return Boolean(data?.id);
}

/**
 * Fair-use da conta (`limit_used` em [0, 1]). É o sinal que falta: o teto do
 * Premiumize é tráfego, e até estourar (`account_limit_reached`) não havia
 * aviso nenhum.
 */
async function accountStatus(apiKey: string) {
  const data = await call(apiKey, '/account/info');
  const raw = Number(data.limit_used);
  const limitUsed = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : null;
  return {
    limitUsed,
    premiumUntil: data.premium_until == null ? null : Number(data.premium_until) || null,
  };
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
function transferHash(t: any): string | null {
  const fromSrc = String(t?.src || '').match(/btih:([a-f0-9]{40})/i);
  if (fromSrc) return fromSrc[1].toLowerCase();
  const fromName = String(t?.name || '').match(/(?:^|[\s._-])([a-f0-9]{40})(?:[\s._-]|$)/i);
  if (fromName) return fromName[1].toLowerCase();
  const direct = String(t?.hash || t?.info_hash || '');
  if (/^[a-f0-9]{40}$/i.test(direct)) return direct.toLowerCase();
  return null;
}

// Mensagem que denuncia uma parada real (sem avanço): sem pares de onde ler
// nem progresso para mostrar. O Premiumize reporta "0 Bytes of 0 Bytes" com
// capitalização variável; o par costuma aparecer como "0 peers"/"0 peer(s)".
const STALLED_TRANSFER = /0 bytes of 0 bytes|from 0 peer/i;

/**
 * Status das transferências do Premiumize para detecção de prontos, mortos e
 * parados. Uma transferência `running` com progresso ausente ou 0 e mensagem
 * atascada ("0 Bytes of 0 Bytes" ou "from 0 peer") não avança: se marca
 * `stalled:true` para que o recheck a conte com o próprio limite, em vez de
 * derrubá-la pela mesma via que um dead de 2 rechecks.
 */
async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const data = await call(apiKey, '/transfer/list');
  const transfers = Array.isArray(data?.transfers) ? data.transfers : [];
  const out: Record<string, TorrentStatusEntry> = {};
  for (const t of transfers) {
    const hash = transferHash(t);
    if (!hash) {
      // Não dá pra mapeá-la ao lote do recheck: não serve para saber se ficou
      // pronto nem para limpar. Contá-la torna visível que a conta arrasta
      // transferências órfãs que o ciclo nunca vai alcançar.
      metrics.count('debrid.pm.status.unmatched');
      continue;
    }
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
    out[hash] = { state, stalled, id: t?.id };
  }
  return out;
}

/**
 * Remove transferência pelo id no Premiumize.
 */
async function removeTorrent(apiKey: string, id: string | number) {
  try {
    const body = new URLSearchParams({ id: String(id) });
    await call(apiKey, '/transfer/delete', { method: 'POST', body });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Quando cada hash foi visto parado pela primeira vez.
 *
 * O `/transfer/list` do Premiumize não devolve data nenhuma — não há campo de
 * criação, só `status`, `progress` e `message` (confirmado na API: as chaves
 * são file_id, folder_id, id, message, name, other_cloud_id, progress, src,
 * status). Sem carimbo de tempo, `minAgeMs` não tem de onde ser calculado, e
 * apagar na primeira observação mataria justamente a transferência recém-criada
 * pelo autofetch — que nasce em "0 Bytes of 0 Bytes, from 0 peer" enquanto
 * procura pares.
 *
 * O `held` já protege esse caso, mas vive em memória e some no restart. Este
 * mapa reconstrói a idade por observação: a primeira varredura anota, e só uma
 * varredura posterior, passado `minAgeMs`, remove. É a mesma dupla observação
 * que o recheck exige antes de matar um torrent.
 */
const stallSeenAt = new Map<string, number>();

/**
 * Varre da conta as transferências terminais e as paradas de vez.
 *
 * Existe porque o recheck só alcança o que está num lote vivo: `recheckLots`
 * é de memória e o restart o zera, então transferência enfileirada por um
 * processo anterior fica parada para sempre, ocupando vaga da conta e nunca
 * sendo reavaliada por ninguém. Roda no boot e a cada `sweepDeadIntervalMs`.
 */
async function sweepDead(apiKey: string, { minAgeMs = config.debrid.sweepDeadMinAgeMs } = {}) {
  const account = accountScope(apiKey);
  const data = await call(apiKey, '/transfer/list');
  const transfers = Array.isArray(data?.transfers) ? data.transfers : [];
  const idade = Math.max(0, Number(minAgeMs) || 0);
  const agora = Date.now();

  const alvo: any[] = [];
  const vistosAgora = new Set<string>();
  for (const t of transfers) {
    if (t?.id == null) continue;
    const status = String(t?.status || '').toLowerCase();

    // Erro é terminal: some independente de hash, idade ou proteção.
    if (status === 'error') {
      alvo.push(t);
      continue;
    }
    if (status !== 'running') continue;

    const progress = Number(t?.progress);
    const moving = Number.isFinite(progress) && progress !== 0;
    if (moving || !STALLED_TRANSFER.test(String(t?.message || ''))) continue;

    // Parada, mas só removível quando dá para provar que não é do autofetch
    // em curso. Sem hash não há como consultar o `held` — e é justamente a
    // transferência sem metadata resolvida que carrega o hash no `name`.
    const hash = transferHash(t);
    if (!hash || held.isHeld(hash, account)) continue;

    vistosAgora.add(hash);
    const desde = stallSeenAt.get(hash);
    if (desde == null) {
      stallSeenAt.set(hash, agora);
      continue;
    }
    if (agora - desde >= idade) alvo.push(t);
  }

  // Quem voltou a andar (ou saiu da conta) perde o histórico de parada.
  for (const hash of stallSeenAt.keys()) {
    if (!vistosAgora.has(hash)) stallSeenAt.delete(hash);
  }

  if (!alvo.length) return { varridos: 0, falhas: 0, observados: vistosAgora.size };

  let ok = 0;
  let falhas = 0;
  for (const t of alvo) {
    if (await removeTorrent(apiKey, t.id)) {
      ok += 1;
      const hash = transferHash(t);
      if (hash) stallSeenAt.delete(hash);
    } else {
      falhas += 1;
    }
  }

  metrics.count('debrid.swept', ok);
  const sufixo = falhas ? ` — ${falhas} falhou(ram)` : '';
  log.info(`[premiumize] varredura: ${ok}/${alvo.length} transferência(s) morta(s) ou parada(s) removida(s)${sufixo}`);
  return { varridos: ok, falhas, observados: vistosAgora.size };
}

/** Só para teste: a memória de paradas é de processo. */
function resetStallMemory() {
  stallSeenAt.clear();
}

export const id = 'premiumize';
export const label = 'Premiumize';
export const short = 'PM';
// Lote instantâneo que não escreve na conta (TorBox também; AllDebrid mede
// via upload). Sem isso o orquestrador trata todos como "não sei".
export const cacheCheck = true;
export const keyUrl = 'https://www.premiumize.me/account';
export { enqueue, accountStatus, checkCached, resolveLink, torrentStatus, removeTorrent, sweepDead, resetStallMemory };
