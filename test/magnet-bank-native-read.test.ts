// Ponte READ-ONLY do banco vivo (`magnet-bank-native.ts` → `bank_read.rs`):
// `bankLookupUriNative` e `bankRowsForMediaSourceNative` contra um SQLite REAL
// em tmp (a engine TS semeia o MESMO arquivo que a ponte abre via
// `config.magnetBank.dbPath`), o fail-open (kill-switch, núcleo sem a leitura)
// e o kill-switch que nem cria o arquivo. Testes TS rodam de `dist/`: o
// `npm run build` copia o `.node` novo de `rust/target` para `dist/rust/`.
process.env.CACHE_PERSIST = 'false';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';
import * as bank from '../src/utils/magnet-bank.js';
import {
  bankLookupUriNative,
  bankRowsForMediaSourceNative,
} from '../src/utils/magnet-bank-native.js';
import { requireCore, setCoreForTest } from '../src/utils/rust-core.js';

const FRESH_DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bank-native-read-'));
const hex = (c: string) => c.repeat(40);
const richMagnet = (h: string, dn: string) =>
  `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(dn)}`;

let savedDbPath: string;
let savedEnabled: boolean;
let dir: string;

beforeEach(() => {
  bank.resetForTests();
  dir = FRESH_DIR();
  const dbPath = path.join(dir, 'magnets.db');
  bank.open(dbPath); // SQLite real: é o MESMO arquivo que a ponte abre
  savedDbPath = config.magnetBank.dbPath;
  savedEnabled = config.magnetBank.enabled;
  config.magnetBank.dbPath = dbPath;
  config.magnetBank.enabled = true;
});

after(() => {
  bank.resetForTests();
  config.magnetBank.dbPath = savedDbPath;
  config.magnetBank.enabled = savedEnabled;
});

/** Semeia o banco vivo via o flush do gateway (a captura é dele) e devolve a URI GRAVADA (o write enriquece com tr=). */
function seed(h: string, dn: string): string {
  bank.captureItems([{ infoHash: h, magnet: richMagnet(h, dn), title: dn }], 'bludv', {});
  bank.flushNow();
  return bank.lookup(h)!.uri;
}

test('ponte devolve a URI gravada e null para hash fora do banco', () => {
  const h = hex('a');
  const stored = seed(h, 'Filme.BR.2024.1080p');

  // Hash em MAIÚSCULAS: a ponte normaliza (normHash do TS) e o store de novo.
  assert.equal(bankLookupUriNative(h.toUpperCase()), stored, 'URI sai como foi gravada');
  assert.ok(stored.includes('dn=Filme.BR.2024.1080p'), 'dn do post preservado');
  assert.equal(bankLookupUriNative(hex('9')), null, 'hash fora do banco é null');
  // E o `lookup` da fachada vê o mesmo: a ponte não divergiu do banco.
  assert.equal(bank.lookup(h)?.uri, stored);
});

test('ponte devolve as linhas do acervo no shape plano do record', () => {
  const [h1, h2] = [hex('b'), hex('c')] as const;
  seed(h1, 'Filme.Um.2024');
  seed(h2, 'Filme.Dois.2024');

  const rows = bankRowsForMediaSourceNative([h1.toUpperCase(), h2, hex('9')]);
  assert.equal(rows.length, 2, 'hash fora do banco não gera linha');
  const byHash = new Map(rows.map((row) => [row.hash, row]));
  assert.deepEqual(byHash.get(h1), { hash: h1, uri: bank.lookup(h1)!.uri, title: 'Filme.Um.2024' });
  assert.deepEqual(byHash.get(h2), { hash: h2, uri: bank.lookup(h2)!.uri, title: 'Filme.Dois.2024' });

  // Lista vazia nem toca o núcleo; [] é o contrato de quem não tem nada.
  assert.deepEqual(bankRowsForMediaSourceNative([]), []);
});

test('kill-switch devolve null/vazio SEM criar o arquivo do banco', () => {
  config.magnetBank.enabled = false;
  const ghost = path.join(FRESH_DIR(), 'nao-deve-existir.db');
  config.magnetBank.dbPath = ghost;

  assert.equal(bankLookupUriNative(hex('a')), null);
  assert.deepEqual(bankRowsForMediaSourceNative([hex('a')]), []);
  assert.equal(fs.existsSync(ghost), false, 'ponte desligada não cria o SQLite');
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
