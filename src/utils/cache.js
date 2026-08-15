const fs = require('fs');
const path = require('path');
const log = require('./logger');
const metrics = require('./metrics');

const store = new Map();
const MAX_ENTRIES = 2000;

// Memória é o L1; o SQLite só existe pra sobreviver ao restart do container.
// Sem ele o addon funciona igual, só volta a esquentar do zero a cada subida.
const DB_PATH = process.env.CACHE_DB_PATH || path.join(__dirname, '..', '..', 'data', 'cache.db');
let db = null;

function openDatabase() {
  if (process.env.CACHE_PERSIST === 'false') return null;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // node:sqlite é experimental no Node 22 — se o runtime não tiver, seguimos
    // só em memória em vez de derrubar o addon.
    const { DatabaseSync } = require('node:sqlite');
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
    return database;
  } catch (err) {
    log.warn('[cache] persistência indisponível, seguindo só em memória:', err.message);
    return null;
  }
}

/** Sobe o que ainda é válido; o que expirou enquanto estava fora, morre aqui. */
function loadFromDisk() {
  if (!db) return;
  try {
    const now = Date.now();
    db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
    // O teto do L1 não pode expulsar justamente os artefatos de TTL longo que
    // justificam a persistência, como magnets já resolvidos por protetores.
    const rows = db
      .prepare('SELECT key, value, expires_at FROM cache ORDER BY expires_at DESC LIMIT ?')
      .all(MAX_ENTRIES);
    // A seleção vem do TTL mais longo para o mais curto. Inserir ao contrário
    // deixa o mais curto como LRU e evita descartarmos o mais durável no
    // primeiro set após o restart.
    for (const row of rows.reverse()) {
      store.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
    }
    if (rows.length) log.info(`[cache] ${rows.length} entrada(s) recuperada(s) do disco`);
  } catch (err) {
    log.warn('[cache] falha ao ler o cache do disco:', err.message);
  }
}

function persist(key, value, expiresAt) {
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)').run(
      key,
      JSON.stringify(value),
      expiresAt,
    );
  } catch (err) {
    log.warn('[cache] falha ao gravar no disco:', err.message);
  }
}

function forget(key) {
  store.delete(key);
  if (!db) return;
  try {
    db.prepare('DELETE FROM cache WHERE key = ?').run(key);
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
function forgetMany(keys) {
  if (!db || !keys.length) return;
  try {
    const stmt = db.prepare('DELETE FROM cache WHERE key = ?');
    db.exec('BEGIN');
    try {
      for (const key of keys) stmt.run(key);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    /* idem: o TTL em memória já protege a leitura */
    log.warn('[cache] falha ao podar o disco:', err.message);
  }
}

function prune() {
  const now = Date.now();
  // Acumula e apaga uma vez só: o disco é o caro, a memória não.
  const dropped = [];
  for (const [key, hit] of store) {
    if (hit.expiresAt && now > hit.expiresAt) {
      store.delete(key);
      dropped.push(key);
    }
  }
  // Se ainda estourou o teto, descarta as entradas mais antigas (Map preserva ordem de inserção).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    dropped.push(oldest);
    // Despejo por teto é o sinal de que MAX_ENTRIES ficou pequeno: subindo
    // sempre, o cache está jogando fora coisa que ainda seria usada.
    metrics.count('cache.evicted');
  }
  forgetMany(dropped);
}

/** Para o /metrics.json: quanto do teto está ocupado agora. */
function size() {
  return store.size;
}

function get(key) {
  const hit = store.get(key);
  if (!hit) {
    metrics.count('cache.miss');
    return null;
  }
  if (hit.expiresAt && Date.now() > hit.expiresAt) {
    store.delete(key);
    forget(key);
    // Expirado é miss para quem perguntou; o `expired` separado diz se o TTL
    // está curto demais para o ritmo de uso.
    metrics.count('cache.miss');
    metrics.count('cache.expired');
    return null;
  }
  metrics.count('cache.hit');
  // Map preserva inserção; mover o hit para o fim transforma o corte em LRU.
  store.delete(key);
  store.set(key, hit);
  return hit.value;
}

function set(key, value, ttlSeconds) {
  if (!ttlSeconds || ttlSeconds <= 0) return;
  const expiresAt = Date.now() + ttlSeconds * 1000;
  store.delete(key); // reinsere no fim para a ordem refletir o uso mais recente
  store.set(key, { value, expiresAt });
  persist(key, value, expiresAt);
  if (store.size > MAX_ENTRIES) prune();
}

function clear() {
  store.clear();
  if (db) {
    try {
      db.exec('DELETE FROM cache');
    } catch {
      /* idem */
    }
  }
}

db = openDatabase();
loadFromDisk();
// Expirado ocupa linha no banco mesmo sem ninguém ler a chave.
setInterval(prune, 10 * 60 * 1000).unref();

module.exports = { MAX_ENTRIES, get, set, forget, clear, size };
