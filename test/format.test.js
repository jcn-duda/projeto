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
  matchesQualityFilter,
  toStremioStream,
  normalizeTitle,
  matchesName,
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
    'adom-1080p-BluRay',
  );
  assert.equal(
    toStremioStream({ title: 'Movie WEB-DL 720p', infoHash: HASH }).behaviorHints.bingeGroup,
    'adom-720p-WEB-DL',
  );
  assert.equal(
    toStremioStream({ title: 'Movie sem fonte', infoHash: HASH }).behaviorHints.bingeGroup,
    'adom-SD-any',
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
  assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
  // Sem hash não há stream.
  assert.equal(toStremioStream({ title: 'sem magnet' }), null);
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
