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
type MagnetSide = 'alive' | 'bad' | 'lie';

type TrackedMagnet = {
  adapterId: string;
  side: MagnetSide;
  expiresAt: number;
};

type MagnetSizes = { alive: number; bad: number; lie: number };
type TtlRemaining = { alive: number | null; bad: number | null; lie: number | null };

export type MagnetDbAdapterStatus = {
  sizeAlive: number;
  sizeBad: number;
  sizeLie: number;
  // Média da amostra observada; não representa entradas persistidas antes do
  // processo atual e nunca expõe o escopo (digest) da conta.
  ttlRemainingSeconds: TtlRemaining;
};

export type MagnetDbStatus = {
  enabled: boolean;
  aliveTtlSeconds: number;
  badTtlSeconds: number;
  lieTtlSeconds: number;
  sizeAlive: number;
  sizeBad: number;
  sizeLie: number;
  ttlRemainingSeconds: TtlRemaining;
  byAdapter: Record<string, MagnetDbAdapterStatus>;
  counters: {
    aliveSet: number;
    badSet: number;
    lieSet: number;
    dropped: number;
    droppedBad: number;
    droppedDead: number;
    droppedLie: number;
    badClearedBlocked: number;
  };
};

const tracked = new Map<string, TrackedMagnet>();

function track(key: string, adapterId: string, side: MagnetSide, ttlSeconds: number) {
  if (ttlSeconds <= 0) return;
  tracked.set(key, { adapterId, side, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function emptySizes(): MagnetSizes {
  return { alive: 0, bad: 0, lie: 0 };
}

function trackedStatus() {
  const now = Date.now();
  const sizes = emptySizes();
  const ttlTotals = { alive: 0, bad: 0, lie: 0 };
  const byAdapter: Record<string, { sizes: MagnetSizes; ttlTotals: Record<MagnetSide, number> }> = Object.create(null);
  for (const [key, item] of tracked) {
    if (item.expiresAt <= now) {
      tracked.delete(key);
      continue;
    }
    const remaining = Math.max(0, item.expiresAt - now);
    sizes[item.side] += 1;
    ttlTotals[item.side] += remaining;
    if (!byAdapter[item.adapterId]) {
      byAdapter[item.adapterId] = { sizes: emptySizes(), ttlTotals: { alive: 0, bad: 0, lie: 0 } };
    }
    byAdapter[item.adapterId].sizes[item.side] += 1;
    byAdapter[item.adapterId].ttlTotals[item.side] += remaining;
  }
  const ttlRemaining = (counts: MagnetSizes, totals: Record<MagnetSide, number>): TtlRemaining => ({
    alive: counts.alive ? Math.ceil(totals.alive / counts.alive / 1000) : null,
    bad: counts.bad ? Math.ceil(totals.bad / counts.bad / 1000) : null,
    lie: counts.lie ? Math.ceil(totals.lie / counts.lie / 1000) : null,
  });
  const adapters: Record<string, MagnetDbAdapterStatus> = Object.create(null);
  for (const adapterId of Object.keys(byAdapter)) {
    const item = byAdapter[adapterId];
    adapters[adapterId] = {
      sizeAlive: item.sizes.alive,
      sizeBad: item.sizes.bad,
      sizeLie: item.sizes.lie,
      ttlRemainingSeconds: ttlRemaining(item.sizes, item.ttlTotals),
    };
  }
  return { sizes, ttlRemainingSeconds: ttlRemaining(sizes, ttlTotals), byAdapter: adapters };
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
  for (const write of writes) track(write.key, adapterId, 'alive', ttl);
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
  track(key, adapterId, 'bad', ttl);
  metrics.count('magnetdb.bad.set');
}

function isBad(adapterId: string, apiKey: string, hash: string) {
  if (!config.magnetDb.enabled || !adapterId || !apiKey || !hash) return false;
  return cache.get(badKey(adapterId, apiKey, hash)) === 1;
}

/**
 * Esquece um registro `bad` (e a amostra local), SEM tocar em alive/lie do
 * mesmo hash. É a função do REPARO do dano do F3: um ramo antigo do warmer
 * marcava `bad` no hash cuja resposta era `blocked` — recusa legal
 * (HTTP 451/error_code 35) do Real-Debrid, não magnet quebrado. Recusa legal
 * não grava `blocked` no magnetdb, e NoVideoError legítimo não grava blocked
 * no ledger; portanto `bad + blocked` por definição é aquela escrita
 * equivocada e pode ser desfeita com segurança. Retorna true se havia um
 * registro para apagar.
 */
function forgetBad(adapterId: string, apiKey: string, hash: string): boolean {
  return forgetBadKey(badKey(adapterId, apiKey, hash));
}

/**
 * Apaga um `bad` pela chave crua (usada pela varredura de reparo que enumera
 * o L1 por prefixo de adapter). Idempotente: segunda passada devolve false
 * porque a chave já não existe. `alive`/`lie` do mesmo hash não são tocados.
 */
function forgetBadKey(key: string): boolean {
  const existed = cache.peek(key) != null;
  cache.forget(key);
  tracked.delete(key);
  return existed;
}

/** Há vídeo, mas o post prometeu áudio PT e os arquivos provaram release EN. */
function markLie(adapterId: string, apiKey: string, hash: string) {
  const ttl = config.magnetDb.lieTtl;
  if (!config.magnetDb.enabled || !config.magnetDb.lieEnabled || ttl <= 0 || !adapterId || !apiKey || !hash) return;
  const key = lieKey(adapterId, apiKey, hash);
  cache.set(key, 1, ttl);
  track(key, adapterId, 'lie', ttl);
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
function status(): MagnetDbStatus {
  const trackedState = trackedStatus();
  const sizes = trackedState.sizes;
  const counters = metrics.snapshot().counters;
  return {
    enabled: config.magnetDb.enabled,
    aliveTtlSeconds: config.magnetDb.aliveTtl,
    badTtlSeconds: config.magnetDb.badTtl,
    lieTtlSeconds: config.magnetDb.lieTtl,
    sizeAlive: sizes.alive,
    sizeBad: sizes.bad,
    sizeLie: sizes.lie,
    ttlRemainingSeconds: trackedState.ttlRemainingSeconds,
    byAdapter: trackedState.byAdapter,
    counters: {
      aliveSet: counters['magnetdb.alive.set'] || 0,
      badSet: counters['magnetdb.bad.set'] || 0,
      lieSet: counters['magnetdb.lie.set'] || 0,
      dropped: counters['magnetdb.dropped'] || 0,
      droppedBad: counters['magnetdb.dropped.bad'] || 0,
      droppedDead: counters['magnetdb.dropped.dead'] || 0,
      droppedLie: counters['magnetdb.dropped.lie'] || 0,
      badClearedBlocked: counters['magnetdb.bad.clearedBlocked'] || 0,
    },
  };
}

export { markAlive, isAlive, markBad, isBad, forgetBad, forgetBadKey, markLie, isLie, renewAlive, status };
