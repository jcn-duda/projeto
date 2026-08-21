// Banco de magnets: memória durável POR HASH, escopada por serviço+conta.
//
// Diferente do davail (cache de disponibilidade de TTL curto que responde ao
// checkCached por minutos), isto é o HISTÓRICO de longo prazo: sobrevive dias,
// atravessa buscas e usuários diferentes da mesma conta, e alimenta duas
// decisões na listagem — descartar o que provou estar quebrado e desempatar a
// ordem a favor do que provou tocar na hora.
//
// Regra de ouro: só evidência MEDIDA entra, nunca palpite. Falso negativo é
// pior que falso positivo — descartar um magnet bom esconde stream do usuário.
// Por isso:
// - `alive` nasce de confirmação do debrid (checagem de cache) ou de play que
//   resolveu de verdade no /resolve;
// - `bad` nasce apenas de falha DETERMINÍSTICA do play (torrent sem nenhum
//   arquivo de vídeo). Erro transitório (rede, auth, quota, rate) não grava
//   nada; falha de escolha de arquivo (WorkPickError/EpisodePickError) também
//   não — o pack pode servir outra obra/episódio.
import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import { accountScope } from './request-key.js';
import { prefix } from './cache-keys.js';

function aliveKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('mag')}alive:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
}

function badKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('mag')}bad:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
}

/**
 * Grava em lote que os hashes tocariam na hora nesta conta. Chamado quando a
 * checagem de cache do debrid confirma o positivo e quando o /resolve devolve
 * link de verdade. Regravar um hash já vivo só renova o TTL.
 */
function markAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  const writes = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))]
    .filter(Boolean)
    .map((hash) => ({ key: aliveKey(adapterId, apiKey, hash), value: 1, ttlSeconds: ttl }));
  if (writes.length === 0) return;
  cache.setMany(writes);
  metrics.count('magnetdb.alive.set', writes.length);
}

function isAlive(adapterId: string, apiKey: string, hash: string) {
  if (!config.magnetDb.enabled || !adapterId || !apiKey || !hash) return false;
  return cache.get(aliveKey(adapterId, apiKey, hash)) === 1;
}

/**
 * Grava que o hash provou estar quebrado nesta conta (torrent sem arquivo de
 * vídeo no play). TTL próprio: torrent pode ganhar upload novo, então o
 * negativo também envelhece.
 */
function markBad(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.badTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  cache.set(badKey(adapterId, apiKey, hash), 1, ttl);
  metrics.count('magnetdb.bad.set');
}

function isBad(adapterId: string, apiKey: string, hash: string) {
  if (!config.magnetDb.enabled || !adapterId || !apiKey || !hash) return false;
  return cache.get(badKey(adapterId, apiKey, hash)) === 1;
}

export { markAlive, isAlive, markBad, isBad };
