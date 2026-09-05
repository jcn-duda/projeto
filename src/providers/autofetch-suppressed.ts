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
//
// `via` descreve o CANAL de identificação, não a confiança: o `id` vem do
// nosso próprio marker de enqueue (src/providers/autofetch-marker.ts) e é
// prova de primeira mão. O gate que barra a remoção por `via === 'id'` é um
// FREIO DE ROLLOUT, não um juízo sobre o id — a conta que a ponte acabou de
// tornar visível não pode ser exposta à primeira rodada destrutiva no mesmo
// deploy. A inversão de precedência do `1a0d38c` empurrou para esta fila até
// transferências que o `name` da listagem identificaria: o conjunto suprimido
// cresceu de propósito, e é ele que o knob desligado mantém observável.
//
// Vida do registro: TTL PRÓPRIO de 30 dias (`DEBRID_SUPPRESSED_TTL`), que cobre
// o tempo real de observação do operador — o antigo `autoFetchDeadTtl` (24h)
// expirava registro bom no meio da decisão. Aposentar um id ruim NÃO é mais
// papel do relógio: o drain falha com backoff exponencial (5min..6h) e desiste
// em 5 falhas consecutivas (`autofetch.suppressed.givenup`). Forma do registro
// `{ id, at, fails, nextAt }`; registro antigo verificado antes da Etapa 2
// (`{ id, at }`) lê como `fails: 0, nextAt: 0` — sempre elegível.
//
// O drain tem DUAS portas, e elas não são iguais:
// - O `drainSuppressed` automático do `runRecheck` NÃO passa `force`: respeita
//   o gate estático `config.debrid.removeById` e vira no-op com ele desligado
//   (o default). É o caminho que cobra o atraso APÓS o operador ligar o knob.
// - A ação do painel (destrutiva, com confirmação) passa `force: true` para
//   drenar SEM ligar o knob global — o fluxo executável do operador. `force`
//   só existe nesse chamador; nunca no automático. O `max` de FORA vence o
//   `suppressedDrainMax`; sem `max`, vale o default do config.
//
// VERDADE COMPLETA do gate: a cobertura da fila não é total. O ramo
// `expired-unready` do settle (autofetch-recheck.ts) remove por id DIRETO,
// sem passar por `podeRemover`/`noteSuppressed` — é uma exceção deliberada do
// gate (o que expira no settle é download que o próprio addon subiu e que
// nunca tocou no TTL de settle; não é acervo represado pelo freio). Essa
// exceção fica de fora desta fila DE PROPÓSITO: quem ler `countSuppressed` não
// pode prometer que a fila cobre toda transferência removida por id da conta.
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';
import config from '../config.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { DebridAdapter } from '../../types/domain.js';

const SUP_PREFIX = `${prefix('autofetch')}sup:`;

// Índice de processo das chaves `sup:` vivas. O painel (snapshot) e as ações de
// drain contam e varrem a fila a cada passagem; enumerar keysMatching do L1
// inteiro (até 84k) por poll seria O(L1) no caminho quente. Este Set espelha o
// que sobreviveu no cache, mantido pelas únicas operações que mudam o conjunto
// (note/forget/givenup) e reindexado no boot no padrão reindexDead do autofetch.
const knownSuppressed = new Set<string>();

// Backoff da reescrita por falha: base 5min dobra a cada falha. O cap de 6h é
// margem futura — com `GIVE_UP_AFTER = 5` a espera máxima real é 40min (2^3),
// pois na 5ª falha o registro é esquecido antes de agendar. Só seria alcançável
// com GIVE_UP_AFTER ≥ 8.
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_CAP_MS = 6 * 3600_000;
const GIVE_UP_AFTER = 5;

type SuppressedRead = {
  id: string;
  at: number;
  fails: number;
  nextAt: number;
};

/** Endereço do registro: também exportado para o teste inspecionar o estado. */
function suppressedKey(adapterId: string, account: string, infoHash: string) {
  return `${SUP_PREFIX}${adapterId}:${account}:${String(infoHash || '').toLowerCase()}`;
}

/**
 * Lê o registro SEM efeito (peek não promove o LRU nem conta métrica). Registro
 * antigo `{ id, at }` lê como `fails: 0, nextAt: 0` — mesma tolerância que o
 * markerValue tem com os `1` já gravados: registro sem os campos novos é um
 * represado que ainda não falhou.
 */
function readSuppressed(key: string): SuppressedRead {
  const stored = cache.peek(key) as { id?: unknown; at?: unknown; fails?: unknown; nextAt?: unknown } | null;
  if (!stored || typeof stored !== 'object' || stored.id == null) {
    return { id: '', at: 0, fails: 0, nextAt: 0 };
  }
  return {
    id: String(stored.id),
    at: typeof stored.at === 'number' ? stored.at : 0,
    fails: typeof stored.fails === 'number' && stored.fails > 0 ? Math.trunc(stored.fails) : 0,
    nextAt: typeof stored.nextAt === 'number' ? stored.nextAt : 0,
  };
}

/**
 * Registra uma remoção barrada pelo gate. Sem id não há o que apagar depois.
 * Reescrever preserva o TTL RESTANTE (peekRemaining): evento novo reseta o
 * backoff, mas um registro que já espera há 20 dias não renasce de 30 por um
 * re-note.
 */
function noteSuppressed(
  adapterId: string,
  account: string,
  infoHash: string,
  transferId: string | number | null | undefined,
  ttlSeconds = config.debrid.suppressedTtl,
) {
  if (!adapterId || !account || !infoHash) return;
  if (transferId == null || transferId === '') return;
  const key = suppressedKey(adapterId, account, infoHash);
  const restante = cache.peekRemaining(key);
  const ttl = restante != null && restante > 0 ? restante : ttlSeconds;
  cache.set(key, { id: String(transferId), at: Date.now(), fails: 0, nextAt: 0 }, ttl);
  knownSuppressed.add(key);
}

/** Leitura COMPLETA (com e sem elegibilidade), por adapter/conta. */
function listAllSuppressed(adapterId: string, account: string): Array<SuppressedRead & { hash: string }> {
  const escopo = `${SUP_PREFIX}${adapterId}:${account}:`;
  const out: Array<SuppressedRead & { hash: string }> = [];
  // Varredura do L1 pelo escopo (ex.: testes que semeiam via cache.set direto,
  // registros que o reindex do boot não pegou). O caminho quente do PAINEL
  // (agregado de todas as contas) usa o índice `knownSuppressed`; esta é a
  // leitura por conta, que age em passagens pontuais, não em poll.
  for (const key of cache.keysMatching(escopo)) {
    const rec = readSuppressed(key);
    if (!rec.id) continue;
    knownSuppressed.add(key);
    out.push({ hash: key.slice(escopo.length), ...rec });
  }
  return out;
}

/**
 * ELEGÍVEIS para o drain: registros cujo `nextAt` já passou (registro novo e o
 * legado `{ id, at }` nascem com nextAt 0 — sempre elegíveis).
 */
function listSuppressed(adapterId: string, account: string, agora = Date.now()) {
  return listAllSuppressed(adapterId, account).filter((reg) => reg.nextAt <= agora);
}

function forgetSuppressed(adapterId: string, account: string, infoHash: string) {
  const key = suppressedKey(adapterId, account, infoHash);
  knownSuppressed.delete(key);
  cache.forget(key);
}

/** Profundidade COMPLETA da fila de uma conta (painel: o que aguarda decisão). */
function countSuppressed(adapterId: string, account: string) {
  return listAllSuppressed(adapterId, account).length;
}

/** Agregado de TODAS as contas/adapters, sem varredura do L1: índice de processo. */
function countAllSuppressed(): number {
  let total = 0;
  for (const key of knownSuppressed) {
    if (cache.peekRemaining(key) == null) {
      knownSuppressed.delete(key);
      continue;
    }
    total += 1;
  }
  return total;
}

/**
 * Conta uma falha de remoção e agenda a próxima tentativa. A reescrita usa o
 * TTL restante — sem isso o id que falha toda passagem renasceria de 30 dias
 * em cada falha e nunca expiraria. Com `GIVE_UP_AFTER` falhas o registro é
 * esquecido e contado como `autofetch.suppressed.givenup`.
 */
function scheduleRetry(adapterId: string, account: string, reg: SuppressedRead & { hash: string }, agora: number) {
  const key = suppressedKey(adapterId, account, reg.hash);
  const ant = readSuppressed(key);
  // Registro sumido = outro ator (recheck de outro lote, porta do painel) já
  // liquidou a transferência antes de nós. Sem isso a falha do removeTorrent
  // sobre id já apagado recriava o registro com TTL cheio de 30d e o dado-up
  // queimava 4 tentativas num id morto.
  if (!ant.id) return;
  const fails = (ant.fails || 0) + 1;
  if (fails >= GIVE_UP_AFTER) {
    knownSuppressed.delete(key);
    cache.forget(key);
    metrics.count('autofetch.suppressed.givenup');
    return;
  }
  const espera = Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), BACKOFF_CAP_MS);
  const restante = cache.peekRemaining(key);
  const ttl = restante != null && restante > 0 ? restante : config.debrid.suppressedTtl;
  cache.set(key, { id: reg.id, at: ant.at || agora, fails, nextAt: agora + espera }, ttl);
}

/**
 * Aplica o atraso: drena o que ficou para trás.
 *
 * Duas portas: o automático do `runRecheck` NÃO passa `force` e respeita o gate
 * estático (`removeById`) — vira no-op com o knob desligado. A ação do painel
 * passa `force: true` para drenar sem ligar o knob global (fluxo executável do
 * operador). Teto por passagem: `opts.max` (default `config.debrid.suppressedDrainMax`)
 * e só os registros JÁ elegíveis — o que sobra volta na próxima passagem.
 * Falha de remoção NÃO esquece o registro: `scheduleRetry` agenda o backoff, e
 * o id permanente ruim é aposentado pelo givenup, nunca pelo relógio.
 */
type DrainSuppressedOpts = {
  max?: number;
  force?: boolean;
};

async function drainSuppressed(
  adapter: DebridAdapter,
  apiKey: string,
  account: string,
  opts?: DrainSuppressedOpts,
) {
  if (!config.debrid.removeById && !opts?.force) return 0;
  if (typeof adapter.removeTorrent !== 'function') return 0;
  const max = Math.max(
    1,
    Math.trunc(opts?.max && opts.max > 0 ? opts.max : config.debrid.suppressedDrainMax),
  );
  const agora = Date.now();
  const pendentes = listSuppressed(adapter.id, account, agora);
  if (pendentes.length === 0) return 0;
  let apagados = 0;
  for (const reg of pendentes.slice(0, max)) {
    const ok = await adapter.removeTorrent(apiKey, reg.id).catch(() => false);
    if (!ok) {
      scheduleRetry(adapter.id, account, reg, agora);
      continue;
    }
    forgetSuppressed(adapter.id, account, reg.hash);
    metrics.count('autofetch.suppressed.drained');
    apagados += 1;
  }
  if (apagados > 0) {
    log.info(`[autofetch] remoção por id ligada: ${apagados} transferência(s) represada(s) apagada(s)`);
  }
  return apagados;
}

/**
 * Reconstrói o índice de processo no boot: varre o L1 UMA vez (despesa única)
 * e espelha o que sobreviveu ao restart. Depois disso o conjunto só muda pelas
 * operações do próprio módulo — `countAllSuppressed` fica O(índice), não O(L1).
 */
function reindexSuppressed() {
  let n = 0;
  for (const key of cache.keysMatching(SUP_PREFIX)) {
    if (knownSuppressed.has(key)) continue;
    if (readSuppressed(key).id) {
      knownSuppressed.add(key);
      n += 1;
    }
  }
  if (n > 0) metrics.count('autofetch.suppressed.reindexed', n);
  return n;
}

reindexSuppressed();

export {
  noteSuppressed,
  listSuppressed,
  listAllSuppressed,
  forgetSuppressed,
  countSuppressed,
  countAllSuppressed,
  drainSuppressed,
  suppressedKey,
};