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
  NAMESPACE_VERSIONS, RUST_OWNED, RUST_OWNED_PREFIXES, isForeignKey, isRustOwned, prefix,
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
  // §9 do plano de fechamento: `idx`, `streams`, `raw`, `davail`, `mag`, `adsub`,
  // `adrm`, `adprot`, `harvest` — a lista é a fonte, o teste é a catraca.
  // Fora ficam `mag_meta` e `autofetch`, presos no teste de lacunas abaixo.
  for (const ns of ['idx', 'streams', 'raw', 'davail', 'mag', 'adsub', 'adrm', 'adprot', 'harvest']) {
    assert.ok(RUST_OWNED.includes(ns), `${ns} é dono único do núcleo`);
    assert.equal(isRustOwned(ns), true, `isRustOwned reconhece ${ns}`);
  }
  for (const owned of [prefix('harvest'), prefix('davail'), prefix('mag')]) {
    assert.ok(
      RUST_OWNED_PREFIXES.includes(owned),
      `${owned} bloqueia a leitura do L1 (sem o prefixo, o get devolveria o L1 vazio em vez da ponte)`,
    );
    assert.equal(isForeignKey(`${owned}alive:premiumize:x:${'a'.repeat(40)}`), true);
  }
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

// Lacunas da Definição de Pronto, DECLARADAS e não esquecidas. Cada `assert`
// abaixo é um freio: quem for marcar o namespace tem que fechar a origem no Rust
// (e apagar/atualizar o caso), não só editar a lista.
test('lacunas da Definição de Pronto: mag_meta e autofetch estão fora por falta de dono Rust', async () => {
  // `mag_meta`: o agregado do MagnetDB só tem escritor TS (`magnetdb-persist.ts`
  // grava `mag_meta:v1:counts` por `cache.set` e lê por `cache.peek`). Marcar
  // aqui faria o `set` virar no-op e o agregado morreria em silêncio.
  assert.equal(RUST_OWNED.includes('mag_meta'), false, 'mag_meta só entra com escritor no núcleo');
  assert.equal(RUST_OWNED_PREFIXES.includes(prefix('mag_meta')), false, 'mag_meta ainda é lido do L1 pelo Node');
  // `autofetch`: `sup:` tem escritor VIVO no Node (`cache.set` em
  // `autofetch-suppressed.ts`, espelho do KV nativo). O namespace inteiro só
  // entra em `RUST_OWNED` depois de `sup:` migrar para a ponte.
  assert.equal(RUST_OWNED.includes('autofetch'), false, 'autofetch inteiro exige migrar sup:/pf: para a ponte');

  const savedPersist = process.env.CACHE_PERSIST;
  try {
    process.env.CACHE_PERSIST = 'false';
    const cache = await openCache('owned-supp');
    const supKey = `${prefix('autofetch')}sup:alldebrid:conta:${'a'.repeat(40)}`;
    cache.set(supKey, { id: '1', at: 1, fails: 0, nextAt: 0 }, 600);
    assert.equal(cache.has(supKey), true, 'sup: continua no L1 do Node — marcá-lo deixaria a escrita no-op');
    cache.forget(supKey);
  } finally {
    if (savedPersist === undefined) delete process.env.CACHE_PERSIST;
    else process.env.CACHE_PERSIST = savedPersist;
  }
});
