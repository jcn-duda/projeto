// Guarda de bancada (`test/helpers/db-guard.ts`) — regressão do incidente da
// Leva B4: rodar um teste TS sem `--import ./dist/test/setup-env.js` abriu o
// `data/cache.db` REAL do repositório e o harness de evicção limpou o prefixo
// `autofetch:v3:o:` do acervo local.
//
// Aqui ficam as duas provas: (a) o caminho do repositório é RECUSADO com a
// instrução do conserto e o temporário passa; (b) nenhum helper da bancada
// importa dono de KV/SQLite sem chamar a guarda — o esquecimento vira vermelho.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSafeTestDb,
  assertSafeTestDbPath,
  isRepoDbPath,
  testDbPaths,
} from './helpers/db-guard.js';
import { DEFAULT_CACHE_DB_PATH, DEFAULT_MAGNET_BANK_DB_PATH } from '../src/config/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// De dist/test/ a raiz do repositório fica dois níveis acima.
const ROOT = path.join(__dirname, '..', '..');

describe('db-guard: banco do repositório é recusado', () => {
  test('cache.db do repositório: recusa e ensina o conserto', () => {
    assert.equal(isRepoDbPath(DEFAULT_CACHE_DB_PATH), true);
    assert.throws(
      () => assertSafeTestDbPath(DEFAULT_CACHE_DB_PATH, 'teste-do-guard'),
      (err: Error) => {
        assert.match(err.message, /\[db-guard\] teste-do-guard/);
        // Sem a instrução o erro vira adivinhação de quem roda a suíte.
        assert.match(err.message, /setup-env/);
        assert.match(err.message, /CACHE_DB_PATH/);
        assert.match(err.message, /MAGNET_BANK_DB_PATH/);
        assert.ok(err.message.includes(DEFAULT_CACHE_DB_PATH), 'mensagem cita o caminho recusado');
        return true;
      },
    );
  });

  test('magnets.db do repositório: recusa', () => {
    assert.equal(isRepoDbPath(DEFAULT_MAGNET_BANK_DB_PATH), true);
    assert.throws(() => assertSafeTestDbPath(DEFAULT_MAGNET_BANK_DB_PATH, 'x'), /\[db-guard\]/);
  });

  test('caminho relativo ao repositório também é recusado (o SQLite resolveria no cwd)', () => {
    const relative = path.relative(process.cwd(), DEFAULT_CACHE_DB_PATH);
    assert.equal(isRepoDbPath(relative), true);
    assert.throws(() => assertSafeTestDbPath(relative, 'x'), /\[db-guard\]/);
  });

  test('variante com `..` é normalizada antes da comparação', () => {
    const dotted = path.join(ROOT, 'data', 'lixo', '..', 'cache.db');
    assert.equal(isRepoDbPath(dotted), true);
    assert.throws(() => assertSafeTestDbPath(dotted, 'x'), /\[db-guard\]/);
  });

  test('temporário passa e devolve o caminho como veio', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-guard-'));
    try {
      const tmp = path.join(dir, 'cache.db');
      assert.equal(isRepoDbPath(tmp), false);
      assert.equal(assertSafeTestDbPath(tmp, 'x'), tmp);
      assert.equal(assertSafeTestDbPath(path.join(dir, 'magnets.db'), 'x'), path.join(dir, 'magnets.db'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('`:memory:` e vazio passam — não há arquivo para morder', () => {
    assert.equal(assertSafeTestDbPath(':memory:', 'x'), ':memory:');
    assert.equal(assertSafeTestDbPath('', 'x'), '');
    assert.equal(isRepoDbPath(':memory:'), false);
  });

  test('outro banco do data/ não é confundido com os dois do repositório', () => {
    assert.equal(isRepoDbPath(path.join(ROOT, 'data', 'catalog.db')), false);
    assert.equal(isRepoDbPath(path.join(ROOT, 'data', 'cache.db.bak')), false);
  });

  test('a config viva desta suíte NÃO aponta para o repositório', () => {
    // Falha explícita quando alguém roda o arquivo sem o setup-env: é o
    // incidente, agora com nome e conserto em vez de acervo mutado.
    assert.doesNotThrow(
      () => assertSafeTestDb('db-guard.test'),
      'suíte sem o setup-env: CACHE_PERSIST/CACHE_DB_PATH não foram pinados',
    );
    const live = testDbPaths();
    assert.notEqual(live.cache, DEFAULT_CACHE_DB_PATH);
    assert.notEqual(live.magnets, DEFAULT_MAGNET_BANK_DB_PATH);
  });
});

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Módulos que, importados por um helper, dão ao helper acesso ao banco.
 * Comparados como substring SEM as aspas: os helpers de `pipeline-oracle/`
 * importam com `../../../src/...`, e exigir a aspa colada deixaria os três
 * fora da varredura (verde por omissão).
 *
 * Os quatro últimos não são clientes do KV por acaso: `protected` e
 * `alldebrid-reupload` gravam posse/anti-reenchimento por `kvSet`/`kvForget`,
 * `autofetch-obra` grava o registro da obra por `cache.set` e
 * `debrid-state-native` abre o handle napi de `davail`/`mag` no MESMO
 * `cache.db`. Sem eles na lista, um helper que só importa `protected.ts`
 * escapava da varredura e ia ao acervo real sem aviso.
 */
const DB_OWNERS = [
  'src/utils/cache.js',
  'src/utils/cache-db.js',
  'src/utils/native-kv.js',
  'src/utils/magnet-bank.js',
  'src/utils/debrid-state-native.js',
  'src/providers/autofetch.js',
  'src/providers/autofetch-obra.js',
  'src/debrid/protected.js',
  'src/debrid/alldebrid-reupload.js',
  'node:sqlite',
];

describe('db-guard: helper que abre KV/SQLite importa a guarda', () => {
  test('todo helper de test/helpers/** com acesso a banco chama assertSafeTestDb', () => {
    const files = walkTs(path.join(ROOT, 'test', 'helpers'));
    assert.ok(files.length > 5, `varredura de test/helpers acha pouco: ${files.length} arquivo(s)`);

    const offenders: string[] = [];
    const holders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const ownsDb = DB_OWNERS.some((mod) => text.includes(mod));
      if (!ownsDb) continue;
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      holders.push(rel);
      // A guarda é aceita como import + chamada; só o import não basta.
      if (!text.includes('assertSafeTestDb(')) offenders.push(rel);
    }
    // Varredura que não acha ninguém é verde falso: o caminho mudou de lugar.
    assert.ok(holders.length >= 6, `varredura de donos de banco acha pouco: ${holders.join(', ')}`);
    assert.deepEqual(
      offenders,
      [],
      'helper com acesso ao KV/SQLite sem a guarda de bancada (importe\n'
      + "`assertSafeTestDb` de './db-guard.js' e chame no topo do módulo):\n  "
      + offenders.join('\n  '),
    );
  });
});
