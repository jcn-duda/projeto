// Posse dos namespaces de debrid (T2-L5b): `davail:v1` e `mag:v1` passaram a
// ser do núcleo Rust (`DavailStore`/`MagnetStateStore` no `adom-index`). O Node
// não pode ser segundo escritor no MESMO `cache.db`: um `forget` do L1 apagaria
// a linha fresca do núcleo, e o Rust leria o resultado como cache frio.
//
// Dois invariantes:
// 1. `cache.set`/`forget`/`forgetMany` com chave `davail:`/`mag:` são no-op — nem
//    no L1, nem no SQLite.
// 2. A guarda de hash do TS (`isSupportedHash`) é a MESMA do núcleo: chave que o
//    núcleo recusa nunca nasce, então uma guarda mais frouxa no TS criaria
//    contador para linha que a enumeração não lê de volta.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSupportedHash } from '../src/utils/magnetdb-counts.js';
import {
  AUTOFETCH_NATIVE_PREFIXES, NAMESPACE_VERSIONS, RUST_OWNED, RUST_OWNED_PREFIXES, isForeignKey, isRustOwned, prefix,
} from '../src/utils/cache-keys.js';

let hasNodeSqlite = true;
try {
  await import('node:sqlite');
} catch {
  hasNodeSqlite = false;
}

const CACHE_URL = new URL('../src/utils/cache.js', import.meta.url).href;
let cacheSeq = 0;
const openCache = (tag: string): Promise<any> =>
  import(`${CACHE_URL}?${tag}=${Date.now()}-${cacheSeq++}`);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.existsSync(path.join(here, '..', 'src', 'utils', 'cache.ts'))
  ? path.join(here, '..')
  : path.join(here, '..', '..');

test('RUST_OWNED cobre os namespaces da Definição de Pronto (núcleo dono único)', () => {
  // §9 do plano de fechamento: `idx`, `streams`, `raw`, `davail`, `mag`,
  // `mag_meta`, `adsub`, `adrm`, `adprot`, `harvest`, `autofetch` — a lista é a
  // fonte, o teste é a catraca. `autofetch` fechou na L6 (ver o caso do fim).
  // `rdc` (ledger do Real-Debrid) entrou depois: o `adom-debrid` lê a linha
  // direto da tabela, então um L1 do Node com a mesma chave viraria segundo escritor.
  // `fsz`/`tsz` (lista de arquivos e total do torrent) seguem o mesmo desenho:
  // o gateway grava na checagem e lê na montagem da lista.
  for (const ns of [
    'idx', 'streams', 'raw', 'davail', 'mag', 'mag_meta', 'adsub', 'adrm', 'adprot', 'harvest', 'autofetch', 'rdc',
    'fsz', 'tsz',
  ]) {
    assert.ok(RUST_OWNED.includes(ns), `${ns} é dono único do núcleo`);
    assert.equal(isRustOwned(ns), true, `isRustOwned reconhece ${ns}`);
  }
  for (const owned of [prefix('harvest'), prefix('davail'), prefix('mag'), prefix('mag_meta'), prefix('rdc'), prefix('fsz'), prefix('tsz')]) {
    assert.ok(
      RUST_OWNED_PREFIXES.includes(owned),
      `${owned} bloqueia a leitura do L1 (sem o prefixo, o get devolveria o L1 vazio em vez da ponte)`,
    );
    assert.equal(isForeignKey(`${owned}alive:premiumize:x:${'a'.repeat(40)}`), true);
  }
  // `metam:v1` (flush dos contadores `meta.*` do gateway): chave única
  // construída no Rust, guardada pelo prefixo literal (precedente
  // `autofetch-worker:v1:`) — sem entrada em `NAMESPACE_VERSIONS`.
  assert.ok(RUST_OWNED_PREFIXES.includes('metam:v1:'), 'metam:v1: bloqueia a leitura do L1');
  assert.equal(isForeignKey('metam:v1:counts'), true, 'a chave única do agregado é estrangeira no L1');
  // Namespace do Node continua visível para o cache.
  assert.equal(isRustOwned('meta'), false);
  assert.equal(isForeignKey(`meta:movie:tt1`), false);
});

// O L1 vazio não prova nada sozinho: o risco do segundo escritor é o arquivo
// COMPARTILHADO. Semeia uma linha VIVA por namespace de `RUST_OWNED` e exige que
// boot, `forget`, `forgetMany` e `set` do Node deixem as linhas intactas.
//
// Este é o ÚNICO caso do arquivo que abre SQLite real, e tem que ser: `src/config
// .ts` monta `cache: cache()` UMA vez por avaliação do módulo, e o módulo é
// compartilhado entre todos os `cache.js?bust` do processo — trocar
// `CACHE_DB_PATH` DEPOIS da primeira importação não muda mais o caminho. Aqui o
// env é setado antes do primeiro `openCache`, então o arquivo é o deste diretório.
test('L2: boot, forget e set do Node não tocam linha de nenhum namespace de RUST_OWNED', {
  skip: !hasNodeSqlite && 'node:sqlite ausente',
}, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-debrid-owned-'));
  const dbPath = path.join(tempDir, 'cache.db');
  const savedDb = process.env.CACHE_DB_PATH;
  const savedPersist = process.env.CACHE_PERSIST;
  // O setup-env pina CACHE_PERSIST=false: este caso precisa do arquivo real.
  process.env.CACHE_DB_PATH = dbPath;
  process.env.CACHE_PERSIST = 'true';
  try {
    const seed = await openCache('seed');
    seed.close();
    // Sem esta âncora o caso passaria vazio: cache apontando para outro arquivo
    // também responde `has: false` para tudo.
    assert.ok(fs.existsSync(dbPath), 'o seed criou o banco temporário (o env valeu)');

    const { DatabaseSync } = await import('node:sqlite');
    const expiresAt = Date.now() + 3_600_000;
    const keys = RUST_OWNED.map(liveKey);
    const db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
      for (const key of keys) insert.run(key, JSON.stringify({ dono: 'rust' }), expiresAt);
    } finally {
      db.close();
    }

    const cache = await openCache('fresh');
    for (const key of keys) {
      assert.equal(cache.has(key), false, `${key}: boot não sobe linha do núcleo no L1`);
      assert.equal(cache.peek(key), null, `${key}: leitura quieta também não`);
    }
    for (const ns of RUST_OWNED) {
      assert.equal(cache.snapshot().namespaces[ns], undefined, `${ns}: balde não é montado no Node`);
    }

    for (const key of keys) {
      cache.forget(key);
      cache.forgetMany([key]);
      cache.set(key, { node: true }, 600);
      assert.equal(cache.has(key), false, `${key}: set do Node recusado`);
    }
    cache.close();

    const db2 = new DatabaseSync(dbPath);
    const rows = db2
      .prepare("SELECT key, value FROM cache WHERE key LIKE '%:dono-rust' ORDER BY key")
      .all() as { key: string; value: string }[];
    db2.close();
    assert.deepEqual(rows.map((row) => row.key), [...keys].sort(), 'nem forget nem set do Node tocam o L2 do núcleo');
    assert.ok(rows.every((row) => JSON.parse(row.value).dono === 'rust'), 'o valor gravado pelo núcleo está intacto');
  } finally {
    if (savedDb === undefined) delete process.env.CACHE_DB_PATH;
    else process.env.CACHE_DB_PATH = savedDb;
    if (savedPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = savedPersist;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isSupportedHash é a MESMA guarda de 40 hex do núcleo', () => {
  // O corpo da guarda é lido do fonte do Rust: uma guarda mais frouxa no TS cria
  // contador durável para chave que a enumeração do núcleo nunca lê de volta.
  const fonte = fs.readFileSync(path.join(root, 'rust', 'crates', 'adom-index', 'src', 'magnet_state.rs'), 'utf8');
  const corpo = /fn is_valid_hash\(hash: &str\) -> bool \{([\s\S]*?)\n\}/.exec(fonte)?.[1] ?? '';
  assert.match(corpo, /len\(\)\s*==\s*40/, 'a guarda exige 40 caracteres');
  assert.match(corpo, /b'a'\.\.=b'f'/, 'a guarda aceita só hex minúsculo');
  assert.match(corpo, /b'0'\.\.=b'9'/, 'a guarda aceita dígitos');

  assert.equal(isSupportedHash('a'.repeat(40)), true, '40 hex minúsculos é hash válido');
  assert.equal(isSupportedHash('A'.repeat(40)), true, 'maiúsculas são aceitas (o núcleo normaliza)');
  assert.equal(isSupportedHash('a'.repeat(39)), false, '39 hex não é hash');
  assert.equal(isSupportedHash('a'.repeat(41)), false, '41 hex não é hash');
  assert.equal(isSupportedHash('g'.repeat(40)), false, 'hex fora de a-f não é hash');
  assert.equal(isSupportedHash('merge-pos'), false, 'rótulo de teste não é hash');
  assert.equal(isSupportedHash(''), false, 'vazio não é hash');
});

// Prefixo da versão VIVA de qualquer namespace de `RUST_OWNED` (para o teste de
// L2 abaixo: chave fora da versão viva é apagada pelo `deleteStale` do boot).
const liveKey = (ns: string) => `${prefix(ns as keyof typeof NAMESPACE_VERSIONS)}dono-rust`;

// A guarda de escrita existe em `cache.set`/`setMany` (`cache.ts`: `isRustOwned
// (namespace) || isForeignKey(key)`). Este caso é a catraca DELA: se alguém
// adicionar um namespace a `RUST_OWNED` sem o `set` recusar, o teste quebra —
// sem depender de ninguém lembrar de escrever o caso específico.
test('guarda genérica: nenhum namespace de RUST_OWNED aceita escrita do Node no L1', async () => {
  const savedPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await openCache('owned-guard');
    for (const ns of RUST_OWNED) {
      const key = liveKey(ns);
      cache.set(key, { node: true }, 600);
      assert.equal(cache.has(key), false, `${ns}: set do Node não chega ao L1`);
      assert.equal(cache.get(key), null, `${ns}: leitura não inventa entrada`);
      assert.equal(cache.snapshot().namespaces[ns], undefined, `${ns}: balde não é montado no Node`);
      cache.forget(key);
    }
  } finally {
    if (savedPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = savedPersist;
  }
});

// Definição de Pronto FECHADA (L6): `autofetch` entrou pelo namespace INTEIRO.
// Quem for tirar isso precisa fechar antes a origem nativa do sub-namespace,
// não só editar a lista.
test('autofetch inteiro é do núcleo: pf: e probe: também são estrangeiros no L1', async () => {
  // `mag_meta` FECHOU (L6): o agregado do MagnetDB é gravado e lido pelo
  // `MagnetStateStore` (`putCounts`/`counts` em `magnet_meta.rs`) e o Node só
  // chega lá pela ponte.
  // `autofetch` FECHOU (L6) pelos dois últimos resíduos: `probe:` (a sonda é
  // 100% nativa desde a B4, `probe_step.rs`) e `pf:` (prefetch aposentado; o
  // construtor `prefetchKey` saiu do TS e o formato segue provado em
  // `v3::prefetch_key` + `v3_tests`). `sup:` já estava nos prefixos nativos.
  assert.equal(RUST_OWNED.includes('autofetch'), true, 'autofetch inteiro é do núcleo');
  assert.equal(isRustOwned('autofetch'), true, 'isRustOwned reconhece autofetch');
  const supPrefix = `${prefix('autofetch')}sup:`;
  assert.ok(AUTOFETCH_NATIVE_PREFIXES.includes(supPrefix), 'sup: segue nos prefixos nativos');
  assert.equal(isForeignKey(`${supPrefix}alldebrid:conta:${'a'.repeat(40)}`), true, 'sup: bloqueia L1');

  const savedPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await openCache('owned-autofetch');
    const chaves = [
      `${supPrefix}alldebrid:conta:${'a'.repeat(40)}`,
      `${prefix('autofetch')}pf:conta:tt0903747:1:2`,
      `${prefix('autofetch')}probe:${'b'.repeat(64)}`,
    ];
    for (const chave of chaves) {
      cache.set(chave, { id: '1', at: 1 }, 600);
      assert.equal(cache.has(chave), false, `${chave}: não nasce no L1 — a escrita é do núcleo`);
      assert.equal(cache.peek(chave), null, `${chave}: nem a leitura quieta o enxerga`);
      cache.forget(chave);
    }
  } finally {
    if (savedPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = savedPersist;
  }
});
