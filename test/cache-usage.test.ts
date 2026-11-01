import { test } from 'node:test';
import assert from 'node:assert';
import { prefix } from '../src/utils/cache-keys.js';

// Contratos da telemetria de uso por namespace (`usage()`, guia da guilhotina
// do L1): prova de quem ainda tem consumidor antes do corte do motor. Mesmo
// padrão do cache.test.ts: instância nova por teste (query única, o cache.ts é
// dono de todo o estado mutável) e persistência desligada — nada aqui toca o
// data/cache.db real.
const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
const freshCache = (): Promise<any> => import(`${CACHE_URL}?usage=${Date.now()}-${cacheSeq++}`);
const TTL_S = 3600;

// Persistência OFF durante o corpo do teste (mesma régua dos testes em memória
// do cache.test.ts): o módulo nasce sem SQLite e o ambiente volta no finally.
async function withMemoryCache(run: (cache: any) => void) {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();
    run(cache);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
  }
}

test('usage: boot limpo não tem namespaces medidos', async () => {
  await withMemoryCache((cache) => {
    const u = cache.usage();
    assert.deepEqual(u.namespaces, {}, 'nenhum acesso antes de qualquer API');
    assert.equal(u._origem, 'amostra', 'contadores do processo, zeram no restart');
  });
});

test('usage: get hit/miss conta reads e set conta writes no namespace tocado', async () => {
  await withMemoryCache((cache) => {
    cache.set('tmdb:x', { n: 1 }, TTL_S);
    assert.deepEqual(cache.get('tmdb:x'), { n: 1 }, 'hit normal');
    assert.equal(cache.get('tmdb:ausente'), null, 'miss também é leitura viva');
    const u = cache.usage().namespaces['tmdb'];
    assert.equal(u.reads, 2, 'hit + miss somam 2 consultas');
    assert.equal(u.writes, 1, 'uma escrita');
    assert.ok(u.lastReadAt > 0 && u.lastWriteAt > 0, 'instantes da última consulta/escrita');
  });
});

test('usage: sondagens (peek/has/peekRemaining) contam read sem promover nada', async () => {
  await withMemoryCache((cache) => {
    cache.set('cinemeta:a', { m: 1 }, TTL_S);
    cache.peek('cinemeta:a');
    cache.has('cinemeta:a');
    const restante = cache.peekRemaining('cinemeta:a');
    assert.ok(restante !== null && restante > 0, 'entrada válida tem TTL restante');
    const u = cache.usage().namespaces['cinemeta'];
    assert.equal(u.reads, 3, 'três sondagens, três leituras');
    assert.equal(u.writes, 1, 'sondagem não escreve');
  });
});

test('usage: TTL 0 não entra no L1 e não conta write', async () => {
  await withMemoryCache((cache) => {
    cache.set('tmdb:zero', { v: 1 }, 0);
    assert.equal(cache.get('tmdb:zero'), null, 'TTL 0 nunca entrou');
    const u = cache.usage().namespaces['tmdb'];
    assert.equal(u.reads, 1, 'só a leitura');
    assert.equal(u.writes, 0, 'escrita recusada não é uso do L1');
  });
});

test('usage: dono Rust — foreign silencioso não conta; leitor zumbi de namespace sem prefixo aparece', async () => {
  await withMemoryCache((cache) => {
    // `harvest` é foreign pelo PREFIXO: get/peek saem na guarda antes do store
    // e nem contam (nem miss, nem uso) — o leitor correto dele é a ponte.
    const fila = `${prefix('harvest')}q`;
    assert.equal(cache.get(fila), null);
    assert.equal(cache.peek(fila), null);
    assert.equal(cache.usage().namespaces['harvest'], undefined, 'foreign é silencioso');
    // `streams` é RUST_OWNED pelo namespace inteiro, mas NÃO está em
    // RUST_OWNED_PREFIXES: o get toca o store (sempre vazio) e o uso aparece —
    // é exatamente o leitor zumbi que a guilhotina quer ver exposto.
    const stream = `${prefix('streams')}movie:tt1:{}`;
    assert.equal(cache.get(stream), null);
    // A escrita do Node é recusada pela guarda de dono: nada de write.
    cache.set(stream, { v: 1 }, TTL_S);
    const u = cache.usage().namespaces['streams'];
    assert.equal(u.reads, 1, 'leitura zumbi contada');
    assert.equal(u.writes, 0, 'set de dono Rust é no-op no L1');
  });
});

test('usage: snapshot() expõe a telemetria junto dos baldes do /metrics.json', async () => {
  await withMemoryCache((cache) => {
    cache.set('meta:a', 1, TTL_S);
    cache.get('meta:a');
    const snap = cache.snapshot();
    assert.equal(snap.usage._origem, 'amostra');
    assert.equal(snap.usage.namespaces['meta'].reads, 1);
    assert.equal(snap.usage.namespaces['meta'].writes, 1);
    // O formato clássico do snapshot continua intacto (contrato do painel).
    assert.equal(snap.entries, 1);
    assert.equal(snap.maxEntries, cache.MAX_ENTRIES);
    // `meta:` perdeu a cota nomeada no passo 4 do corte do fallback: o balde
    // cai no `__default`, que hoje é o mesmo 500.
    assert.deepEqual(snap.namespaces['meta'], { entries: 1, maxEntries: cache.QUOTAS.__default });
  });
});
