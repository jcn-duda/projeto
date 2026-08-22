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

// O cache não oferece scan por prefixo (e fazê-lo só para o painel seria caro).
// Mantemos a parte observada neste processo para indicar o tamanho aproximado
// de cada lado; reinício zera a amostra, sem afetar nenhuma decisão de busca.
const tracked = new Map<string, { side: 'alive' | 'bad' | 'lie'; expiresAt: number }>();

function track(key: string, side: 'alive' | 'bad' | 'lie', ttlSeconds: number) {
  if (ttlSeconds <= 0) return;
  tracked.set(key, { side, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function trackedSizes() {
  const now = Date.now();
  let alive = 0;
  let bad = 0;
  let lie = 0;
  for (const [key, item] of tracked) {
    if (item.expiresAt <= now) {
      tracked.delete(key);
      continue;
    }
    if (item.side === 'alive') alive += 1;
    else if (item.side === 'bad') bad += 1;
    else lie += 1;
  }
  return { alive, bad, lie };
}

function aliveKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('mag')}alive:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
}

function badKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('mag')}bad:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
}

function lieKey(adapterId: string, apiKey: string, hash: string) {
  return `${prefix('mag')}lie:${adapterId}:${accountScope(apiKey)}:${String(hash || '').toLowerCase()}`;
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
  for (const write of writes) track(write.key, 'alive', ttl);
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
 *
 * bad VENCE sobre alive: as janelas de TTL são distintas (24h contra 7 dias),
 * então os dois podem coexistir no mesmo hash — e aí o comportamento seria
 * indefinido (o filtro pré-checagem corta, mas o instantSet já o empurrou ao
 * topo do sort, gastando uma vaga do pool de candidatos). Evidência mais
 * recente e específica (play sem vídeo depois da confirmação de cache) manda.
 */
function markBad(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.badTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  const key = badKey(adapterId, apiKey, hash);
  cache.set(key, 1, ttl);
  // O alive não pode sobreviver ao bad no mesmo hash: sem o forget ele
  // continuaria desempatando o sort por até 7 dias num magnet que provou
  // estar quebrado.
  const alive = aliveKey(adapterId, apiKey, String(hash || '').toLowerCase());
  cache.forget(alive);
  tracked.delete(alive);
  track(key, 'bad', ttl);
  metrics.count('magnetdb.bad.set');
}

function isBad(adapterId: string, apiKey: string, hash: string) {
  if (!config.magnetDb.enabled || !adapterId || !apiKey || !hash) return false;
  return cache.get(badKey(adapterId, apiKey, hash)) === 1;
}

/** Há vídeo, mas o post prometeu áudio PT e os arquivos provaram release EN. */
function markLie(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.lieTtl;
  if (!config.magnetDb.enabled || !config.magnetDb.lieEnabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  const key = lieKey(adapterId, apiKey, hash);
  cache.set(key, 1, ttl);
  track(key, 'lie', ttl);
  metrics.count('magnetdb.lie.set');
}

function isLie(adapterId: string, apiKey: string, hash: string) {
  if (!config.magnetDb.enabled || !config.magnetDb.lieEnabled || !adapterId || !apiKey || !hash) return false;
  return cache.get(lieKey(adapterId, apiKey, hash)) === 1;
}

/**
 * Renovação ECONÔMICA para o atalho do davail: regrava só o hash cujo alive
 * está na segunda metade do TTL. O hit do L1 não é evidência nova — é a mesma
 * confirmação de antes —, e regravar o histórico inteiro em todo hit de título
 * popular virava escrita recorrente sem ganho: quem está no começo do TTL de
 * 7 dias desempata igual. Entrada sem registro (expirou) também renova — o
 * davail acabou de confirmar o positivo; hash com `bad` NÃO renova (bad vence,
 * e a renovação não pode ressuscitá-lo pela janela do davail).
 */
function renewAlive(adapterId: string, apiKey: string, hashes: string[]) {
  const ttl = config.magnetDb.aliveTtl;
  if (!config.magnetDb.enabled || ttl <= 0 || !adapterId || !apiKey) return;
  const stale = [...new Set(hashes.map((h) => String(h || '').toLowerCase()))].filter((hash) => {
    if (!hash || isBad(adapterId, apiKey, hash)) return false;
    const remaining = cache.peekRemaining(aliveKey(adapterId, apiKey, hash));
    return remaining == null || remaining < ttl / 2;
  });
  markAlive(adapterId, apiKey, stale);
}

/** Estado de diagnóstico; tamanhos são da amostra observada neste processo. */
function status() {
  const sizes = trackedSizes();
  const counters = metrics.snapshot().counters;
  return {
    enabled: config.magnetDb.enabled,
    aliveTtlSeconds: config.magnetDb.aliveTtl,
    badTtlSeconds: config.magnetDb.badTtl,
    lieTtlSeconds: config.magnetDb.lieTtl,
    sizeAlive: sizes.alive,
    sizeBad: sizes.bad,
    sizeLie: sizes.lie,
    counters: {
      aliveSet: counters['magnetdb.alive.set'] || 0,
      badSet: counters['magnetdb.bad.set'] || 0,
      lieSet: counters['magnetdb.lie.set'] || 0,
      dropped: counters['magnetdb.dropped'] || 0,
      droppedBad: counters['magnetdb.dropped.bad'] || 0,
      droppedDead: counters['magnetdb.dropped.dead'] || 0,
      droppedLie: counters['magnetdb.dropped.lie'] || 0,
    },
  };
}

export { markAlive, isAlive, markBad, isBad, markLie, isLie, renewAlive, status };
