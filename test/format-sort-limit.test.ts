// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// ordenação e dedupe — sortAndLimit (qualidade, seeders, episódio exato,
// CAM, tamanho, lotes grandes), dedupeByHash (origem/áudio do vencedor,
// prioridade de indexador) e os pools do autofetch (topSeededPool).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  toStremioStream,
  dedupeByHash,
  sortAndLimit,
  topSeededPool,
  pickTopSeededCandidates,
} from '../src/utils/format.js';
import type { RawItem, Stream } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// O retorno de toStremioStream é `Stream | null` (null quando falta hash) e os
// campos de exibição são opcionais no tipo; todos os casos abaixo passam hash
// válido e os tocam, então o wrapper local só documenta o invariante — em vez
// de um cast no lugar em 40+ chamadas.
type TestStream = Stream & { infoHash: string; name: string; title: string; behaviorHints: { bingeGroup: string } };
const stremioStream = (item: RawItem): TestStream => toStremioStream(item) as TestStream;

test('topSeededPool rejeita CAM, piso e idiomas estrangeiros explícitos', () => {
  const streams = [
    { infoHash: '1'.repeat(40), title: 'Lost Girl S03 TrueFrench 1080p', _seeders: 10 },
    { infoHash: '2'.repeat(40), title: 'Lost Girl S03 FRENCH 1080p', _seeders: 9 },
    { infoHash: '3'.repeat(40), title: 'Lost Girl S03 CAM MULTI 1080p', _seeders: 20 },
    { infoHash: '4'.repeat(40), title: 'Lost Girl S03 MULTI 720p', _seeders: 6 },
    { infoHash: '5'.repeat(40), title: 'Lost Girl S03 720p', _seeders: 1 },
  ];
  assert.deepEqual(topSeededPool(streams, { season: 3, minSeeders: 3 }).map((s) => s.infoHash), ['4'.repeat(40)]);
});

test('topSeededPool prefere pack, depois seeders e deixa PT explícito passar', () => {
  const pack = { infoHash: '6'.repeat(40), title: 'Lost Girl S03 720p MULTI', _seeders: 4 };
  const episode = { infoHash: '7'.repeat(40), title: 'Lost Girl S03E01 1080p DUBLADO PT-BR', _seeders: 12 };
  const highQuality = { infoHash: '8'.repeat(40), title: 'Lost Girl S03 2160p', _seeders: 4 };
  assert.equal(topSeededPool([episode, highQuality, pack], { season: 3, minSeeders: 3 })[0], pack);
  assert.equal(pickTopSeededCandidates([episode, highQuality, pack], new Set(), 2, { season: 3, minSeeders: 3 }).length, 2);
});

test('dedupeByHash mantém origem e áudio do post vencedor', () => {
  const br = stremioStream({
    title: 'Filme Dublado', infoHash: HASH, seeders: 300, tracker: 'Bludv', isBr: true,
  });
  const global = stremioStream({
    title: 'Movie 1080p BluRay DUAL', infoHash: HASH, seeders: 1, tracker: 'The Pirate Bay',
  });
  const [brWinner] = dedupeByHash([br, global]);
  assert.equal(brWinner._br, true);
  assert.equal(brWinner._dubbed, true);
  assert.match(brWinner.name, /BR/);

  const globalPopular = stremioStream({
    title: 'Movie 1080p BluRay DUAL', infoHash: HASH, seeders: 300, tracker: 'The Pirate Bay',
  });
  const brSparse = stremioStream({
    title: 'Filme Dublado', infoHash: HASH, seeders: 1, tracker: 'Bludv', isBr: true,
  });
  const [globalWinner] = dedupeByHash([globalPopular, brSparse]);
  assert.equal(globalWinner._br, false);
  assert.equal(globalWinner._dubbed, false);
  assert.equal(globalWinner.name, '1080p BluRay DUAL · The Pirate Bay · 👤 300');
  assert.doesNotMatch(globalWinner.name, /BR|DUB/);
  assert.equal(dedupeByHash([null]).length, 0);
});

test('dedupe usa indexador prioritário no empate sem depender da chegada', () => {
  const global = {
    infoHash: HASH, _seeders: 10, _indexer: 'thepiratebay',
    _br: false, _dubbed: false, title: 'Filme 1080p',
  };
  const preferred = {
    infoHash: HASH, _seeders: 10, _indexer: 'nerdfilmes',
    _br: true, _dubbed: true, title: 'Filme Dublado 1080p',
  };

  for (const input of [[global, preferred], [preferred, global]]) {
    const [out] = dedupeByHash(input, ['nerdfilmes'] as never[]);
    assert.equal(out._indexer, 'nerdfilmes');
    assert.equal(out.title, 'Filme Dublado 1080p');
    assert.equal(out._br, true);
    assert.equal(out._dubbed, true);
  }
});

test('dedupe prioritário preserva resolução e tamanho conhecidos do mesmo hash', () => {
  const global = stremioStream({
    title: 'Filme 1080p WEB-DL', infoHash: HASH, seeders: 1,
    size: 4 * 1024 ** 3, tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const br = stremioStream({
    title: 'Filme Dublado', infoHash: HASH, seeders: 1,
    tracker: 'NerdFilmes', indexer: 'nerdfilmes', isBr: true,
  });
  const [out] = dedupeByHash([global, br], ['nerdfilmes'] as never[]);

  assert.equal(out._indexer, 'nerdfilmes');
  assert.equal(out._quality, '1080p');
  assert.equal(out._size, 4 * 1024 ** 3);
  assert.equal(out.behaviorHints.bingeGroup, 'powerm-1080p-WEB-DL');
  assert.equal(out._br, true);
  assert.equal(out._dubbed, true);
});

test('sortAndLimit ordena por qualidade e seeders, filtra e limpa internos', () => {
  const streams = [
    { infoHash: HASH, _seeders: 1, _quality: '1080p', _br: true, _tracker: 'Bludv', title: 'BR 1080p', name: 'n' },
    { infoHash: OTHER, _seeders: 500, _quality: '720p', _br: false, title: 'x 720p', name: 'n' },
    { infoHash: 'c'.repeat(40), _seeders: 900, _quality: '2160p', _br: false, title: 'x 2160p', name: 'n' },
  ];
  const out = sortAndLimit(streams, { minSeeders: 1, maxResults: 10, qualityFilter: [] });
  assert.deepEqual(out.map((s) => s.title), ['x 2160p', 'BR 1080p', 'x 720p']);
  // 1080p acima de 720p mesmo com menos seeders.
  assert.equal(out[1].title, 'BR 1080p');
  assert.equal(out[1]._tracker, 'Bludv', 'o campo precisa sobreviver até o corte pós-debrid');
  // O pool preserva qualidade/origem até o corte final pós-debrid.
  assert.ok(out.every((s) => !('_seeders' in s)));
  assert.equal(out[0]._quality, '2160p');
  // Piso de seeders descarta; filtro de qualidade restringe.
  assert.equal(sortAndLimit(streams, { minSeeders: 100 }).length, 2);
  assert.equal(sortAndLimit(streams, { qualityFilter: ['2160p'] as never[] })[0].title, 'x 2160p');
  assert.equal(sortAndLimit(streams, { maxResults: 1 }).length, 1);
});

test('prioridade de indexador desempata dentro da qualidade sem vencer resolução', () => {
  const preferred1080 = stremioStream({
    title: 'Filme 1080p', infoHash: HASH, seeders: 1,
    tracker: 'NerdFilmes', indexer: 'nerdfilmes',
  });
  const popular1080 = stremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 500,
    tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const global4k = stremioStream({
    title: 'Filme 2160p', infoHash: 'c'.repeat(40), seeders: 1,
    tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const out = sortAndLimit([popular1080, preferred1080, global4k], {
    indexerPriority: ['nerdfilmes'] as never[],
  });

  assert.deepEqual(out.map((stream) => stream.infoHash), [global4k.infoHash, HASH, OTHER]);
});

test('preferência dublada vence prioridade de indexador na mesma qualidade', () => {
  const preferredLegendado = stremioStream({
    title: 'Filme Legendado 1080p', infoHash: HASH, seeders: 100,
    tracker: 'NerdFilmes', indexer: 'nerdfilmes',
  });
  const dublado = stremioStream({
    title: 'Filme Dublado 1080p', infoHash: OTHER, seeders: 1,
    tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const out = sortAndLimit([preferredLegendado, dublado], {
    preferDubbed: true,
    indexerPriority: ['nerdfilmes'] as never[],
  });

  assert.equal(out[0].infoHash, OTHER);
});

test('sortAndLimit põe o episódio exato antes do pack da temporada', () => {
  const pack = stremioStream({ title: 'Serie 1a Temporada 2160p', infoHash: HASH, seeders: 5 });
  const ep = stremioStream({ title: 'Serie S01E01 1080p', infoHash: OTHER, seeders: 1 });
  const out = sortAndLimit([pack, ep], { season: 1 as never, episode: 1 as never });
  assert.match(out[0].title, /S01E01/);
});

test('sortAndLimit pode priorizar áudio dublado dentro da mesma qualidade', () => {
  const legendado = stremioStream({
    title: 'Filme Legendado 1080p', infoHash: HASH, seeders: 500,
  });
  const dublado = stremioStream({
    title: 'Filme Dublado 1080p', infoHash: OTHER, seeders: 5,
  });

  assert.match(sortAndLimit([legendado, dublado])[0].title, /Legendado/);
  assert.match(sortAndLimit([legendado, dublado], { preferDubbed: true })[0].title, /Dublado/);
});

test('sortAndLimit não promove DUAL global sobre dublado BR', () => {
  const globalDual = stremioStream({
    title: 'Movie 1080p DUAL', infoHash: HASH, seeders: 500,
  });
  const brDubbed = stremioStream({
    title: 'Filme 1080p Dublado', infoHash: OTHER, seeders: 1, isBr: true,
  });

  assert.equal(sortAndLimit([globalDual, brDubbed], { preferDubbed: true })[0].infoHash, OTHER);
});

test('sortAndLimit oculta CAM somente quando solicitado', () => {
  const cam = stremioStream({ title: 'Filme CAM 1080p', infoHash: HASH, seeders: 50 });
  const web = stremioStream({ title: 'Filme WEB-DL 1080p', infoHash: OTHER, seeders: 5 });

  assert.equal(sortAndLimit([cam, web]).length, 2);
  assert.deepEqual(sortAndLimit([cam, web], { excludeCam: true }).map((s) => s.infoHash), [OTHER]);
});

test('sortAndLimit limita tamanho sem descartar tamanho desconhecido', () => {
  const large = stremioStream({
    title: 'Filme 1080p', infoHash: HASH, seeders: 50, size: 21 * 1024 ** 3,
  });
  const small = stremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 5, size: 9 * 1024 ** 3,
  });
  const unknown = stremioStream({
    title: 'Filme 720p', infoHash: 'c'.repeat(40), seeders: 1,
  });

  const out = sortAndLimit([large, small, unknown], { maxSizeGb: 10 });
  assert.deepEqual(out.map((s) => s.infoHash), [OTHER, 'c'.repeat(40)]);
  assert.ok(out.every((s) => !('_size' in s)));
});

test('merge de hash igual não empresta origem ou áudio do post BR perdedor', () => {
  // Agregador BR pode apontar para o mesmo magnet público: a evidência do post
  // perdedor não pode marcar como dublado a release do tracker global vencedor.
  const global = stremioStream({
    title: 'Fallout 1a Temporada 2160p', infoHash: HASH,
    seeders: 100, size: 11 * 1024 ** 3, tracker: 'The Pirate Bay', indexer: 'thepiratebay', isBr: false,
  });
  const br = stremioStream({
    title: 'Fallout 1a Temporada (2024) WEB-DL [DUBLADO]', infoHash: HASH,
    seeders: 1, tracker: 'Bludv', indexer: 'bludv-cardigann', isBr: true,
  });
  const [merged] = dedupeByHash([global, br]);
  assert.equal(merged._br, false);
  assert.equal(merged._dubbed, false);
  assert.doesNotMatch(merged.name, /BR|DUB/);
  // Sem merge, o rótulo global também não muda.
  const soGlobal = stremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 9, indexer: 'therarbg',
  });
  assert.equal(dedupeByHash([soGlobal])[0].name, soGlobal.name);
});

// Paridade do hot path (Etapa 4): o marcador de episódio exato passou a ser
// pré-computado antes do .sort. O resultado observável não pode mudar — nem a
// ordem, nem o corte — mesmo com lote grande e entrada embaralhada.
test('sortAndLimit em lote de 200+: episódio exato à frente do pack, determinístico', () => {
  // Embaralhamento pseudoaleatório DETERMINÍSTICO (LCG): a paridade não pode
  // depender da ordem de entrada, e o teste não pode depender de sorte.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const makeLote = () => {
    const streams: TestStream[] = [];
    for (let i = 0; i < 220; i += 1) {
      const exact = i % 2 === 0;
      streams.push(stremioStream({
        title: exact
          ? `Serie S01E05 1080p rel-${i}`
          : `Serie 1a Temporada 1080p rel-${i}`,
        infoHash: (i + 1).toString(16).padStart(40, '0'),
        seeders: 1 + ((i * 37) % 500),
      }));
    }
    for (let i = streams.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [streams[i], streams[j]] = [streams[j], streams[i]];
    }
    return streams;
  };

  const opts = { season: 1 as never, episode: 5 as never, maxResults: 220 };
  const out = sortAndLimit(makeLote(), opts);

  assert.equal(out.length, 220, 'nada é cortado além do maxResults pedido');

  // Todo episódio exato vem antes de qualquer pack: o marcador pré-computado
  // tem que reproduzir a prioridade que o comparador calculava por chamada.
  const firstPackIdx = out.findIndex((s) => /1a Temporada/.test(s.title));
  for (let i = 0; i < firstPackIdx; i += 1) {
    assert.match(out[i].title, /S01E05/, `posição ${i} deveria ser episódio exato`);
  }
  for (let i = firstPackIdx; i < out.length; i += 1) {
    assert.match(out[i].title, /1a Temporada/, `posição ${i} deveria ser pack`);
  }

  // Determinismo: mesma entrada (novo lote idêntico), mesma saída. Também
  // prova que a primeira execução não deixou estado na segunda.
  const out2 = sortAndLimit(makeLote(), opts);
  assert.deepEqual(out.map((s) => s.infoHash), out2.map((s) => s.infoHash));
});

test('sortAndLimit em lote grande respeita o corte de maxResults', () => {
  const streams: TestStream[] = [];
  const seedersByHash = new Map();
  for (let i = 0; i < 250; i += 1) {
    const infoHash = (i + 1).toString(16).padStart(40, '0');
    const seeders = 1 + ((i * 13) % 900);
    seedersByHash.set(infoHash, seeders);
    streams.push(stremioStream({
      title: `Filme Nome 1080p rel-${i}`,
      infoHash,
      seeders,
    }));
  }
  const out = sortAndLimit(streams, { maxResults: 30 });
  assert.equal(out.length, 30);
  // A saída limpa os campos internos (_seeders sai junto), então a ordem é
  // conferida pelo hash contra o lote original: mesmo balde de qualidade,
  // seeders descrescente.
  for (let i = 1; i < out.length; i += 1) {
    const anterior = seedersByHash.get(out[i - 1].infoHash);
    const atual = seedersByHash.get(out[i].infoHash);
    assert.ok(anterior >= atual, `ordem quebrada na posição ${i}`);
  }
});

