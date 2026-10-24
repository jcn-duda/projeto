import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexerList, list, renameIndexerId, renameIndexerIds, RETIRED_INDEXERS } from '../src/config/helpers.js';
import * as runtime from '../src/runtime.js';

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
// O Rust decide a lista EFETIVA da busca (desde o F4.4) e o TS ainda serve o
// `/configure` e as listas do env: os dois precisam mandar o MESMO id ao
// Jackett. O mapa é lido do arquivo do núcleo para amarrar os dois lados.
const retiredSrc = fs.readFileSync(
  path.join(root, 'rust', 'crates', 'adom-core', 'src', 'retired_indexers.rs'),
  'utf8',
);

const { normalize } = runtime;

/** Mapa de renames do Rust lido do fonte: `("velho", "novo")`. */
function mapaRust(): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\(\s*"([a-z0-9_-]+)"\s*,\s*"([a-z0-9_-]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(retiredSrc)) !== null) out[m[1]] = m[2];
  return out;
}

describe('config: ids de indexer aposentados', () => {
  test('renomeia o id aposentado do Apache para o card local', () => {
    assert.deepEqual(indexerList('apachetorrent'), ['apachetorrent-cardigann']);
    assert.deepEqual(
      indexerList('apachetorrent,eztv,1337x'),
      ['apachetorrent-cardigann', 'eztv', '1337x'],
      'a ordem do operador é preservada; só o id aposentado muda',
    );
  });

  test('renomeia o id aposentado do TorrentGalaxy para o card local', () => {
    assert.deepEqual(indexerList('torrentgalaxyclone'), ['torrentgalaxy-cardigann']);
    assert.equal(renameIndexerId('torrentgalaxyclone'), 'torrentgalaxy-cardigann');
    assert.deepEqual(
      renameIndexerIds(['torrentgalaxyclone', 'eztv']),
      ['torrentgalaxy-cardigann', 'eztv'],
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

  // ── o `ji` selado na URL de quem JÁ INSTALOU ──────────────────────────────
  //
  // O `ji` é a lista que a busca consulta. Quem instalou antes do
  // aposentadoria tem o id VELHO gravado no link e o card velho é ESTACIONADO
  // (some do catálogo do Jackett): sem o rename, a instalação continua
  // consultando um id morto e o indexer simplesmente desaparece.

  test('o ji da URL vira o card substituto', () => {
    assert.deepEqual(normalize({ ji: 'torrentgalaxyclone' }).jackettIndexers, [
      'torrentgalaxy-cardigann',
    ]);
    assert.deepEqual(
      normalize({ ji: 'torrentgalaxyclone,torrentgalaxy-cardigann,eztv' }).jackettIndexers,
      ['torrentgalaxy-cardigann', 'eztv'],
      'o id velho e o novo não viram duas consultas ao mesmo card',
    );
  });

  test('prioridade e limite por indexer seguem o id renomeado', () => {
    // O `ip` e o `jl` guardam o MESMO id do `ji`: sem o rename neles, a
    // prioridade e o limite que o usuário fixou sumiriam junto com o indexer.
    assert.deepEqual(normalize({ ip: 'torrentgalaxyclone' }).indexerPriority, [
      'torrentgalaxy-cardigann',
    ]);
    assert.deepEqual(normalize({ jl: 'torrentgalaxyclone:5' }).indexerLimits, {
      'torrentgalaxy-cardigann': 5,
    });
  });

  test('o mapa do Rust é o MESMO mapa do TS', () => {
    // Divergir entre os dois lados faria o TS mandar um id ao Jackett e o Rust
    // outro — o indexer sumiria da busca sem erro visível.
    assert.deepEqual(mapaRust(), { ...RETIRED_INDEXERS });
  });
});
