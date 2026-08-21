import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import * as log from './logger.js';
import * as metrics from './metrics.js';
import { NAMESPACE_VERSIONS, LEGACY_PREFIXES } from './cache-keys.js';

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const store = new Map();
// A soma das cotas conhecidas é 24.200. O teto global fica logo acima dela
// como proteção para prefixes novos, sem um namespace conhecido expulsar outro.
const MAX_ENTRIES = 25000;
const QUOTAS: Readonly<Record<string, number>> = Object.freeze({
  streams: 2000,
  dlmag: 4000,
  tmdb: 2000,
  meta: 2000,
  // Resultado bruto da busca por indexer/scraper: cada entrada pode chegar a
  // ~100 KB (teto de itens no config), então a cota fica bem abaixo das de
  // entrada minúscula — pior caso ~79 MB no L1.
  raw: 800,
  // Disponibilidade por hash é só 0/1; a cota alta evita reconsultar a mesma
  // conta em buscas diferentes sem ocupar a memória dos resultados brutos.
  davail: 5000,
  // Banco de magnets: histórico durável por hash (vivo/ruim), entrada
  // minúscula como o davail — a cota alta cobre contas com catálogo grande.
  mag: 8000,
  autofetch: 2000,
  'indexer-status': 200,
  __default: 500,
});
const namespaceCounts = new Map();

// Memória é o L1; o SQLite só existe pra sobreviver ao restart do container.
// Sem ele o addon funciona igual, só volta a esquentar do zero a cada subida.
const DB_PATH = process.env.CACHE_DB_PATH || path.join(__dirname, '..', '..', '..', 'data', 'cache.db');
let db: any = null;
let insertStmt: any = null;
let deleteStmt: any = null;
let deleteExpiredStmt: any = null;
let deleteStaleStmt: any = null;
let deleteLegacyStmt: any = null;
let selectIndexStmt: any = null;
let selectValueStmt: any = null;
let clearStmt: any = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function openDatabase() {
  if (process.env.CACHE_PERSIST === 'false') return null;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // node:sqlite é experimental no Node 22 — se o runtime não tiver, seguimos
    // só em memória em vez de derrubar o addon.
    const { DatabaseSync } = _require('node:sqlite');
    const database = new DatabaseSync(DB_PATH);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
    `);

    insertStmt = database.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
    deleteStmt = database.prepare('DELETE FROM cache WHERE key = ?');
    deleteExpiredStmt = database.prepare('DELETE FROM cache WHERE expires_at <= ?');
    // Descarte de versão obsoleta: apaga no banco o que não bate com a versão
    // corrente, sem materializar a linha. `<ns>:%` + NOT LIKE da versão viva
    // cobre tanto o formato `<ns>:<versão>:` quanto prefixos colados no nome.
    deleteStaleStmt = database.prepare('DELETE FROM cache WHERE key LIKE ? AND key NOT LIKE ?');
    deleteLegacyStmt = database.prepare('DELETE FROM cache WHERE key LIKE ?');
    // Índice leve: decide QUEM sobe sem trazer os valores gordos junto. Um LIMIT
    // global trocaria o problema de memória por um de correção (dlmag de TTL
    // longo consumiria o corte e empurraria streams para fora), então o valor é
    // buscado por PK só para as chaves que passaram na cota.
    selectIndexStmt = database.prepare('SELECT key, expires_at FROM cache ORDER BY expires_at DESC');
    selectValueStmt = database.prepare('SELECT value FROM cache WHERE key = ?');
    clearStmt = database.prepare('DELETE FROM cache');

    return database;
  } catch (err) {
    log.warn('[cache] persistência indisponível, seguindo só em memória:', err.message);
    insertStmt = null;
    deleteStmt = null;
    deleteExpiredStmt = null;
    deleteStaleStmt = null;
    deleteLegacyStmt = null;
    selectIndexStmt = null;
    selectValueStmt = null;
    clearStmt = null;
    return null;
  }
}

function namespaceFor(key: string) {
  const separator = String(key).indexOf(':');
  return separator === -1 ? '__default' : String(key).slice(0, separator);
}

function quotaFor(namespace: string) {
  return QUOTAS[namespace] || QUOTAS.__default;
}

function incrementNamespace(namespace: string) {
  namespaceCounts.set(namespace, (namespaceCounts.get(namespace) || 0) + 1);
}

function removeFromStore(key: string) {
  const entry = store.get(key);
  if (!entry) return false;
  store.delete(key);
  const remaining = (namespaceCounts.get(entry.namespace) || 1) - 1;
  if (remaining > 0) namespaceCounts.set(entry.namespace, remaining);
  else namespaceCounts.delete(entry.namespace);
  return true;
}

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

function quotaOverflow(namespace: string) {
  const excess = (namespaceCounts.get(namespace) || 0) - quotaFor(namespace);
  if (excess <= 0) return [];
  const dropped: any[] = [];
  // O Map é LRU global; filtrá-lo preserva a mesma ordem de recência dentro do
  // namespace sem deixar um burst de dlmag desalojar streams.
  for (const [key, entry] of store) {
    if (entry.namespace === namespace) dropped.push(key);
    if (dropped.length === excess) break;
  }
  return dropped;
}

/**
 * Máxima janela de graça entre os consumidores do cache. Hoje só as listas de
 * stream usam (SWR); prune/loadFromDisk precisam respeitá-la, senão o timer de
 * 10 min apaga a entrada expirada antes de o refresh de fundo poder servi-la.
 */
function maxGraceMs() {
  return Math.max(0, config.streamStaleGrace) * 1000;
}

/** Sobe o que ainda é válido; o que expirou enquanto estava fora, morre aqui. */
function loadFromDisk() {
  if (!db || !selectIndexStmt || !selectValueStmt || !deleteExpiredStmt || !deleteStaleStmt || !deleteLegacyStmt) return;
  try {
    const now = Date.now();
    // Expirado DENTRO da janela de graça sobe junto: ele ainda é servível pelo
    // SWR. Sem deslocar o corte, todo restart matava as entradas em revalidação.
    deleteExpiredStmt.run(now - maxGraceMs());
    // Versão de namespace é fonte única (cache-keys.js): apaga no banco, ANTES de
    // listar, tudo que não bate com a versão corrente — é mais barato apagar do
    // que carregar para descartar em JS, e a versão morta não ocupa cota até
    // expirar. Prefixos aposentados (raw1:/dinv1:) somem do mesmo jeito no boot.
    for (const [ns, version] of Object.entries(NAMESPACE_VERSIONS)) {
      deleteStaleStmt.run(`${ns}:%`, `${ns}:${version}:%`);
    }
    for (const legacy of LEGACY_PREFIXES) deleteLegacyStmt.run(`${legacy}%`);
    // TTL longo não pode monopolizar o L1 depois do restart: cada namespace
    // recebe o próprio orçamento antes da ordem de recência ser reconstruída.
    const rows = selectIndexStmt.all();
    const selected: { key: any; value: any; expiresAt: number; namespace: string }[] = [];
    const selectedCounts = new Map();
    const skipped: any[] = [];
    const quotaSkipped: any[] = [];
    for (const row of rows) {
      const namespace = namespaceFor(row.key);
      if ((selectedCounts.get(namespace) || 0) >= quotaFor(namespace) || selected.length >= MAX_ENTRIES) {
        skipped.push(row.key);
        quotaSkipped.push(row.key);
        continue;
      }
      try {
        // O valor gordo só é trazido para quem passou na cota (busca por PK).
        const valueRow = selectValueStmt.get(row.key);
        // Sumiu entre a listagem e a busca do valor: acontece quando outro
        // processo divide o mesmo cache.db (container + instância de teste).
        // Não é registro corrompido — só não existe mais.
        if (!valueRow) {
          skipped.push(row.key);
          continue;
        }
        selected.push({
          key: row.key,
          value: JSON.parse(valueRow.value),
          expiresAt: Number(row.expires_at),
          namespace,
        });
        selectedCounts.set(namespace, (selectedCounts.get(namespace) || 0) + 1);
      } catch (rowErr) {
        log.warn(`[cache] registro corrompido ignorado para chave '${row.key}':`, rowErr.message);
        skipped.push(row.key);
      }
    }
    // A seleção vem do TTL mais longo para o mais curto. Inserir ao contrário
    // deixa o menor TTL selecionado como LRU dentro de cada namespace.
    let loaded = 0;
    for (const entry of selected.reverse()) {
      store.set(entry.key, entry);
      incrementNamespace(entry.namespace);
      loaded++;
    }
    // Entradas acima da cota nunca voltariam a caber neste processo; removê-las
    // evita revarrer o mesmo banco dominado no próximo restart.
    for (const key of quotaSkipped) {
      metrics.count('cache.evicted.quota');
      metrics.count(`cache.evicted.quota.${namespaceFor(key)}`);
    }
    forgetMany(skipped);
    if (loaded) log.info(`[cache] ${loaded} entrada(s) recuperada(s) do disco`);
  } catch (err) {
    log.warn('[cache] falha ao ler o cache do disco:', err.message);
  }
}

// Escrita em LOTE: antes cada cache.set pagava um INSERT síncrono (commit no
// WAL) no caminho de busca, e o passe tardio gravava várias chaves em
// sequência. A chave é marcada aqui e despejada no próximo tick numa transação
// só — mesmo racional do forgetMany. Queda do processo perde só o lote do tick
// corrente: aceitável porque o L2 é best-effort e o passe tardio reconstrói o
// resultado na busca seguinte.
const pending = new Map();
let flushScheduled: ReturnType<typeof setImmediate> | null = null;

function flushPending() {
  if (!db || !insertStmt || pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    db.exec('BEGIN');
    try {
      for (const [key, entry] of batch) {
        insertStmt.run(key, JSON.stringify(entry.value), entry.expiresAt);
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignora falha de rollback se a transação já foi abortada */
      }
      throw err;
    }
  } catch (err) {
    log.warn('[cache] falha ao gravar lote no disco:', err.message);
  }
}

function scheduleFlush() {
  if (flushScheduled || !insertStmt) return;
  flushScheduled = setImmediate(() => {
    flushScheduled = null;
    flushPending();
  });
  // Sem unref o despejo pendurado manteria o processo vivo no shutdown.
  flushScheduled.unref?.();
}

function persist(key: string, value: unknown, expiresAt: number) {
  if (!insertStmt) return;
  // A última escrita da chave é a que vale; o Map já substitui a anterior.
  pending.set(key, { value, expiresAt });
  scheduleFlush();
}

function forget(key: string) {
  removeFromStore(key);
  // Se a chave ainda está na fila de despejo, o lote não pode ressuscitá-la.
  pending.delete(key);
  if (!deleteStmt) return;
  try {
    deleteStmt.run(key);
  } catch {
    /* limpeza é best-effort: o TTL em memória já protege a leitura */
  }
}

/**
 * Apaga um LOTE em uma transação só. Fora dela o node:sqlite dá commit
 * implícito por statement, cada um com seu fsync no WAL: uma varredura que
 * expira muitas chaves de uma vez vira um commit por chave, síncrono, no meio
 * do caminho de busca. Uma transação faz um fsync para o lote inteiro.
 */
function forgetMany(keys: string[]) {
  if (!keys.length) return;
  // L1 é a fonte das leituras. A limpeza precisa valer mesmo quando o SQLite
  // não existe; o L2 é apenas a cópia best-effort para sobreviver ao restart.
  for (const key of keys) {
    removeFromStore(key);
    pending.delete(key);
  }
  if (!db || !deleteStmt) return;
  try {
    db.exec('BEGIN');
    try {
      for (const key of keys) deleteStmt.run(key);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignora falha de rollback se a transação já foi abortada */
      }
      throw err;
    }
  } catch (err) {
    /* idem: o TTL em memória já protege a leitura */
    log.warn('[cache] falha ao podar o disco:', err.message);
  }
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
    const quotaDropped = quotaOverflow(namespace);
    if (quotaDropped.length) evict(quotaDropped);
  }
  if (store.size > MAX_ENTRIES) prune();
}

function clear() {
  store.clear();
  namespaceCounts.clear();
  // Antes do truncate, senão o despejo agendado reescreveria o banco limpo.
  pending.clear();
  if (clearStmt) {
    try {
      clearStmt.run();
    } catch {
      /* idem */
    }
  }
}

/** Libera o L2 no encerramento; o L1 continua utilizável até o processo sair. */
function close() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  if (flushScheduled) {
    clearImmediate(flushScheduled);
    flushScheduled = null;
  }
  if (!db) return;
  try {
    // Despeja o lote do tick corrente antes de fechar: no shutdown limpo o
    // adiamento não precisa custar uma busca a mais depois do restart.
    flushPending();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    log.warn('[cache] falha ao fechar persistência:', err.message);
  } finally {
    db = null;
    insertStmt = null;
    deleteStmt = null;
    deleteExpiredStmt = null;
    deleteStaleStmt = null;
    deleteLegacyStmt = null;
    selectIndexStmt = null;
    selectValueStmt = null;
    clearStmt = null;
  }
}

db = openDatabase();
loadFromDisk();
// Expirado ocupa linha no banco mesmo sem ninguém ler a chave.
pruneTimer = setInterval(prune, 10 * 60 * 1000);
pruneTimer.unref();

export { MAX_ENTRIES, QUOTAS, get, getWithStale, set, setMany, forget, forgetMany, prune, clear, size, snapshot, close };
