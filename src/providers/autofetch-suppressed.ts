// Fila do que a remoção automática deixou de apagar.
//
// Quando o gate barra uma remoção (transferência identificada só pelo id, com
// `DEBRID_REMOVE_BY_ID` desligado), o recheck segue em frente: blacklista o
// hash, solta os holds e tira o hash do lote. Sem registro nenhum, aquele hash
// NUNCA mais é revisitado — e ligar o knob depois não alcançaria nada do que
// se acumulou enquanto ele esteve desligado, que era exatamente o fluxo
// prometido ("leia os contadores e então ligue").
//
// Este módulo guarda hash + id da transferência num registro durável para que
// a virada do knob seja retroativa. É deliberadamente separado do marker: o
// marker diz "já submetemos isto", este diz "isto deveria ter sido apagado".
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { DebridAdapter } from '../../types/domain.js';

const SUP_PREFIX = `${prefix('autofetch')}sup:`;

function suppressedKey(adapterId: string, account: string, infoHash: string) {
  return `${SUP_PREFIX}${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

/** Registra uma remoção barrada pelo gate. Sem id não há o que apagar depois. */
function noteSuppressed(
  adapterId: string,
  account: string,
  infoHash: string,
  transferId: string | number | null | undefined,
  ttlSeconds = config.debrid.autoFetchDeadTtl,
) {
  if (!adapterId || !account || !infoHash) return;
  if (transferId == null || transferId === '') return;
  cache.set(
    suppressedKey(adapterId, account, infoHash),
    { id: String(transferId), at: Date.now() },
    ttlSeconds,
  );
}

function listSuppressed(adapterId: string, account: string): Array<{ hash: string; id: string }> {
  const escopo = `${SUP_PREFIX}${adapterId}:${account}:`;
  const out: Array<{ hash: string; id: string }> = [];
  for (const key of cache.keysMatching(escopo)) {
    const value = cache.get(key) as { id?: unknown } | null;
    if (!value || typeof value !== 'object' || value.id == null) continue;
    out.push({ hash: key.slice(escopo.length), id: String(value.id) });
  }
  return out;
}

function forgetSuppressed(adapterId: string, account: string, infoHash: string) {
  cache.forget(suppressedKey(adapterId, account, infoHash));
}

/** Quantos registros aguardam a virada do knob (leitura de painel/diagnóstico). */
function countSuppressed(adapterId: string, account: string) {
  return listSuppressed(adapterId, account).length;
}

/**
 * Aplica o atraso: com o knob LIGADO, apaga o que ficou para trás.
 *
 * Falha de remoção NÃO esquece o registro — a transferência pode ter sumido por
 * outro caminho e a próxima passagem confirma, e o TTL (autoFetchDeadTtl)
 * garante que um id permanentemente ruim não fique tentando para sempre.
 */
async function drainSuppressed(adapter: DebridAdapter, apiKey: string, account: string) {
  if (!config.debrid.removeById) return 0;
  if (typeof adapter.removeTorrent !== 'function') return 0;
  const pendentes = listSuppressed(adapter.id, account);
  if (pendentes.length === 0) return 0;
  let apagados = 0;
  for (const { hash, id } of pendentes) {
    const ok = await adapter.removeTorrent(apiKey, id).catch(() => false);
    if (!ok) continue;
    forgetSuppressed(adapter.id, account, hash);
    metrics.count('autofetch.suppressed.drained');
    apagados += 1;
  }
  if (apagados > 0) {
    log.info(`[autofetch] remoção por id ligada: ${apagados} transferência(s) represada(s) apagada(s)`);
  }
  return apagados;
}

export { noteSuppressed, listSuppressed, forgetSuppressed, countSuppressed, drainSuppressed };
