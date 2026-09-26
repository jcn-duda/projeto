// Pack que repete, byte a byte, o arquivo de uma release avulsa. Caso medido
// em Star Trek Beyond (2026-09-24): a coleção "FILMOGRAFIA COMPLETA JORNADA NAS
// ESTRELAS" tocaria um arquivo de 2.389.448.021 bytes, o tamanho exato do
// torrent avulso "Star Trek Sem Fronteiras 2016 Bluray 1080p Dublado - TPF".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import { recordFileSizes } from '../src/debrid/file-sizes.js';
import { dropDuplicatePackFiles } from '../src/providers/duplicate-pack.js';

const PACK = 'a'.repeat(40);
const SOLO = 'b'.repeat(40);
const FILE = 2389448021;
const work = { n: ['Filme Teste Sem Fronteiras'], y: 2016 };
const pack = { name: 'pack', title: 'FILMOGRAFIA COMPLETA', infoHash: PACK } as any;
const solo = (bytes = FILE) => ({ name: 'solo', title: 'Filme Teste Sem Fronteiras 2016 1080p Dublado', infoHash: SOLO, _bytes: bytes }) as any;

beforeEach(() => {
  cache.clear();
  recordFileSizes(PACK, [
    { path: 'COLECAO/12 - Filme Teste Outro - 2013.mp4', size: 1658013619 },
    { path: 'COLECAO/13 - Filme Teste Sem Fronteiras - 2016.mp4', size: FILE },
  ] as any);
});

test('filme: pack que repete o arquivo exato do avulso sai; o avulso fica', () => {
  const out = dropDuplicatePackFiles([pack, solo()], { work, cached: new Set([PACK, SOLO]) });
  assert.deepEqual(out.map((s: any) => s.name), ['solo']);
});

test('um byte de diferença não é o mesmo arquivo', () => {
  const out = dropDuplicatePackFiles([pack, solo(FILE + 1)], { work, cached: new Set([PACK, SOLO]) });
  assert.equal(out.length, 2);
});

test('não troca play instantâneo por download: pack ⚡ e avulso sem ⚡ ficam os dois', () => {
  assert.equal(dropDuplicatePackFiles([pack, solo()], { work, cached: new Set([PACK]) }).length, 2);
  // Nenhum dos dois em cache: o avulso é tão pronto quanto o pack.
  assert.equal(dropDuplicatePackFiles([pack, solo()], { work, cached: new Set() }).length, 1);
});

test('sem medida dos dois lados nada muda', () => {
  cache.clear();
  // Pack sem lista de arquivos não é medido; o avulso sozinho não decide.
  assert.equal(dropDuplicatePackFiles([pack, solo()], { work, cached: new Set([PACK, SOLO]) }).length, 2);
});

test('série: pack da temporada cai diante do episódio avulso de mesmo tamanho', () => {
  const season = 'c'.repeat(40);
  recordFileSizes(season, [
    { path: 'Show.S01/Show.S01E01.720p.x265-T0PAZ.mkv', size: 335896617 },
    { path: 'Show.S01/Show.S01E02.720p.x265-T0PAZ.mkv', size: 289782300 },
    { path: 'Show.S01/Show.S01E03.720p.x265-T0PAZ.mkv', size: 349345771 },
  ] as any);
  const seasonPack = { name: 'season', title: 'Show S01 720p', infoHash: season } as any;
  const episode = { name: 'ep', title: 'Show S01E02 720p x265 T0PAZ', infoHash: SOLO, _bytes: 289782300 } as any;
  const cached = new Set([season, SOLO]);
  assert.deepEqual(
    dropDuplicatePackFiles([seasonPack, episode], { season: 1, episode: 2, cached }).map((s: any) => s.name),
    ['ep'],
  );
  // Outro episódio pedido: o arquivo tocado no pack é outro, nada sai.
  assert.equal(dropDuplicatePackFiles([seasonPack, episode], { season: 1, episode: 3, cached }).length, 2);
});
