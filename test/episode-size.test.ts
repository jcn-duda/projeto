// Tamanho do EPISÓDIO em pack de temporada: memo de arquivos por hash, anotação
// do título (exato pelo memo, senão média da temporada) e as fontes que o
// alimentam — TorBox na checagem e a contagem de episódios do Cinemeta.
//
// Motivo medido (Goliath S03E03, 2026-09-13): a lista mostrava "💾 41.67 GB"
// numa escolha que toca UM episódio de um pack de oito.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cache from '../src/utils/cache.js';
import { annotateEpisodeSizes, packHashesMissingFiles, streamTitleBytes } from '../src/providers/episode-size.js';
import { recordFileSizes, peekFileSizes, clearFileSizes } from '../src/debrid/file-sizes.js';
import * as torbox from '../src/debrid/torbox.js';
import * as runtime from '../src/runtime.js';
import { applyDebrid } from '../src/providers/index.js';
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

test('média usa o total do título quando _size já foi apagado pelo sortAndLimit', () => {
  // Caso ao vivo (My Name Is Earl S01E01, 2026-09-13): o candidato chega à
  // anotação sem `_size`, e a média nunca aparecia.
  clearFileSizes();
  const { _size, ...semSize } = packStream() as Stream & { _size?: number };
  const [out] = annotateEpisodeSizes([semSize as Stream], { season: 3, episode: 3, meta: { episodes: { 3: 8 } } });
  assert.match(titleOf(out), /💾 5\.21 GB 📦 pack 41\.67 GB \(média\)/);
});

test('filme em coleção mostra o tamanho exato do arquivo da obra', () => {
  // Star Trek (2009), 2026-09-13: a conta tinha a filmografia inteira (22.45 GB)
  // e a lista mostrava só o total da coleção.
  clearFileSizes();
  const hash = 'b8'.repeat(20);
  const colecao = {
    name: '[AD⚡] DUB BR',
    title: 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR\n👤 1 💾 22.45 GB ⚙️ AllDebrid',
    infoHash: hash,
    _multiWork: true,
  } as Stream & { _multiWork: boolean };
  const work = { n: ['Star Trek', 'Jornada nas Estrelas'], y: 2009 };
  assert.deepEqual(packHashesMissingFiles([colecao as Stream], null), [hash], 'a checagem pede os arquivos da coleção');

  const [semArquivos] = annotateEpisodeSizes([colecao as Stream], { season: null, episode: null, work });
  assert.equal(titleOf(semArquivos), colecao.title, 'sem lista de arquivos não há média para filme');

  recordFileSizes(hash, [
    { path: 'Star Trek/Star.Trek.2009.1080p.BluRay.DUAL.mkv', size: 2.1 * GB },
    { path: 'Star Trek/Star.Trek.Into.Darkness.2013.1080p.BluRay.DUAL.mkv', size: 2.4 * GB },
    { path: 'Star Trek/Star.Trek.Beyond.2016.1080p.BluRay.DUAL.mkv', size: 2.3 * GB },
  ]);
  const trace = { stages: {} as Record<string, number>, items: [], accountItems: 0, startedAt: 0, finishedAt: null };
  const [out] = annotateEpisodeSizes([colecao as Stream], { season: null, episode: null, work, trace });
  // Marca o FILME, não a coleção: só o tamanho do arquivo escolhido na linha.
  assert.match(titleOf(out), /💾 2\.10 GB ⚙️/);
  assert.doesNotMatch(titleOf(out), /📦 pack|22\.45 GB|média/);
  assert.equal((out as Stream & { _packBytes?: number })._packBytes, Math.round(22.45 * GB), 'o total do download fica interno');
  assert.equal(
    titleOf(annotateEpisodeSizes([out], { season: null, episode: null, work, trace })[0]),
    titleOf(out),
    'passe seguinte não anota de novo',
  );
  assert.equal(trace.stages['episodeSize.movie.exact'], 1);

  const avulso = { ...colecao, _multiWork: false } as Stream;
  assert.equal(titleOf(annotateEpisodeSizes([avulso], { season: null, episode: null, work })[0]), colecao.title, 'filme avulso fica como está');
  clearFileSizes();
});

test('stream do Torrentio já traz o tamanho do arquivo e não vira média', () => {
  // O nome do arquivo sem SxxEyy faz o título parecer pack; o 💾 do Torrentio
  // é do episódio escolhido, e dividir de novo mostraria 58 MB num arquivo de 1.36 GB.
  clearFileSizes();
  const tio = {
    name: '720p HDTV',
    title: 'Adim Farah Season 1 720p HDTV\n01 Adim Farah.avi\n👤 1 💾 1.36 GB ⚙️ Rutracker',
    infoHash: 'a7'.repeat(20),
    _indexer: 'torrentio',
  } as Stream & { _indexer: string };
  const [out] = annotateEpisodeSizes([tio as Stream], { season: 1, episode: 1, meta: { episodes: { 1: 24 } } });
  assert.equal(titleOf(out), tio.title);
});

test('streamTitleBytes lê o total do download, não o tamanho do episódio', () => {
  assert.equal(streamTitleBytes(PACK_TITLE), Math.round(41.67 * GB));
  assert.equal(streamTitleBytes('Goliath S03\n👤 10 💾 5.21 GB 📦 pack 41.67 GB (média) ⚙️ tpb'), Math.round(41.67 * GB));
  assert.equal(streamTitleBytes('Sem marcador'), 0);
});

test('pack de várias temporadas divide pelos episódios de todas elas', () => {
  // My Name Is Earl (2026-09-13): "S01 S04" de 70.36 GB aparecia em S01E01;
  // dividir só pelos 24 da primeira temporada daria 2.93 GB por episódio.
  clearFileSizes();
  const episodes = { 1: 24, 2: 23, 3: 22, 4: 27 };
  const multi = {
    name: '[AD⚡] 1080p',
    title: 'My Name Is Earl (2005) Season 1 4 S01 S04 (1080p Mixed x265) REPACK\n👤 80 💾 70.36 GB ⚙️ LimeTorrents',
    infoHash: 'e5'.repeat(20),
    _size: Math.round(70.36 * GB),
  } as Stream;
  const [out] = annotateEpisodeSizes([multi], { season: 1, episode: 1, meta: { episodes } });
  assert.match(titleOf(out), /💾 750\.5\d MB 📦 pack 70\.36 GB \(média\)/);

  const [semContagem] = annotateEpisodeSizes([multi], { season: 1, episode: 1, meta: { episodes: { 1: 24 } } });
  assert.equal(titleOf(semContagem), multi.title, 'sem a contagem de todas as temporadas cobertas, não estima');
});

test('stream-trace conta exato, média e o motivo de cada pack sem anotação', () => {
  clearFileSizes();
  recordFileSizes(PACK, [{ path: 'Goliath.S03/Goliath.S03E03.2160p.mkv', size: 4.9 * GB }]);
  const semContagem = { ...packStream(), infoHash: 'f6'.repeat(20) } as Stream;
  const trace = { stages: {} as Record<string, number>, items: [], accountItems: 0, startedAt: 0, finishedAt: null };
  annotateEpisodeSizes([packStream(), semContagem, avulsoStream()], { season: 3, episode: 3, meta: { episodes: {} }, trace });
  assert.equal(trace.stages['episodeSize.exact'], 1);
  assert.equal(trace.stages['episodeSize.skip.no-episode-count'], 1, 'pack sem memo e sem contagem diz o motivo');
  assert.equal(Object.keys(trace.stages).length, 2, 'episódio avulso não entra no funil');
  clearFileSizes();
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

// Beverly Hills Cop (1984), 2026-09-18: o Torrentdosfilmes publica o post
// "opção 2" sem tamanho (Jackett carimba 1024 bytes) e o stream saía sem 💾
// mesmo com o ⚡ — a AllDebrid já tinha a lista de arquivos.
const SEM_TAMANHO = 'c3'.repeat(20);
const semTamanhoStream = (title = 'Tira da Pesada (1984) BluRay 5.1 [1080p BLURAY DUBLADO opção 2]\n👤 1 ⚙️ torrentdosfilmesv2') => ({
  name: '[AD⚡] 1080p BluRay',
  title,
  infoHash: SEM_TAMANHO,
}) as Stream;

test('stream sem 💾 entra na leitura de arquivos e ganha o tamanho do vídeo', () => {
  clearFileSizes();
  assert.deepEqual(packHashesMissingFiles([semTamanhoStream(), avulsoStream()], null), [SEM_TAMANHO]);
  assert.deepEqual(packHashesMissingFiles([semTamanhoStream()], 3), [SEM_TAMANHO], 'série também pede');
  recordFileSizes(SEM_TAMANHO, [
    { path: 'Tira.da.Pesada.1984.1080p.mkv', size: 2.34 * GB },
    { path: 'Sample/sample.mkv', size: 50 * 1024 ** 2 },
  ]);
  assert.equal(packHashesMissingFiles([semTamanhoStream()], null).length, 0, 'lista conhecida não relê');
  const [out] = annotateEpisodeSizes([semTamanhoStream()], { season: null, episode: null });
  assert.equal(titleOf(out), 'Tira da Pesada (1984) BluRay 5.1 [1080p BLURAY DUBLADO opção 2]\n👤 1 💾 2.34 GB ⚙️ torrentdosfilmesv2');
  assert.equal(out?._size, undefined, '_size não muda: o filtro já tratou como desconhecido');
  clearFileSizes();
});

test('episódio sem 💾 mede o arquivo do episódio; sem lista ou sem episódio fica como está', () => {
  clearFileSizes();
  const title = 'Serie S01E02 1080p DUBLADO\n👤 ~ ⚙️ comandotorrents';
  assert.equal(titleOf(annotateEpisodeSizes([semTamanhoStream(title)], { season: 1, episode: 2 })[0]), title);
  recordFileSizes(SEM_TAMANHO, [
    { path: 'Serie.S01E01.mkv', size: 1 * GB },
    { path: 'Serie.S01E02.mkv', size: 1.5 * GB },
  ]);
  const [out] = annotateEpisodeSizes([semTamanhoStream(title)], { season: 1, episode: 2 });
  assert.match(titleOf(out), /👤 ~ 💾 1\.50 GB ⚙️ comandotorrents$/);
  const [semEpisodio] = annotateEpisodeSizes([semTamanhoStream(title)], { season: 1, episode: null });
  assert.equal(titleOf(semEpisodio), title);
  clearFileSizes();
});

test('coleção sem 💾 e sem a obra marcada não chuta o maior arquivo', () => {
  clearFileSizes();
  recordFileSizes(SEM_TAMANHO, [
    { path: 'Filme.1.mkv', size: 3 * GB },
    { path: 'Filme.2.mkv', size: 4 * GB },
  ]);
  const colecao = { ...semTamanhoStream(), _multiWork: true } as Stream;
  const [out] = annotateEpisodeSizes([colecao], { season: null, episode: null });
  assert.equal(titleOf(out), titleOf(colecao));
  clearFileSizes();
});

test('lista de arquivos vai ao namespace persistido fsz e guarda só vídeos', () => {
  // Em memória, cada restart zerava a lista e a primeira abertura voltava a
  // mostrar o total do pack (Star Trek 2009, 2026-09-14: três restarts no dia).
  clearFileSizes();
  try {
    recordFileSizes('c3'.repeat(20), [{ path: 'leia.txt', size: 10 }]);
    assert.equal(peekFileSizes('c3'.repeat(20)), null, 'torrent sem vídeo não entra');
    recordFileSizes('d1'.repeat(20), [
      { path: 'Obra/a.mkv', size: GB },
      { path: 'Obra/Sample/a.sample.mkv', size: 50 * 1024 ** 2 },
    ]);
    assert.ok(peekFileSizes('D1'.repeat(20)), 'hash não diferencia maiúscula');
    assert.equal(peekFileSizes('d1'.repeat(20))?.length, 1, 'amostra fica de fora');
    const keys = cache.keysMatching('fsz:');
    assert.equal(keys.length, 1, 'uma entrada por hash no namespace fsz');
    assert.ok((cache.peekRemaining(keys[0]) ?? 0) > 29 * 86400, 'TTL longo: o conteúdo de um hash não muda');
    assert.equal(cache.QUOTAS.fsz, 3000);
    clearFileSizes();
    assert.equal(peekFileSizes('d1'.repeat(20)), null, 'clearFileSizes esvazia só o namespace');
  } finally {
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

test('fsz que só aparece na checagem anota o filme individual já na primeira resposta', async () => {
  // Star Trek (2009) em pack multiobra, 2026-09-14: a lista de arquivos só é
  // lida DENTRO da checagem da AllDebrid (o /magnet/status por id vem depois do
  // upload). Com a leitura esperada dentro do orçamento da checagem e a
  // reanotação pós-checagem no applyDebrid, o 💾 sai com o tamanho do FILME na
  // primeira resposta — não com os 22.45 GB da coleção.
  clearFileSizes();
  const hash = 'c4'.repeat(20);
  const colecao = {
    name: 'DUB BR',
    title: 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR\n👤 1 💾 22.45 GB ⚙️ AllDebrid',
    infoHash: hash,
    _multiWork: true,
    _multiWorkAdmitted: true,
  } as Stream;
  const work = { n: ['Star Trek', 'Jornada nas Estrelas'], y: 2009 };
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-episodio-tamanho-pack',
  };
  const realFetch = globalThis.fetch;
  const caminhos: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const u = new URL(String(url));
    caminhos.push(u.pathname);
    if (u.pathname.endsWith('/magnet/upload')) {
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: { magnets: [{ hash, ready: true, id: 42 }] },
        }),
      };
    }
    // /magnet/status: serve o inventário (lista) e a leitura de arquivos por id.
    return {
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          magnets: [{
            id: 42,
            hash,
            status: 'Ready',
            filename: 'FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS',
            size: Math.round(22.45 * GB),
            files: [{
              n: 'Star Trek',
              e: [
                { n: 'Star.Trek.2009.1080p.BluRay.DUAL.mkv', s: 2.1 * GB, l: 'http://ad/link-1' },
                { n: 'Star.Trek.Into.Darkness.2013.1080p.BluRay.DUAL.mkv', s: 2.4 * GB, l: 'http://ad/link-2' },
              ],
            }],
          }],
        },
      }),
    };
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await runtime.run({ opts, encoded: 'ad-epsize' } as any, () =>
      applyDebrid([colecao], {
        season: null,
        episode: null,
        workHint: work,
        deadlineAt: Date.now() + 8000,
      } as any),
    ) as Stream[];
    assert.ok(caminhos.some((p) => p.endsWith('/magnet/upload')), 'a checagem consultou a conta');
    assert.equal(result.length, 1);
    assert.match(String(result[0].name), /\[AD⚡\]/, 'pack pronto toca na hora');
    assert.match(String(result[0].title), /💾 2\.10 GB/, 'o 💾 mostra o tamanho do FILME escolhido');
    assert.doesNotMatch(String(result[0].title), /22\.45 GB/, 'o total da coleção sai da linha');
    assert.equal(
      (result[0] as Stream & { _packBytes?: number })._packBytes,
      Math.round(22.45 * GB),
      'o total do download fica interno (o filtro de tamanho segue valendo)',
    );
  } finally {
    globalThis.fetch = realFetch;
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
