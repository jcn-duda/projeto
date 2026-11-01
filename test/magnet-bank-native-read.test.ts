// Ponte READ-ONLY do banco vivo (`magnet-bank-native.ts` → `bank_read.rs`):
// `bankLookupUriNative` e `bankRowsForMediaSourceNative` contra um SQLite REAL
// em tmp (o MESMO arquivo que a ponte abre via `config.magnetBank.dbPath`), o
// fail-open (núcleo sem a leitura) e o kill-switch que nem cria o arquivo. O
// acervo é semeado por INSERT direto (`helpers/magnet-bank-seed.ts`) — quem
// grava em produção é o gateway; Node 20 não tem `node:sqlite` e os testes com
// semente pulam. Testes TS rodam de `dist/`: o `npm run build` copia o `.node`
// novo de `rust/target` para `dist/rust/`.
process.env.CACHE_PERSIST = 'false';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import {
  bankLookupUriNative,
  bankRowsForMediaSourceNative,
} from '../src/utils/magnet-bank-native.js';
import { requireCore, setCoreForTest } from '../src/utils/rust-core.js';
import { hasNodeSqlite, FRESH_DIR, openBankSchema, insertMagnet } from './helpers/magnet-bank-seed.js';

const hex = (c: string) => c.repeat(40);

let savedDbPath: string;
let savedEnabled: boolean;
let dbPath = '';

beforeEach(() => {
  savedDbPath = config.magnetBank.dbPath;
  savedEnabled = config.magnetBank.enabled;
  dbPath = path.join(FRESH_DIR(), 'magnets.db');
  openBankSchema(dbPath); // cria o arquivo com o schema pela própria ponte
});

after(() => {
  config.magnetBank.dbPath = savedDbPath;
  config.magnetBank.enabled = savedEnabled;
});

/** INSERT direto no SQLite que a ponte lê; devolve a URI gravada. */
function seed(h: string, dn: string): string {
  const uri = `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(dn)}`;
  insertMagnet(dbPath, { hash: h, uri, title: dn });
  return uri;
}

test('ponte devolve a URI gravada e null para hash fora do banco', { skip: !hasNodeSqlite }, () => {
  const h = hex('a');
  const stored = seed(h, 'Filme.BR.2024.1080p');

  // Hash em MAIÚSCULAS: a ponte normaliza (normHash do TS) e o store de novo.
  assert.equal(bankLookupUriNative(h.toUpperCase()), stored, 'URI sai como foi gravada');
  assert.ok(stored.includes('dn=Filme.BR.2024.1080p'), 'dn do post preservado');
  assert.equal(bankLookupUriNative(hex('9')), null, 'hash fora do banco é null');
});

test('ponte devolve as linhas do acervo no shape plano do record', { skip: !hasNodeSqlite }, () => {
  const [h1, h2] = [hex('b'), hex('c')] as const;
  const u1 = seed(h1, 'Filme.Um.2024');
  const u2 = seed(h2, 'Filme.Dois.2024');

  const rows = bankRowsForMediaSourceNative([h1.toUpperCase(), h2, hex('9')]);
  assert.equal(rows.length, 2, 'hash fora do banco não gera linha');
  const byHash = new Map(rows.map((row) => [row.hash, row]));
  assert.deepEqual(byHash.get(h1), { hash: h1, uri: u1, title: 'Filme.Um.2024' });
  assert.deepEqual(byHash.get(h2), { hash: h2, uri: u2, title: 'Filme.Dois.2024' });

  // Lista vazia nem toca o núcleo; [] é o contrato de quem não tem nada.
  assert.deepEqual(bankRowsForMediaSourceNative([]), []);
});

test('kill-switch devolve null/vazio SEM criar o arquivo do banco', () => {
  const ghost = path.join(FRESH_DIR(), 'nao-deve-existir.db');
  config.magnetBank.enabled = false;
  config.magnetBank.dbPath = ghost;
  try {
    assert.equal(bankLookupUriNative(hex('a')), null);
    assert.deepEqual(bankRowsForMediaSourceNative([hex('a')]), []);
    assert.equal(fs.existsSync(ghost), false, 'ponte desligada não cria o SQLite');
  } finally {
    config.magnetBank.enabled = true;
    config.magnetBank.dbPath = dbPath;
  }
});

test('fail-open: núcleo sem as leituras devolve null/vazio sem lançar', () => {
  // Núcleo real espalhado SEM os métodos novos (o padrão dos testes de
  // decisão): simula um .node antigo, e a ponte trata como "sem a leitura".
  const real = requireCore();
  setCoreForTest({ ...real, bankLookupUri: undefined, bankRowsForMediaSource: undefined });
  try {
    assert.equal(bankLookupUriNative(hex('a')), null);
    assert.deepEqual(bankRowsForMediaSourceNative([hex('a')]), []);
    // E com um core que LANÇA (SQLite quebrado): fail-open de novo.
    setCoreForTest({
      ...real,
      bankLookupUri: () => {
        throw new Error('sqlite quebrado');
      },
      bankRowsForMediaSource: () => {
        throw new Error('sqlite quebrado');
      },
    });
    assert.equal(bankLookupUriNative(hex('a')), null);
    assert.deepEqual(bankRowsForMediaSourceNative([hex('a')]), []);
  } finally {
    setCoreForTest(null); // volta ao carregamento lazy do .node
  }
  // Núcleo real de volta (o aquecido pelo setup-env): a leitura funciona.
  const core = requireCore() as { bankLookupUri?: unknown };
  assert.equal(typeof core.bankLookupUri, 'function', 'o .node expõe bankLookupUri');
});
