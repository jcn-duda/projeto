import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as metrics from '../src/utils/metrics.js';
import { NAMESPACE_VERSIONS } from '../src/utils/cache-keys.js';
import { quotaFor, QUOTAS } from '../src/utils/cache-quotas.js';

const DLMAG_QUOTA = 4000;
const TTL_S = 3600;

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

// Caminho absoluto do módulo compilado. Cada teste recarrega com query única
// para nascer limpo: o cache.ts é dono de todo o estado mutável, e o cache-db
// vive numa closure criada a cada instância. Sem query para os filhos, quando
// eles precisam compartilhar a instância com o magnetdb.
const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
const freshCache = (): Promise<any> => import(`${CACHE_URL}?fresh=${Date.now()}-${cacheSeq++}`);

test('estouro de dlmag despeja só o próprio namespace e preserva streams', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

    cache.set('streams:v5:movie:tt-vizinho', { streams: ['preservado'] }, TTL_S);
    for (let i = 0; i < DLMAG_QUOTA; i++) cache.set(`dlmag:url-${i}`, { n: i }, TTL_S);
    cache.set('dlmag:overflow', { n: 'overflow' }, TTL_S);

    assert.deepEqual(cache.get('streams:v5:movie:tt-vizinho'), { streams: ['preservado'] });
    assert.equal(cache.get('dlmag:url-0'), null, 'LRU de dlmag sai na própria cota');
    assert.deepEqual(cache.get('dlmag:overflow'), { n: 'overflow' });
    assert.equal(cache.snapshot().namespaces.dlmag.entries, DLMAG_QUOTA);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('cotas: split RD (rdc ledger, rdq fila, rdt Torrentio) preserva a folga do UNIVERSO sob o teto', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();
    assert.equal(cache.QUOTAS.raw, 800);
    assert.equal(cache.QUOTAS.streams, 2000);
    assert.equal(cache.QUOTAS.davail, 1000);
    assert.equal(cache.QUOTAS.mag, 50000);
    assert.equal(cache.QUOTAS.rdc, 14000);
    assert.equal(cache.QUOTAS.rdq, 500);
    assert.equal(cache.QUOTAS.rdt, 2500);
    assert.equal(cache.QUOTAS.adprot, 2000);
    assert.equal(cache.QUOTAS.idx, 2000);
    assert.equal(cache.QUOTAS.fsz, 3000);
    assert.equal(cache.QUOTAS.vres, 1000);
    // Fase 2 do Chupim: o teto por obra (`autofetch:v3:o:`) divide o balde com
    // markers/dead/queues/prefetch/sup, então a cota dobrou e o teto global
    // subiu junto — sempre estritamente acima da soma.
    assert.equal(cache.QUOTAS.autofetch, 4000);
    assert.equal(cache.MAX_ENTRIES, 93000);
    // O que o teto precisa cobrir não é a lista de `QUOTAS`: `quotaFor` devolve
    // `__default` para todo nome sem entrada própria, então namespace
    // versionado sem cota some da soma nomeada e ocupa o store igual — foi
    // assim que o teto ficou abaixo da conta real sem nenhum teste reclamar.
    // O universo honesto é a união dos dois registros, mais o balde das chaves
    // sem `:`.
    const universo = new Set([...Object.keys(cache.QUOTAS), ...Object.keys(NAMESPACE_VERSIONS)]);
    universo.delete('__default');
    const deFallback = [...universo].filter((ns) => cache.QUOTAS[ns] === undefined);
    assert.deepEqual(
      deFallback,
      [],
      `namespace sem cota explícita soma ${cache.QUOTAS.__default} cada ao universo: ${deFallback.join(', ')}`,
    );
    const somaUniverso =
      [...universo].reduce((sum, ns) => sum + cache.QUOTAS[ns], 0) + cache.QUOTAS.__default;
    assert.ok(
      somaUniverso < cache.MAX_ENTRIES,
      `soma do universo (${somaUniverso}, ${universo.size} namespaces + __default) < teto (${cache.MAX_ENTRIES})`,
    );
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('estouro de raw despeja só o próprio namespace e preserva streams', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();
    const RAW_QUOTA = cache.QUOTAS.raw;

    cache.set('streams:v5:movie:tt-vizinho', { streams: ['preservado'] }, TTL_S);
    for (let i = 0; i < RAW_QUOTA; i += 1) {
      cache.set(`raw:v1:jackett:yts:movie:t-${i}`, { items: [] }, TTL_S);
    }
    cache.set('raw:v1:jackett:yts:movie:overflow', { items: ['overflow'] }, TTL_S);

    assert.deepEqual(cache.get('streams:v5:movie:tt-vizinho'), { streams: ['preservado'] });
    assert.equal(cache.get('raw:v1:jackett:yts:movie:t-0'), null, 'LRU de raw sai na própria cota');
    assert.deepEqual(cache.get('raw:v1:jackett:yts:movie:overflow'), { items: ['overflow'] });
    assert.equal(cache.snapshot().namespaces.raw.entries, RAW_QUOTA);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('LRU de dlmag é escolhido dentro do namespace, não pela ordem global', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

    cache.set('meta:movie:tt-vizinho', { title: 'vizinho antigo' }, TTL_S);
    for (let i = 0; i < DLMAG_QUOTA; i++) cache.set(`dlmag:lru-${i}`, { n: i }, TTL_S);
    assert.deepEqual(cache.get('dlmag:lru-0'), { n: 0 }, 'renova o LRU de dlmag');
    cache.set('dlmag:overflow', { n: 'overflow' }, TTL_S);

    assert.deepEqual(cache.get('meta:movie:tt-vizinho'), { title: 'vizinho antigo' });
    assert.deepEqual(cache.get('dlmag:lru-0'), { n: 0 }, 'entrada renovada sobrevive');
    assert.equal(cache.get('dlmag:lru-1'), null, 'próximo LRU do dlmag é expulso');
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('hit/miss por namespace: contadores globais ganham o sufixo do balde', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();
    metrics.reset();

    cache.set('raw:v1:jackett:yts:movie:coringa', { itens: [] }, TTL_S);
    assert.deepEqual(cache.get('raw:v1:jackett:yts:movie:coringa'), { itens: [] });
    cache.get('raw:v1:jackett:yts:movie:faltante');
    cache.get('sem-prefixo');

    const counters = metrics.snapshot().counters;
    assert.equal(counters['cache.hit'], 1, 'contador global de hit preservado');
    assert.equal(counters['cache.hit.raw'], 1, 'hit ganha o sufixo do namespace');
    assert.equal(counters['cache.miss'], 2, 'contador global de miss preservado');
    assert.equal(counters['cache.miss.raw'], 1, 'miss ganha o sufixo do namespace');
    assert.equal(counters['cache.miss.__default'], 1, 'chave sem prefixo cai no balde padrão');
  } finally {
    metrics.reset();
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('modo sem persistência (CACHE_PERSIST="false"): operações puras em memória com statements nulos', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  const originalDbPath = process.env.CACHE_DB_PATH;
  try {
    process.env.CACHE_PERSIST = 'false';
    delete process.env.CACHE_DB_PATH;
    const cache = await freshCache();

    cache.set('mem-1', { a: 1 }, 3600);
    cache.set('mem-2', { b: 2 }, 3600);
    assert.strictEqual(cache.size(), 2);
    assert.deepStrictEqual(cache.get('mem-1'), { a: 1 });

    cache.forget('mem-1');
    assert.strictEqual(cache.get('mem-1'), null);
    assert.strictEqual(cache.size(), 1);

    cache.forgetMany(['mem-2']);
    assert.strictEqual(cache.get('mem-2'), null);
    assert.strictEqual(cache.size(), 0);

    cache.set('mem-3', { c: 3 }, 3600);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.get('mem-3'), null);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
  }
});

test('close() libera o SQLite sem derrubar o L1 e aceita chamada repetida', {
  skip: !hasNodeSqlite && 'node:sqlite indisponível — precisa de Node 22+',
}, async () => {
  const originalDbPath = process.env.CACHE_DB_PATH;
  const originalPersist = process.env.CACHE_PERSIST;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-cache-close-'));
  const dbPath = path.join(tempDir, 'cache.db');

  try {
    delete process.env.CACHE_PERSIST;
    process.env.CACHE_DB_PATH = dbPath;
    const cache = await freshCache();

    cache.set('antes', { n: 1 }, TTL_S);
    cache.close();

    assert.deepEqual(cache.get('antes'), { n: 1 }, 'leitura pós-close continua valendo');
    assert.doesNotThrow(() => cache.set('depois', { n: 2 }, TTL_S));
    assert.deepEqual(cache.get('depois'), { n: 2 });
    assert.doesNotThrow(() => cache.close(), 'close() repetido é seguro');

    assert.equal(fs.existsSync(`${dbPath}-wal`), false, 'o -wal tem que sumir no close');
  } finally {
    if (originalDbPath === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = originalDbPath;
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('teto global despeja e termina: prune não pode repetir a mesma chave', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

    const porNamespace = cache.QUOTAS.__default;
    const namespaces = Math.ceil(cache.MAX_ENTRIES / porNamespace) + 1;
    for (let ns = 0; ns < namespaces; ns += 1) {
      for (let i = 0; i < porNamespace; i += 1) {
        cache.set(`teto${ns}:${i}`, { i }, TTL_S);
      }
    }

    assert.ok(
      cache.size() <= cache.MAX_ENTRIES,
      `store parou em ${cache.size()}, acima do teto ${cache.MAX_ENTRIES}`,
    );
    cache.set('teto-final:1', { ok: true }, TTL_S);
    assert.deepEqual(cache.get('teto-final:1'), { ok: true });
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

test('getWithStale: três estados — fresco, expirado na graça, fora da janela', async () => {
  const originalPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await freshCache();

    cache.set('swr:fresh', { n: 1 }, TTL_S);
    assert.deepEqual(cache.getWithStale('swr:fresh', 300), { value: { n: 1 }, stale: false });

    cache.set('swr:grace', { n: 2 }, 0.05);
    cache.set('swr:gone', { n: 3 }, 0.05);
    await sleep(120);

    assert.deepEqual(cache.getWithStale('swr:grace', 300), { value: { n: 2 }, stale: true });
    assert.deepEqual(
      cache.getWithStale('swr:grace', 300),
      { value: { n: 2 }, stale: true },
      'leitura stale não chama forget: a segunda leitura vê a mesma entrada',
    );

    assert.equal(cache.getWithStale('swr:gone', 0.02), null);
    assert.equal(cache.getWithStale('swr:gone', 300), null, 'a entrada foi apagada, não só escondida');

    assert.equal(cache.getWithStale('swr:inexistente', 300), null);
  } finally {
    if (originalPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = originalPersist;
  }
});

test('quotaFor: cota declarada vale como está, inclusive 0', () => {
  // Com `||`, um namespace declarado com 0 (nada retido) ganhava o fallback de
  // 500 em silêncio — o oposto do pedido, e invisível para a soma do universo,
  // que leria 0. Nome desconhecido continua caindo no `__default`.
  // `QUOTAS` é congelado e `quotaFor` o lê direto, então não dá para injetar um
  // namespace com 0 daqui: o que este teste prende é o contrato observável —
  // cota declarada é devolvida como está (o `mag_meta: 1` é a menor que existe)
  // e só nome AUSENTE cai no fallback.
  assert.equal(quotaFor('mag_meta'), QUOTAS.mag_meta);
  assert.notEqual(quotaFor('mag_meta'), QUOTAS.__default, 'cota pequena não vira fallback');
  assert.equal(quotaFor('__nao_existe__'), QUOTAS.__default);
  assert.equal(quotaFor('__default'), QUOTAS.__default);
});
