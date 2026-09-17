import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexerList, list, RETIRED_INDEXERS } from '../src/config/helpers.js';

// Normalização de ids de indexer APOSENTADOS.
//
// O id vive no .env de cada ambiente (local e VPS) e o volume do Jackett não
// expõe mais o antigo: sem normalizar na leitura, cada deploy exigiria editar o
// .env na mão e o id morto voltaria ao catálogo como OFFLINE permanente. O
// teste amarra as duas metades: o helper puro e o uso dele em TODAS as listas
// de indexer de src/config/jackett.ts (uma lista esquecida é um vazamento
// silencioso do id velho).
const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.existsSync(path.join(here, '..', 'src', 'config', 'jackett.ts'))
  ? path.join(here, '..')
  : path.join(here, '..', '..');
const jackettSrc = fs.readFileSync(path.join(root, 'src', 'config', 'jackett.ts'), 'utf8');

describe('config: ids de indexer aposentados', () => {
  test('renomeia o id aposentado do Apache para o card local', () => {
    assert.deepEqual(indexerList('apachetorrent'), ['apachetorrent-cardigann']);
    assert.deepEqual(
      indexerList('apachetorrent,eztv,1337x'),
      ['apachetorrent-cardigann', 'eztv', '1337x'],
      'a ordem do operador é preservada; só o id aposentado muda',
    );
  });

  test('deduplica quando o .env cita o velho E o novo', () => {
    // Sem isso o addon consultaria o mesmo indexer duas vezes por busca.
    assert.deepEqual(
      indexerList('apachetorrent,apachetorrent-cardigann'),
      ['apachetorrent-cardigann'],
    );
    assert.deepEqual(
      indexerList('apachetorrent-cardigann,eztv,apachetorrent'),
      ['apachetorrent-cardigann', 'eztv'],
    );
  });

  test('id não aposentado passa intacto', () => {
    // hdrtorrent está estacionado, mas NÃO é rename: se o operador escrever o
    // id (religando a fonte), sumir com a escolha dele em silêncio seria pior
    // do que deixar o indexer falhar visivelmente.
    assert.deepEqual(indexerList('hdrtorrent'), ['hdrtorrent']);
    assert.ok(!('hdrtorrent' in RETIRED_INDEXERS), 'hdrtorrent não pode virar rename');
  });

  test('mantém o contrato de list() para entrada vazia e espaços', () => {
    assert.deepEqual(indexerList(undefined), []);
    assert.deepEqual(indexerList(''), []);
    assert.deepEqual(indexerList('   '), []);
    assert.deepEqual(indexerList(' eztv , , 1337x '), ['eztv', '1337x']);
    // Mesma normalização de borda do helper original.
    assert.deepEqual(list(' eztv , , 1337x '), ['eztv', '1337x']);
  });

  test('o mapa é congelado: ninguém reescreve o rename em runtime', () => {
    assert.throws(
      () => {
        (RETIRED_INDEXERS as any).eztv = 'qualquer-coisa';
      },
      /read only|not extensible|Cannot add/i,
    );
  });

  test('TODAS as listas de indexer de jackett.ts passam pelo normalizador', () => {
    const keys = [
      'indexers',
      'resolveDownloadIndexers',
      'ptBrIndexers',
      'bareTitleIndexers',
      'slowIndexers',
      'indexOnlyIndexers',
    ];
    for (const key of keys) {
      const re = new RegExp(`^\\s*${key}: indexerList\\(`, 'm');
      assert.match(jackettSrc, re, `${key} precisa usar indexerList, não list`);
    }
    // Nenhuma lista de indexer pode ter ficado para trás no `list(` cru.
    const plain = jackettSrc.match(/^\s*\w*[Ii]ndexers: list\(/gm);
    assert.equal(plain, null, `lista de indexer sem normalização: ${plain?.join(', ')}`);
  });
});
