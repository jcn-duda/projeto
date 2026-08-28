/**
 * Cache multi-nível do addon — ponto de entrada (padrão barrel §5.1/§5.3).
 *
 * A implementação vive em módulos irmãos, sem ciclo:
 * - cache-quotas.ts: política PURA de cotas/evicção (constantes + funções que
 *   recebem o estado como parâmetro);
 * - cache-db.ts: fábrica da persistência SQLite (L2) — handle, statements,
 *   fila de despejo e flush nascem na closure desta instância;
 * - cache.ts (este): dono de TODO o estado mutável (L1, contadores, L2 da
 *   instância) + API pública com os MESMOS nomes de export de antes da
 *   divisão — nenhum consumidor mudou. O estado morar aqui não é detalhe:
 *   os testes de cache recarregam o módulo com query string para nascer
 *   limpo, e estado em irmão importado sem query vazaria entre instâncias.
 */
import * as metrics from './metrics.js';
import {
  MAX_ENTRIES, QUOTAS,
  namespaceFor, quotaFor, incrementNamespace as bumpNamespace, removeFromStore as dropFromStore, quotaOverflow,
} from './cache-quotas.js';
import { createPersistence } from './cache-db.js';

const store = new Map();
const namespaceCounts = new Map();

const persistence = createPersistence();
const pending = persistence.pending;
const maxGraceMs = persistence.maxGraceMs;
const maintain = persistence.maintain;

const removeFromStore = (key: string) => dropFromStore(store, namespaceCounts, key);
const incrementNamespace = (namespace: string) => bumpNamespace(namespaceCounts, namespace);
const l1Hooks = { store, removeFromStore, incrementNamespace };

let pruneTimer: ReturnType<typeof setInterval> | null = null;

function evict(keys: string[]) {
  for (const key of keys) {
    // A cota cheia é o estado normal de um namespace quente. `cache.evicted`
    // fica reservado ao teto global, para continuar alertando só pressão real
    // de memória; o detalhamento mostra qual balde está girando.
    metrics.count('cache.evicted.quota');
    metrics.count(`cache.evicted.quota.${namespaceFor(key)}`);
  }
  forgetMany(keys);
}

function prune() {
  const now = Date.now();
  // Expirado dentro da janela de graça do SWR fica: o próximo getWithStale
  // ainda o serve enquanto o refresh de fundo revalida. O corte duro vale só
  // para o que passou da graça.
  const graceMs = maxGraceMs();
  // Acumula e apaga uma vez só: o disco é o caro, a memória não.
  const dropped: any[] = [];
  for (const [key, hit] of store) {
    if (hit.expiresAt && now > hit.expiresAt + graceMs) {
      dropped.push(key);
    }
  }
  // Sai do store AQUI, e não só no forgetMany do fim: o teto abaixo é
  // avaliado sobre store.size, e adiar a remoção tirava a condição de
  // parada do laço — ele repetia a mesma chave até o array estourar
  // (RangeError dentro de cache.set, derrubando a requisição).
  for (const key of dropped) removeFromStore(key);
  // Se ainda estourou o teto, descarta as entradas mais antigas (Map preserva ordem de inserção).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    removeFromStore(oldest);
    dropped.push(oldest);
    // Despejo por teto é o sinal de que MAX_ENTRIES ficou pequeno: subindo
    // sempre, o cache está jogando fora coisa que ainda seria usada.
    metrics.count('cache.evicted');
    metrics.count(`cache.evicted.${namespaceFor(oldest)}`);
  }
  forgetMany(dropped);
}

/** Para o /metrics.json: quanto do teto está ocupado agora. */
function size() {
  return store.size;
}

function snapshot() {
  const namespaces: Record<string, { entries: number; maxEntries: number }> = {};
  for (const [namespace, entries] of namespaceCounts) {
    namespaces[namespace] = { entries, maxEntries: quotaFor(namespace) };
  }
  return { entries: size(), maxEntries: MAX_ENTRIES, namespaces };
}

function get(key: string) {
  const hit = store.get(key);
  if (!hit) {
    // O contador por namespace diz QUAL balde está pagando rede de novo; o
    // global continua para as séries históricas que já existem no painel.
    metrics.count('cache.miss');
    metrics.count(`cache.miss.${namespaceFor(key)}`);
    return null;
  }
  if (hit.expiresAt && Date.now() > hit.expiresAt) {
    forget(key);
    // Expirado é miss para quem perguntou; o `expired` separado diz se o TTL
    // está curto demais para o ritmo de uso.
    metrics.count('cache.miss');
    metrics.count(`cache.miss.${hit.namespace}`);
    metrics.count('cache.expired');
    return null;
  }
  metrics.count('cache.hit');
  metrics.count(`cache.hit.${hit.namespace}`);
  // Map preserva inserção; mover o hit para o fim transforma o corte em LRU.
  removeFromStore(key);
  store.set(key, hit);
  incrementNamespace(hit.namespace);
  return hit.value;
}

/**
 * Leitura com janela de graça para stale-while-revalidate: dentro do TTL
 * devolve `{ value, stale: false }`; entre o TTL e `expiresAt + grace` devolve
 * `{ value, stale: true }` SEM apagar a entrada — o consumidor responde com
 * ela enquanto revalida em fundo; depois devolve null. O get() normal mantém a
 * semântica dura (expirou = apagou), por isso os dois convivem.
 */
function getWithStale(key: string, graceSeconds = 0) {
  const hit = store.get(key);
  if (!hit) {
    metrics.count('cache.miss');
    metrics.count(`cache.miss.${namespaceFor(key)}`);
    return null;
  }
  const now = Date.now();
  if (hit.expiresAt && now > hit.expiresAt) {
    if (now > hit.expiresAt + Math.max(0, graceSeconds) * 1000) {
      forget(key);
      metrics.count('cache.miss');
      metrics.count(`cache.miss.${hit.namespace}`);
      metrics.count('cache.expired');
      return null;
    }
    metrics.count('cache.hit');
    metrics.count(`cache.hit.${hit.namespace}`);
    // Contador próprio: o SWR só se paga se aparecer aqui. Hit stale que nunca
    // vira refresh seria lista velha eterna sem nenhum sinal no painel.
    metrics.count('cache.stale');
    return { value: hit.value, stale: true };
  }
  metrics.count('cache.hit');
  metrics.count(`cache.hit.${hit.namespace}`);
  removeFromStore(key);
  store.set(key, hit);
  incrementNamespace(hit.namespace);
  return { value: hit.value, stale: false };
}

function set(key: string, value: unknown, ttlSeconds: number) {
  setMany([{ key, value, ttlSeconds }]);
}

/**
 * Segundos restantes da entrada, SEM promovê-la no LRU nem contar métrica —
 * leitura de sondagem, para o consumidor decidir se vale regravar. Expirada ou
 * ausente devolve null; entrada sem TTL também (não há o que renovar).
 */
function peekRemaining(key: string): number | null {
  const hit = store.get(key);
  if (!hit || !hit.expiresAt) return null;
  if (Date.now() > hit.expiresAt) return null;
  return Math.max(0, Math.round((hit.expiresAt - Date.now()) / 1000));
}

/**
 * Leitura SEM efeito: devolve o valor se ainda válido, sem promover o LRU (o
 * Map preserva a posição de recência) e sem contar `cache.hit`/`cache.miss`.
 * Para sondas que só querem LER e decidir depois se escrevem — ex: a promoção
 * de ⚡ do rd-probe reescreve via `set`, que aí sim promove e renova o TTL com
 * `peekRemaining`, então a varredura sem match não pode inflar os contadores
 * do painel nem reordenar o cache. Expirada/ausente devolve null (não apaga).
 */
function peek(key: string): unknown {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt && Date.now() > hit.expiresAt) return null;
  return hit.value;
}

/**
 * Escrita em LOTE com UMA passada de evicção por namespace. O `set` unitário
 * já dava conta dos consumidores antigos; o davail escreve um registro por
 * hash da busca no caminho de resposta, e em saturação de cota cada `set`
 * pagava um scan do store global mais uma transação SQLite (fsync) pela
 * vítima — o custo por chave que os comentários de persistência/forgetMany
 * dizem que só é aceitável em lote. Aqui o excesso do namespace inteiro é
 * calculado depois de todas as inserções: mesmo critério de vítima (as mais
 * antigas do LRU continuam na frente), uma transação só.
 */
function setMany(entries: { key: string; value: unknown; ttlSeconds: number }[]) {
  const valid = entries.filter((e) => e.ttlSeconds && e.ttlSeconds > 0);
  if (valid.length === 0) return;
  const namespaces = new Set<string>();
  for (const { key, value, ttlSeconds } of valid) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const namespace = namespaceFor(key);
    removeFromStore(key); // reinsere no fim para a ordem refletir o uso mais recente
    store.set(key, { value, expiresAt, namespace });
    incrementNamespace(namespace);
    persist(key, value, expiresAt);
    namespaces.add(namespace);
  }
  for (const namespace of namespaces) {
    const quotaDropped = quotaOverflow(store, namespaceCounts, namespace);
    if (quotaDropped.length) evict(quotaDropped);
  }
  if (store.size > MAX_ENTRIES) prune();
}

function forget(key: string) {
  persistence.forget(key, removeFromStore);
}

function forgetMany(keys: string[]) {
  persistence.forgetMany(keys, removeFromStore);
}

function persist(key: string, value: unknown, expiresAt: number) {
  persistence.persist(key, value, expiresAt);
}

function clear() {
  store.clear();
  namespaceCounts.clear();
  // Antes do truncate, senão o despejo agendado reescreveria o banco limpo.
  pending.clear();
  persistence.clearDisk();
}

/** Remove só o namespace pedido, sem esfriar os outros baldes. */
function clearNamespace(namespace: string) {
  const wanted = String(namespace || '');
  if (!wanted) return 0;
  return clearWhere((key) => namespaceFor(key) === wanted);
}

/**
 * Limpeza seletiva para ações operacionais. A varredura é sobre o L1, que é a
 * fonte das leituras deste processo; forgetMany mantém L1, fila pendente e L2
 * coerentes na mesma operação.
 */
function clearWhere(matches: (key: string) => boolean) {
  const keys: string[] = [];
  for (const key of store.keys()) {
    if (matches(key)) keys.push(key);
  }
  forgetMany(keys);
  return keys.length;
}

/** Devolve todas as chaves do L1 que iniciam com o prefixo informado. */
function keysMatching(prefix: string): string[] {
  const result: string[] = [];
  const p = String(prefix || '');
  for (const key of store.keys()) {
    if (key.startsWith(p)) result.push(key);
  }
  return result;
}

/** Libera o L2 no encerramento; o L1 continua utilizável até o processo sair. */
function close() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  persistence.close();
}

persistence.open();
persistence.loadFromDisk(l1Hooks);
// Expirado ocupa linha no banco mesmo sem ninguém ler a chave.
pruneTimer = setInterval(prune, 10 * 60 * 1000);
pruneTimer.unref();

export {
  MAX_ENTRIES, QUOTAS, get, getWithStale, set, setMany, forget, forgetMany,
  prune, clear, clearNamespace, clearWhere, keysMatching, size, snapshot, peek, peekRemaining, maintain, close,
};
