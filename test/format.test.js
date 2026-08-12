const { test } = require('node:test');
const assert = require('node:assert');

// format.js concentra as funções puras e os invariantes que "quebram
// silenciosamente" (origem BR, campos internos, ordenação). Testar aqui
// dispensa subir servidor ou rede — require('../src/utils/format') é seguro,
// ao contrário de require('../src/addon'), que abre porta.
const {
  bytesToSize,
  extractInfoHash,
  qualityFromTitle,
  audioFromTitle,
  matchesQualityFilter,
  toStremioStream,
  normalizeTitle,
  matchesName,
  matchesEpisode,
  parseTitleSeasonEpisode,
  dedupeByHash,
  sortAndLimit,
  parseStremioId,
  buildSearchQuery,
} = require('../src/utils/format');

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('extractInfoHash aceita hash puro, magnet e base32', () => {
  assert.equal(extractInfoHash(HASH), HASH);
  assert.equal(extractInfoHash(HASH.toUpperCase()), HASH);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${HASH}&dn=x`), HASH);
  assert.equal(extractInfoHash('MFZWIZLTOQ3TMNSHAU3TONRWGU3TANRX'), 'MFZWIZLTOQ3TMNSHAU3TONRWGU3TANRX');
  assert.equal(extractInfoHash(''), null);
  assert.equal(extractInfoHash(null), null);
  assert.equal(extractInfoHash('nao-eh-hash'), null);
});

test('bytesToSize formata unidades e rejeita inválidos', () => {
  assert.equal(bytesToSize(500), '500 B');
  assert.equal(bytesToSize(1073741824), '1.00 GB');
  assert.equal(bytesToSize(0), null);
  assert.equal(bytesToSize('abc'), null);
});

test('qualityFromTitle casa os rótulos comuns', () => {
  assert.equal(qualityFromTitle('Movie 2160p UHD'), '2160p');
  assert.equal(qualityFromTitle('Movie 1080p'), '1080p');
  assert.equal(qualityFromTitle('Movie 720p'), '720p');
  assert.equal(qualityFromTitle('Movie 480p'), '480p');
  assert.equal(qualityFromTitle('Movie sem rótulo'), 'SD');
});

test('sourceFromTitle alimenta o bingeGroup via toStremioStream', () => {
  assert.equal(
    toStremioStream({ title: 'Movie BluRay 1080p', infoHash: HASH }).behaviorHints.bingeGroup,
    'powerm-1080p-BluRay',
  );
  assert.equal(
    toStremioStream({ title: 'Movie WEB-DL 720p', infoHash: HASH }).behaviorHints.bingeGroup,
    'powerm-720p-WEB-DL',
  );
  assert.equal(
    toStremioStream({ title: 'Movie sem fonte', infoHash: HASH }).behaviorHints.bingeGroup,
    'powerm-SD-any',
  );
});

test('matchesQualityFilter: vazio passa tudo; senão casa por rótulo', () => {
  assert.equal(matchesQualityFilter('qualquer coisa', []), true);
  assert.equal(matchesQualityFilter('Movie 1080p x264', ['1080p']), true);
  assert.equal(matchesQualityFilter('Movie 720p x264', ['1080p']), false);
});

test('toStremioStream normaliza e guarda campos internos', () => {
  const s = toStremioStream({
    title: 'Coringa 1080p BluRay',
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    seeders: 42,
    size: 2147483648,
    tracker: '1337x',
  });
  assert.equal(s.infoHash, HASH);
  assert.equal(s._seeders, 42);
  assert.equal(s._quality, '1080p');
  assert.equal(s._br, false);
  assert.ok(s.title.includes('2.00 GB'));
  assert.ok(s.title.includes('1337x'));
  // O nome da release abre o `name`: é o que o Power Movie renderiza
  // literal na linha; a 2ª linha leva qualidade + seeds.
  assert.ok(s.name.startsWith('Coringa 1080p BluRay'));
  assert.ok(s.name.includes('👤 42'));
  assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
  // Sem hash não há stream.
  assert.equal(toStremioStream({ title: 'sem magnet' }), null);
});

test('audioFromTitle detecta dublado/dual/legendado e entra na linha', () => {
  assert.equal(audioFromTitle('Coringa Dublado 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Filme Dual Audio 720p'), 'Dual');
  assert.equal(audioFromTitle('Serie Legendada 1080p'), 'Legendado');
  assert.equal(audioFromTitle('Movie 1080p'), '');
  const s = toStremioStream({ title: 'Coringa Dublado 1080p', infoHash: HASH, seeders: 1 });
  assert.ok(s.name.includes('1080p Dublado'));
  assert.ok(s.title.includes('Dublado'));
});

test('toStremioStream preserva a marca de origem BR do provider', () => {
  const s = toStremioStream({ title: 'Coringa Dublado', infoHash: HASH, isBr: true, seeders: 1 });
  assert.equal(s._br, true);
});

test('normalizeTitle tira acentos e pontuação', () => {
  assert.equal(normalizeTitle('Coringa: Dublado!'), 'coringa dublado');
  assert.equal(normalizeTitle('À Prova de Fogo'), 'a prova de fogo');
});

test('matchesName aceita variações mas rejeita título fora', () => {
  assert.equal(matchesName('Joker 2019 1080p BluRay', 'Joker'), true);
  // Release BR vem só com o título em português.
  assert.equal(matchesName('Coringa Dublado 1080p', 'Coringa'), true);
  assert.equal(matchesName('Vingadores Guerra Infinita', 'Coringa'), false);
  // Nome sem palavras aproveitáveis não descarta nada.
  assert.equal(matchesName('qualquer coisa', '??'), true);
});

test('dedupeByHash fica com mais seeders sem perder a origem BR', () => {
  // Invariante: a mesma release vem do indexer global (com seeders) e do BR
  // (sem seeders). Se a marca _br se perder no desempate, a vaga reservada
  // deixa de proteger a fonte dublada.
  const [out] = dedupeByHash([
    { infoHash: HASH, _seeders: 1, _br: true },
    { infoHash: HASH, _seeders: 300, _br: false },
  ]);
  assert.equal(out._seeders, 300);
  assert.equal(out._br, true);
  assert.equal(dedupeByHash([null]).length, 0);
});

test('dedupeByHash preserva marca dublada da variante com menos seeders', () => {
  const [out] = dedupeByHash([
    { infoHash: HASH, _seeders: 1, _dubbed: true, title: 'Filme Dublado' },
    { infoHash: HASH, _seeders: 300, _dubbed: false, title: 'Movie' },
  ]);
  assert.equal(out._seeders, 300);
  assert.equal(out._dubbed, true);
});

test('sortAndLimit ordena por qualidade e seeders, filtra e limpa internos', () => {
  const streams = [
    { infoHash: HASH, _seeders: 1, _quality: '1080p', _br: true, title: 'BR 1080p', name: 'n' },
    { infoHash: OTHER, _seeders: 500, _quality: '720p', _br: false, title: 'x 720p', name: 'n' },
    { infoHash: 'c'.repeat(40), _seeders: 900, _quality: '2160p', _br: false, title: 'x 2160p', name: 'n' },
  ];
  const out = sortAndLimit(streams, { minSeeders: 1, maxResults: 10, qualityFilter: [] });
  assert.deepEqual(out.map((s) => s._quality ?? s.title), ['x 2160p', 'BR 1080p', 'x 720p']);
  // 1080p acima de 720p mesmo com menos seeders.
  assert.equal(out[1].title, 'BR 1080p');
  // Campos internos nunca vazam pro objeto final.
  assert.ok(out.every((s) => !('_seeders' in s) && !('_quality' in s)));
  // Piso de seeders descarta; filtro de qualidade restringe.
  assert.equal(sortAndLimit(streams, { minSeeders: 100 }).length, 2);
  assert.equal(sortAndLimit(streams, { qualityFilter: ['2160p'] })[0].title, 'x 2160p');
  assert.equal(sortAndLimit(streams, { maxResults: 1 }).length, 1);
});

test('parseStremioId separa filme de episódio', () => {
  assert.deepEqual(parseStremioId('tt1254207'), { imdbId: 'tt1254207', season: null, episode: null });
  assert.deepEqual(parseStremioId('tt0903747:1:2'), { imdbId: 'tt0903747', season: 1, episode: 2 });
});

test('buildSearchQuery monta filme com ano e série SxxEyy', () => {
  assert.equal(buildSearchQuery({ name: 'Joker', year: 2019 }), 'Joker 2019');
  assert.equal(
    buildSearchQuery({ name: 'Breaking Bad' }, { season: 1, episode: 1 }),
    'Breaking Bad S01E01',
  );
});

test('parseTitleSeasonEpisode cobre SxxExx, 1x04, packs e pt-BR', () => {
  assert.deepEqual(parseTitleSeasonEpisode('House Of The Dragon S01E04 2160p'), {
    seasons: [1], episodes: [4],
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie 1x04 720p'), { seasons: [1], episodes: [4] });
  assert.deepEqual(parseTitleSeasonEpisode('Serie S02E01-E03'), {
    seasons: [2], episodes: [1, 2, 3],
  });
  assert.deepEqual(parseTitleSeasonEpisode('A Casa Do Dragao 1a Temporada WEB-DL Dual'), {
    seasons: [1], episodes: [],
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie S01 Completa'), { seasons: [1], episodes: [] });
  // Filme com "Episódio II" no nome não pode virar episódio de série.
  assert.deepEqual(parseTitleSeasonEpisode('Star Wars Episodio II Ataque dos Clones'), {
    seasons: [], episodes: [],
  });
});

test('matchesEpisode barra outro episódio mas aceita pack da temporada', () => {
  const want = { season: 1, episode: 1 };
  assert.equal(matchesEpisode('House Of The Dragon S01E01 1080p', want), true);
  assert.equal(matchesEpisode('House Of The Dragon S01E04 2160p', want), false);
  assert.equal(matchesEpisode('House Of The Dragon S02E01 2160p', want), false);
  assert.equal(matchesEpisode('A Casa Do Dragao 1a Temporada Dual', want), true);
  assert.equal(matchesEpisode('A Casa Do Dragao Dublado 1080p', want), true);
  // Filme: sem season/episode não filtra nada.
  assert.equal(matchesEpisode('Coringa 1080p', {}), true);
});

test('sortAndLimit põe o episódio exato antes do pack da temporada', () => {
  const pack = toStremioStream({ title: 'Serie 1a Temporada 2160p', infoHash: HASH, seeders: 5 });
  const ep = toStremioStream({ title: 'Serie S01E01 1080p', infoHash: OTHER, seeders: 1 });
  const out = sortAndLimit([pack, ep], { season: 1, episode: 1 });
  assert.match(out[0].title, /S01E01/);
});

test('sortAndLimit pode priorizar áudio dublado dentro da mesma qualidade', () => {
  const legendado = toStremioStream({
    title: 'Filme Legendado 1080p', infoHash: HASH, seeders: 500,
  });
  const dublado = toStremioStream({
    title: 'Filme Dublado 1080p', infoHash: OTHER, seeders: 5,
  });

  assert.match(sortAndLimit([legendado, dublado])[0].title, /Legendado/);
  assert.match(sortAndLimit([legendado, dublado], { preferDubbed: true })[0].title, /Dublado/);
});

test('sortAndLimit oculta CAM somente quando solicitado', () => {
  const cam = toStremioStream({ title: 'Filme CAM 1080p', infoHash: HASH, seeders: 50 });
  const web = toStremioStream({ title: 'Filme WEB-DL 1080p', infoHash: OTHER, seeders: 5 });

  assert.equal(sortAndLimit([cam, web]).length, 2);
  assert.deepEqual(sortAndLimit([cam, web], { excludeCam: true }).map((s) => s.infoHash), [OTHER]);
});

test('sortAndLimit limita tamanho sem descartar tamanho desconhecido', () => {
  const large = toStremioStream({
    title: 'Filme 1080p', infoHash: HASH, seeders: 50, size: 21 * 1024 ** 3,
  });
  const small = toStremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 5, size: 9 * 1024 ** 3,
  });
  const unknown = toStremioStream({
    title: 'Filme 720p', infoHash: 'c'.repeat(40), seeders: 1,
  });

  const out = sortAndLimit([large, small, unknown], { maxSizeGb: 10 });
  assert.deepEqual(out.map((s) => s.infoHash), [OTHER, 'c'.repeat(40)]);
  assert.ok(out.every((s) => !('_size' in s)));
});
