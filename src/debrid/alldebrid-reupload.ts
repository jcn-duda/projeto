// Anti-reenchimento da conta AllDebrid (Fase 8, item 8.14).
//
// A checagem de cache da AllDebrid É um /magnet/upload. A limpeza intencional
// (sweepUndubbed, catálogo/painel) apaga um gringo e, 15 minutos depois, a
// busca seguinte re-sobe o MESMO hash só de perguntar se ele está em cache —
// a limpeza vira esteira eterna (o davail positivo dura 900s; o interesse de
// busca dura dias). O registro durável "apagado de propósito, não re-subir"
// fecha isso SEM tocar o ⚡: ele não é davail=1, não mente quando a AllDebrid
// recicla inativos, e cobre até o gringo que nunca esteve em cache.
//
// O que o marcador NÃO é, de propósito:
//   - filtro de stream: ele tira o hash do UPLOAD (checagem e enqueue), nunca
//     do play explícito — escolha do usuário vence o marcador;
//   - condenação: expira em dias (ALLDEBRID_REUPLOAD_BLOCK_TTL_MS) e tem
//     expurgo (`scripts/clean-undubbed.js --unblock <hash>`);
//   - blindagem de acervo invertida: `brOriginMark` (8.4) NUNCA grava — se o
//     nome denuncia origem BR, o hash segue re-subível, pois um falso positivo
//     aqui esconderia para sempre o acervo que a limpeza errou ao apagar.
//
// Namespace `adrm:v1:<accountScope>:<hash>` (sem adapter na chave de propósito:
// só o AllDebrid marca, e leitura de outra conta não encontra registro). A
// leitura usa `cache.peek` — sonda síncrona, sem promover LRU nem contar
// hit/miss: o prazo da busca não pode pagar nada por esta consulta.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as metrics from '../utils/metrics.js';
import { brOriginMark } from '../utils/br-origin.js';

const adrmPrefix = prefix('adrm');

interface ReuploadBlock {
  at: number;
  /** Nome da release apagada, truncado — só diagnóstico do operador. */
  name?: string;
}

function key(account: string, hash: string) {
  return `${adrmPrefix}${String(account || '')}:${String(hash || '').toLowerCase()}`;
}

/** Kill-switch E TTL: qualquer um zerado desliga gravação e leitura. */
function enabled(): boolean {
  return config.debrid.reuploadBlock && config.debrid.alldebridReuploadBlockTtlMs > 0;
}

/**
 * O hash está bloqueado para re-upload NESTA conta? Leitura limpa (peek):
 * nunca rede, nunca efeito no cache. Adaptador não-AllDebrid não tem quem
 * marque, então a resposta é sempre false lá — a consulta é um peek de Map.
 */
function reuploadBlocked(account: string, hash: string): boolean {
  if (!enabled() || !account) return false;
  const h = String(hash || '').toLowerCase();
  if (!h) return false;
  return cache.peek(key(account, h)) != null;
}

/**
 * Marca o hash como "apagado de propósito, não re-subir". Só chamado de
 * pontos de deleção INTENCIONAL (sweepUndubbed, catálogo/painel) e só com o
 * hash que saiu de verdade da conta — falha de delete não marca (o magnet
 * continua lá, e o marcador o esconderia da checagem à toa). Idempotente:
 * remarcar renova o TTL. Devolve true quando o registro foi gravado — false
 * nos no-ops (kill-switch, hash vazio) e na blindagem de origem BR.
 */
function markReuploadBlocked(account: string, hash: string, filename?: string): boolean {
  if (!enabled() || !account) return false;
  const h = String(hash || '').toLowerCase();
  if (!h) return false;
  // Blindagem 8.4 no caminho de escrita: origem BR no nome NUNCA marca. O
  // erro certo aqui é ABSOLVER (o pior caso é o lixo ser re-subido e a
  // limpeza pegá-lo de novo de lá a alguns dias) — nunca condenar um hash BR.
  if (brOriginMark(filename)) {
    metrics.count('debrid.reupload.skippedBr');
    return false;
  }
  const registro: ReuploadBlock = { at: Date.now() };
  const nome = String(filename || '').trim();
  if (nome) registro.name = nome.slice(0, 160);
  cache.set(key(account, h), registro, Math.floor(config.debrid.alldebridReuploadBlockTtlMs / 1000));
  metrics.count('debrid.reupload.marked');
  return true;
}

/** Expurgo do marcador (script operacional e testes). Idempotente, sem erro. */
function forgetReuploadBlock(account: string, hash: string): void {
  if (!account) return;
  const h = String(hash || '').toLowerCase();
  if (!h) return;
  cache.forget(key(account, h));
}

/**
 * Partição ANTES do /magnet/upload: só o não bloqueado vai à rede. O bloqueado
 * fica FORA do Set de cache (vazio conhecido é intencional — o hash foi
 * apagado de propósito) e conta a métrica de re-entrada evitada. `send`
 * preserva a ordem e os duplicados do chamador; só filtra.
 */
function filterReuploadBlocked(account: string, hashes: string[]): { send: string[]; blocked: string[] } {
  const send: string[] = [];
  const blocked: string[] = [];
  if (!enabled() || !account) return { send: [...(hashes || [])], blocked };
  for (const hash of hashes || []) {
    if (reuploadBlocked(account, hash)) {
      blocked.push(String(hash).toLowerCase());
      metrics.count('debrid.reupload.blocked');
    } else {
      send.push(hash);
    }
  }
  return { send, blocked };
}

export { reuploadBlocked, markReuploadBlocked, forgetReuploadBlock, filterReuploadBlocked };
