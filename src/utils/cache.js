const fs = require('fs');
const path = require('path');

const store = new Map();
const MAX_ENTRIES = 500;

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
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
    `);
    return database;
  } catch (err) {
    console.warn('[cache] persistência indisponível, seguindo só em memória:', err.message);
    return null;
  }
}

/** Sobe o que ainda é válido; o que expirou enquanto estava fora, morre aqui. */
function loadFromDisk() {
  if (!db) return;
  try {
    const now = Date.now();
    db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
    const rows = db
      .prepare('SELECT key, value, expires_at FROM cache ORDER BY expires_at ASC LIMIT ?')
      .all(MAX_ENTRIES);
    for (const row of rows) {
      store.set(row.key, { value: JSON.parse(row.value), expiresAt: Number(row.expires_at) });
    }
    if (rows.length) console.log(`[cache] ${rows.length} entrada(s) recuperada(s) do disco`);
  } catch (err) {
    console.warn('[cache] falha ao ler o cache do disco:', err.message);
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
    console.warn('[cache] falha ao gravar no disco:', err.message);
  }
}

function forget(key) {
  if (!db) return;
  try {
    db.prepare('DELETE FROM cache WHERE key = ?').run(key);
  } catch {
    /* limpeza é best-effort: o TTL em memória já protege a leitura */
  }
}

function prune() {
  const now = Date.now();
  for (const [key, hit] of store) {
    if (hit.expiresAt && now > hit.expiresAt) {
      store.delete(key);
      forget(key);
    }
  }
  // Se ainda estourou o teto, descarta as entradas mais antigas (Map preserva ordem de inserção).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
    forget(oldest);
  }
}

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt && Date.now() > hit.expiresAt) {
    store.delete(key);
    forget(key);
    return null;
  }
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

module.exports = { get, set, clear };
