// Tamanho do EPISÓDIO em pack de temporada: memo de arquivos por hash, anotação
// do título (exato pelo memo, senão média da temporada) e as fontes que o
// alimentam — TorBox na checagem e a contagem de episódios do Cinemeta.
//
// Motivo medido (Goliath S03E03, 2026-09-13): a lista mostrava "💾 41.67 GB"
// numa escolha que toca UM episódio de um pack de oito.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { annotateEpisodeSizes, packHashesMissingFiles } from '../src/providers/episode-size.js';
import { recordFileSizes, peekFileSizes, clearFileSizes } from '../src/debrid/file-sizes.js';
import * as torbox from '../src/debrid/torbox.js';
import { getMeta } from '../src/utils/cinemeta.js';
import { stubFetch } from './helpers/stub.js';
import type { Stream } from '../types/domain.js';

const GB = 1024 ** 3;
const PACK = 'a1'.repeat(20);
const EPISODE = 'b2'.repeat(20);
const PACK_TITLE = 'Goliath.S03.2160p.AMZN.WEB-DL.x265.10bit.HDR.DDP5.1-SKGTV\n👤 10 💾 41.67 GB ⚙️ thepiratebay';

const packStream = () => ({
  name: '[AD⚡] 4K WEB-DL',
  title: PACK_TITLE,
  infoHash: PACK,
  _size: Math.round(41.67 * GB),
}) as Stream;

const avulsoStream = () => ({
  name: '[AD⚡] 1080p WEB-DL',
  title: 'Goliath S03E03 Good Morning Central Valley 1080p AMZN WEB-DL\n👤 43 💾 2.19 GB ⚙️ kickass',
  infoHash: EPISODE,
  _size: Math.round(2.19 * GB),
}) as Stream;

const titleOf = (stream: Stream | null | undefined) => String(stream?.title || '');

test('pack com arquivos conhecidos mostra o tamanho real do episódio e o total do pack', () => {
  clearFileSizes();
  recordFileSizes(PACK, [
    { path: 'Goliath.S03/Goliath.S03E01.2160p.mkv', size: 5.1 * GB },
    { path: 'Goliath.S03/Goliath.S03E03.2160p.mkv', size: 4.9 * GB },
    { path: 'Goliath.S03/Sample/goliath.s03e03.sample.mkv', size: 60 * 1024 ** 2 },
  ]);
  const [out] = annotateEpisodeSizes([packStream()], { season: 3, episode: 3, meta: { episodes: { 3: 8 } } });
  assert.match(titleOf(out), /💾 4\.90 GB 📦 pack 41\.67 GB/);
  assert.doesNotMatch(titleOf(out), /média/, 'medida real não se anuncia como média');
  assert.equal(out?._size, Math.round(41.67 * GB), '_size segue o total: o filtro de tamanho vale para o download');
  clearFileSizes();
});

test('sem arquivos conhecidos usa a média da temporada e diz que é média', () => {
  clearFileSizes();
  const [out] = annotateEpisodeSizes([packStream()], { season: 3, episode: 3, meta: { episodes: { 3: 8 } } });
  assert.match(titleOf(out), /💾 5\.21 GB 📦 pack 41\.67 GB \(média\)/);
});

test('episódio avulso, pack sem dado nenhum e filme ficam como estão', () => {
  clearFileSizes();
  const [avulso, pack] = annotateEpisodeSizes([avulsoStream(), packStream()], { season: 3, episode: 3, meta: null });
  assert.equal(titleOf(avulso), titleOf(avulsoStream()));
  assert.equal(titleOf(pack), PACK_TITLE);
  const [filme] = annotateEpisodeSizes([packStream()], { season: null, episode: null, meta: { episodes: { 3: 8 } } });
  assert.equal(titleOf(filme), PACK_TITLE);
});

test('a checagem recebe só os packs cujos arquivos ainda não são conhecidos', () => {
  clearFileSizes();
  assert.equal(packHashesMissingFiles([packStream(), avulsoStream(), null], 3).join(','), PACK);
  recordFileSizes(PACK, [{ path: 'Goliath.S03E03.mkv', size: 5 * GB }]);
  assert.equal(packHashesMissingFiles([packStream(), avulsoStream()], 3).length, 0);
  assert.equal(packHashesMissingFiles([packStream()], null).length, 0);
  clearFileSizes();
});

test('memo guarda só vídeos e respeita o teto em LRU', () => {
  clearFileSizes();
  const original = config.debrid.fileSizesMax;
  config.debrid.fileSizesMax = 2;
  try {
    recordFileSizes('c3'.repeat(20), [{ path: 'leia.txt', size: 10 }]);
    assert.equal(peekFileSizes('c3'.repeat(20)), null, 'torrent sem vídeo não entra');
    recordFileSizes('d1'.repeat(20), [{ path: 'a.mkv', size: GB }]);
    recordFileSizes('d2'.repeat(20), [{ path: 'b.mkv', size: GB }]);
    recordFileSizes('d3'.repeat(20), [{ path: 'c.mkv', size: GB }]);
    assert.equal(peekFileSizes('d1'.repeat(20)), null, 'o mais antigo sai');
    assert.ok(peekFileSizes('D3'.repeat(20)), 'hash não diferencia maiúscula');
  } finally {
    config.debrid.fileSizesMax = original;
    clearFileSizes();
  }
});

test('TorBox pede list_files só com pack sem arquivos e grava a lista na checagem', async () => {
  clearFileSizes();
  const body = {
    success: true,
    data: [{
      hash: PACK,
      name: 'Goliath.S03.2160p',
      files: [{ name: 'Goliath.S03/Goliath.S03E03.2160p.mkv', short_name: 'Goliath.S03E03.2160p.mkv', size: 4.9 * GB }],
    }],
  };
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  try {
    await torbox.checkCached('chave-tb', [PACK, EPISODE], { fileHashes: [PACK] });
    assert.equal(new URL(stub.calls[0].url).searchParams.get('list_files'), 'true');
    assert.equal(peekFileSizes(PACK)?.[0]?.size, 4.9 * GB, 'lista do pack gravada na mesma chamada');

    await torbox.checkCached('chave-tb', [EPISODE]);
    assert.equal(new URL(stub.calls[1].url).searchParams.get('list_files'), 'false', 'sem pack pendente, sem lista');
  } finally {
    stub.restore();
    clearFileSizes();
  }
});

test('Cinemeta conta episódios por temporada sem os especiais', async () => {
  const imdbId = `tt-ep-${process.pid}-${Date.now()}`;
  const videos = [{ season: 0 }, { season: 1 }, { season: 1 }, { season: 3 }, { season: 3 }, { season: 3 }];
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ meta: { name: 'Goliath', year: '2016', videos } }) }));
  try {
    const meta = await getMeta('series', imdbId);
    assert.equal(JSON.stringify(meta?.episodes), JSON.stringify({ 1: 2, 3: 3 }));
  } finally {
    stub.restore();
    cache.forget(`meta:series:${imdbId}`);
  }
});

test('meta de série gravada sem a contagem volta ao Cinemeta uma única vez', async () => {
  const imdbId = `tt-ep-antiga-${process.pid}-${Date.now()}`;
  const key = `meta:series:${imdbId}`;
  cache.set(key, { name: 'Goliath', year: '2016', type: 'series' }, 60);
  const stub = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ meta: { name: 'Goliath', year: '2016', videos: [{ season: 3 }] } }) }));
  try {
    const meta = await getMeta('series', imdbId);
    assert.equal(stub.calls.length, 1, 'a meta antiga busca a contagem');
    assert.equal(JSON.stringify(meta?.episodes), JSON.stringify({ 3: 1 }));
    await getMeta('series', imdbId);
    assert.equal(stub.calls.length, 1, 'a meta atualizada não chama de novo');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});

test('falha ao atualizar a meta antiga devolve a meta gravada, sem virar miss', async () => {
  const imdbId = `tt-ep-falha-${process.pid}-${Date.now()}`;
  const key = `meta:series:${imdbId}`;
  cache.set(key, { name: 'Goliath', year: '2016', type: 'series' }, 60);
  const stub = stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    const meta = await getMeta('series', imdbId);
    assert.equal(meta?.name, 'Goliath', 'a busca segue com nome e ano');
    assert.equal(cache.get(key)?.name, 'Goliath', 'a entrada gravada não vira miss');
  } finally {
    stub.restore();
    cache.forget(key);
  }
});
