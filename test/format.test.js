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
  editionFromTitle,
  markDebridName,
  matchesQualityFilter,
  toStremioStream,
  normalizeTitle,
  matchesName,
  resolveSearchNames,
  matchesEpisode,
  matchesBrTitle,
  filterRelevantRaw: relevantRaw,
  parseTitleSeasonEpisode,
  UNKNOWN_QUALITY,
  QUALITY_KEYS,
  dedupeByHash,
  sortAndLimit,
  selectQualityCandidates,
  limitByQuality,
  limitByIndexer,
  limitReservingBr,
  parseStremioId,
  buildSearchQuery,
} = require('../src/utils/format');

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('extractInfoHash aceita hash puro, magnet e base32', () => {
  assert.equal(extractInfoHash(HASH), HASH);
  assert.equal(extractInfoHash(HASH.toUpperCase()), HASH);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${HASH}&dn=x`), HASH);
  assert.equal(extractInfoHash(''), null);
  assert.equal(extractInfoHash(null), null);
  assert.equal(extractInfoHash('nao-eh-hash'), null);
});

// O cliente Stremio só monta magnet com btih de 40 hex: base32 repassado cru
// aparece na lista e não dá play. Caso real visto em release do TorrentDosFilmes.
test('extractInfoHash converte btih base32 para 40 hex', () => {
  const b32 = 'DKYNMQG3OTSHF7TUIUUGDNAKDNPQYFCQ';
  const hex = '1ab0d640db74e472fe74452861b40a1b5f0c1450';
  assert.equal(extractInfoHash(b32), hex);
  assert.equal(extractInfoHash(b32.toLowerCase()), hex);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${b32.toLowerCase()}&dn=x`), hex);
  // 0/1/8/9 não existem no alfabeto base32: não é hash, não vira stream.
  assert.equal(extractInfoHash('DKYNMQG3OTSHF7TUIUUGDNAKDNPQYF01'), null);
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
  // Sem rótulo é 'não sei', não SD — ver o teste do balde próprio abaixo.
  assert.equal(qualityFromTitle('Movie sem rótulo'), UNKNOWN_QUALITY);
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
    'powerm-na-any',
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
  // A coluna estreita leva só o resumo; a release inteira mora no `title`.
  assert.equal(s.name, '1080p BluRay · 👤 42');
  assert.ok(Array.isArray(s.sources) && s.sources.length > 0);
  // Sem hash não há stream.
  assert.equal(toStremioStream({ title: 'sem magnet' }), null);
});

test('audioFromTitle detecta dublado/dual/legendado e entra na linha', () => {
  assert.equal(audioFromTitle('Coringa Dublado 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Coringa DUB PT-BR 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Filme (2024) [DUB] 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Filme.2024.1080p.WEB-DL.DUBBED.mkv'), 'Dublado');
  assert.equal(audioFromTitle('Filme Dual Audio 720p'), 'Dual');
  assert.equal(audioFromTitle('Filme 1080p Audio Duplo'), 'Dual');
  assert.equal(audioFromTitle('Filme 1080p Multiaudio'), 'Dual');
  assert.equal(audioFromTitle('Auto da Compadecida 1080p Nacional'), 'Nacional');
  assert.equal(audioFromTitle('Serie Legendada 1080p'), 'Legendado');
  assert.equal(audioFromTitle('Filme 1080p LEG PT-BR'), 'Legendado');
  assert.equal(audioFromTitle('Filme 1080p [LEG]'), 'Legendado');
  assert.equal(audioFromTitle('Movie 1080p'), '');
  const s = toStremioStream({ title: 'Coringa Dublado 1080p', infoHash: HASH, seeders: 1 });
  assert.ok(s.name.includes('1080p DUB'));
  assert.ok(s.title.includes('Dublado'));
  const sNac = toStremioStream({ title: 'Filme Nacional 1080p', infoHash: HASH, isBr: true, seeders: 5 });
  assert.equal(sNac._dubbed, true);
  assert.ok(sNac.name.includes('1080p NAC BR'));
});

test('toStremioStream preserva a marca de origem BR do provider', () => {
  const s = toStremioStream({ title: 'Coringa Dublado', infoHash: HASH, isBr: true, seeders: 1 });
  assert.equal(s._br, true);
  assert.equal(s.name, 'DUB BR · 👤 1');
});

test('name traz release e seeds; a coluna larga não duplica marcadores', () => {
  const release = 'Sinners.2025.2160p.iT.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-HONE';
  const s = toStremioStream({
    title: release,
    infoHash: HASH,
    seeders: 181,
    size: 23.99 * 1024 ** 3,
    tracker: 'The Pirate Bay',
  });

  // A release NÃO se repete na coluna estreita: com ela ali, este item sozinho
  // ocupava 11 linhas de altura no Stremio.
  assert.equal(s.name, '4K WEB-DL · 👤 181');
  assert.equal(s.name.includes(release), false);
  assert.equal(s.title.split('\n')[0], release);
  assert.match(s.title, /👤 181/);
  assert.match(s.title, /💾 23\.99 GB/);
  assert.match(s.title, /⚙️ The Pirate Bay/);
  for (const marker of ['👤', '💾', '⚙️']) {
    assert.equal(s.title.split(marker).length - 1, 1, `${marker} aparece uma vez`);
  }
});

test('layout compacto diferencia áudio e origem sem inferir dublado', () => {
  const brUnknown = toStremioStream({ title: 'Pecadores 2025', infoHash: HASH, isBr: true });
  const dual = toStremioStream({ title: 'Pecadores 1080p Dual Audio', infoHash: OTHER, isBr: true });
  const legendado = toStremioStream({ title: 'Sinners 720p Legendado', infoHash: 'c'.repeat(40) });

  // Sem seeders publicados (padrão das fontes BR) a linha não inventa "👤 0".
  assert.equal(brUnknown.name, 'BR');
  assert.equal(dual.name, '1080p DUAL BR');
  assert.equal(legendado.name, '720p LEG');
});

test('a coluna estreita cabe numa linha; STREAM_NAME_STYLE=full devolve a antiga', () => {
  const config = require('../src/config');
  // Caso real medido na tela: com a release no `name`, este item ocupava 11
  // linhas de altura no Stremio e cabiam três streams na lista inteira.
  const release = 'Mestres do Universo (2026) 5.1 WEB-DL | [2160p WEB-DL DUBLADO 20.17 GB]';
  const item = { title: release, infoHash: HASH, seeders: 1, size: 20.17 * 1024 ** 3, tracker: 'TorrentDosFilmes', isBr: true };

  const compacto = toStremioStream(item);
  assert.equal(compacto.name, '4K WEB-DL DUB BR · 👤 1');
  assert.equal(compacto.name.includes('\n'), false, 'nada de quebra na coluna estreita');
  // Com o prefixo do debrid ainda cabe numa linha curta.
  assert.ok(markDebridName(compacto.name, 'TB', true).length <= 32);
  // Nada se perde: a release e os metadados continuam na coluna larga.
  assert.equal(compacto.title.split('\n')[0], release);
  assert.match(compacto.title, /💾 20\.17 GB/);

  const original = config.streamNameStyle;
  try {
    config.streamNameStyle = 'full';
    assert.equal(toStremioStream(item).name, `${release}\n4K WEB-DL DUB BR · 👤 1`);
  } finally {
    config.streamNameStyle = original;
  }
});

test('quatro releases 4K do mesmo filme não podem sair com a linha idêntica', () => {
  // Caso real (I Am Legend): a lista trazia quatro 4K em que só o número de
  // seeders mudava. Duas delas são CORTES DIFERENTES do filme — escolher pelo
  // maior seed levava ao final alternativo sem o usuário saber.
  const releases = [
    ['I Am Legend 2007 Theatrical UHD BluRay 1080p DD 5 1 DV HDR x265-SQS', 35],
    ['I Am Legend 2007 Alternate Ending 2160p 4K UHD BluRay h2', 27],
    ['I.Am.Legend.2007.2160p.MA.WEB-DL.DDP5.1.H.265-PandaQT SDR 4k UHD', 18],
    ['I Am Legend 2007 UHD BluRay 2160p HDR10 DV HEVC DTS HD MA 5 1 x26', 12],
  ];
  const nomes = releases.map(([title, seeders], i) =>
    toStremioStream({ title, infoHash: String(i).repeat(40).slice(0, 40), seeders }).name,
  );

  assert.deepEqual(nomes, [
    '4K Cinema BluRay · 👤 35',
    '4K Alt.End BluRay · 👤 27',
    '4K WEB-DL · 👤 18',
    '4K BluRay · 👤 12',
  ]);
  // Sem os seeders, os rótulos ainda precisam se distinguir: o seed é desempate,
  // não identidade.
  const semSeed = nomes.map((n) => n.split(' · ')[0]);
  assert.equal(new Set(semSeed).size, semSeed.length, `rótulos repetidos: ${semSeed.join(' | ')}`);
  // E continua curto — o motivo de ter encurtado não pode ser desfeito aqui.
  assert.ok(Math.max(...nomes.map((n) => n.length)) <= 32);
});

test('editionFromTitle reconhece os cortes que mudam o filme, em pt e en', () => {
  assert.equal(editionFromTitle('Filme 2007 Alternate Ending 2160p'), 'Alt.End');
  assert.equal(editionFromTitle("Filme 2007 Director's Cut 1080p"), 'DC');
  assert.equal(editionFromTitle('Filme 2007 Extended Edition 1080p'), 'Extended');
  assert.equal(editionFromTitle('Eu Sou a Lenda 2008 Versão de Cinema 1080p'), 'Cinema');
  assert.equal(editionFromTitle('Filme 1999 Remastered 4K'), 'Remaster');
  assert.equal(editionFromTitle('Filme 2019 IMAX 2160p'), 'IMAX');
  assert.equal(editionFromTitle('Filme 2019 Unrated 1080p'), 'Uncut');
  // "Alternate Version" não diz qual é a diferença, mas diz que não é o padrão.
  assert.equal(editionFromTitle('I Am Legend - Alternate Version (2007)'), 'Alt.Ver');
  assert.equal(editionFromTitle('Filme 2007 Versão Alternativa 1080p'), 'Alt.Ver');
  // Sem corte anunciado não inventa rótulo — a maioria das releases cai aqui e
  // é o que mantém a linha curta no caso comum.
  assert.equal(editionFromTitle('I Am Legend 2007 UHD BluRay 2160p HEVC'), '');
  assert.equal(editionFromTitle(''), '');
});

test('release que não anuncia nada mostra o título em vez de só os seeders', () => {
  // Sem resolução, corte, fonte nem áudio sobraria "👤 3", que não identifica
  // nada — e nesse caso o nome da release é a única informação que existe.
  const nada = toStremioStream({ title: 'I Am Legend 2007 [MissouriMike]', infoHash: HASH, seeders: 3 });
  assert.equal(nada.name, 'I Am Legend 2007 [MissouriMike]\n👤 3');

  const s = toStremioStream({ title: 'Filme Obscuro', infoHash: OTHER, seeders: 0 });
  assert.equal(s.name, 'Filme Obscuro');

  // Basta UM atributo para o resumo valer e o título sair da coluna estreita.
  const comFonte = toStremioStream({ title: 'Filme Obscuro BluRay', infoHash: HASH, seeders: 3 });
  assert.equal(comFonte.name, 'BluRay · 👤 3');
});

// Formato do Torrentio, com ⚡ no lugar do "+": a sigla é do DEBRID, não do
// addon. O "[PM+]" fixo de antes prometia play instantâneo até para quem estava
// em P2P puro, e o PM colidia com a sigla do Premiumize.
test('prefixo do debrid distingue cache de download sem deslocar a qualidade', () => {
  const name = 'Coringa 2019 1080p BluRay\n1080p DUB BR · 👤 42';
  assert.equal(markDebridName(name, 'AD', true), `[AD⚡] ${name}`);
  assert.equal(markDebridName(name, 'AD', false), `[AD download] ${name}`);
  assert.equal(markDebridName(name, 'PM', true), `[PM⚡] ${name}`);
  // Sem debrid não há prefixo: não há nada a prometer sobre o play.
  assert.equal(markDebridName(name, '', true), name);
  assert.equal(markDebridName(name, '   ', false), name);
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
    const [out] = dedupeByHash(input, ['nerdfilmes']);
    assert.equal(out._indexer, 'nerdfilmes');
    assert.equal(out.title, 'Filme Dublado 1080p');
    assert.equal(out._br, true);
    assert.equal(out._dubbed, true);
  }
});

test('dedupe prioritário preserva resolução e tamanho conhecidos do mesmo hash', () => {
  const global = toStremioStream({
    title: 'Filme 1080p WEB-DL', infoHash: HASH, seeders: 1,
    size: 4 * 1024 ** 3, tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const br = toStremioStream({
    title: 'Filme Dublado', infoHash: HASH, seeders: 1,
    tracker: 'NerdFilmes', indexer: 'nerdfilmes', isBr: true,
  });
  const [out] = dedupeByHash([global, br], ['nerdfilmes']);

  assert.equal(out._indexer, 'nerdfilmes');
  assert.equal(out._quality, '1080p');
  assert.equal(out._size, 4 * 1024 ** 3);
  assert.equal(out.behaviorHints.bingeGroup, 'powerm-1080p-WEB-DL');
  assert.equal(out._br, true);
  assert.equal(out._dubbed, true);
});

test('sortAndLimit ordena por qualidade e seeders, filtra e limpa internos', () => {
  const streams = [
    { infoHash: HASH, _seeders: 1, _quality: '1080p', _br: true, title: 'BR 1080p', name: 'n' },
    { infoHash: OTHER, _seeders: 500, _quality: '720p', _br: false, title: 'x 720p', name: 'n' },
    { infoHash: 'c'.repeat(40), _seeders: 900, _quality: '2160p', _br: false, title: 'x 2160p', name: 'n' },
  ];
  const out = sortAndLimit(streams, { minSeeders: 1, maxResults: 10, qualityFilter: [] });
  assert.deepEqual(out.map((s) => s.title), ['x 2160p', 'BR 1080p', 'x 720p']);
  // 1080p acima de 720p mesmo com menos seeders.
  assert.equal(out[1].title, 'BR 1080p');
  // O pool preserva qualidade/origem até o corte final pós-debrid.
  assert.ok(out.every((s) => !('_seeders' in s)));
  assert.equal(out[0]._quality, '2160p');
  // Piso de seeders descarta; filtro de qualidade restringe.
  assert.equal(sortAndLimit(streams, { minSeeders: 100 }).length, 2);
  assert.equal(sortAndLimit(streams, { qualityFilter: ['2160p'] })[0].title, 'x 2160p');
  assert.equal(sortAndLimit(streams, { maxResults: 1 }).length, 1);
});

test('prioridade de indexador desempata dentro da qualidade sem vencer resolução', () => {
  const preferred1080 = toStremioStream({
    title: 'Filme 1080p', infoHash: HASH, seeders: 1,
    tracker: 'NerdFilmes', indexer: 'nerdfilmes',
  });
  const popular1080 = toStremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 500,
    tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const global4k = toStremioStream({
    title: 'Filme 2160p', infoHash: 'c'.repeat(40), seeders: 1,
    tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const out = sortAndLimit([popular1080, preferred1080, global4k], {
    indexerPriority: ['nerdfilmes'],
  });

  assert.deepEqual(out.map((stream) => stream.infoHash), [global4k.infoHash, HASH, OTHER]);
});

test('preferência dublada vence prioridade de indexador na mesma qualidade', () => {
  const preferredLegendado = toStremioStream({
    title: 'Filme Legendado 1080p', infoHash: HASH, seeders: 100,
    tracker: 'NerdFilmes', indexer: 'nerdfilmes',
  });
  const dublado = toStremioStream({
    title: 'Filme Dublado 1080p', infoHash: OTHER, seeders: 1,
    tracker: 'The Pirate Bay', indexer: 'thepiratebay',
  });
  const out = sortAndLimit([preferredLegendado, dublado], {
    preferDubbed: true,
    indexerPriority: ['nerdfilmes'],
  });

  assert.equal(out[0].infoHash, OTHER);
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
    seasons: [1], episodes: [4], complete: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie 1x04 720p'), {
    seasons: [1], episodes: [4], complete: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie S02E01-E03'), {
    seasons: [2], episodes: [1, 2, 3], complete: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('A Casa Do Dragao 1a Temporada WEB-DL Dual'), {
    seasons: [1], episodes: [], complete: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie S01 Completa'), {
    seasons: [1], episodes: [], complete: false,
  });
  // Filme com "Episódio II" no nome não pode virar episódio de série.
  assert.deepEqual(parseTitleSeasonEpisode('Star Wars Episodio II Ataque dos Clones'), {
    seasons: [], episodes: [], complete: false,
  });
});

test('parseTitleSeasonEpisode: ano depois de "Temporada" não é temporada', () => {
  // "Temporada (2011)" casava como temporada 20 — os dois primeiros dígitos do
  // ano. É o formato do Comando e do TorrentDosFilmes.
  const r = parseTitleSeasonEpisode('Game of Thrones 6a Temporada (2016) HDTV 720p');
  assert.deepEqual(r.seasons, [6]);
});

test('parseTitleSeasonEpisode entende faixa e cobertura total de temporada', () => {
  // Só o último número era lido, então o pack de 1 a 8 não cobria o S01E01
  // pedido e era descartado.
  const faixa = parseTitleSeasonEpisode('Game of Thrones 1a ate 8a Temporada (2011) [opcao 8]');
  assert.deepEqual(faixa.seasons, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(matchesEpisode('Game of Thrones 1a ate 8a Temporada (2011)', { season: 1, episode: 1 }), true);

  // "Todas as Temporadas" não declara número nenhum: sem este sinal ele só
  // sobrevivia pela brecha de "título sem pista passa".
  const todas = parseTitleSeasonEpisode('Game of Thrones Todas as Temporadas WEB-DL 720p DUBLADO');
  assert.equal(todas.complete, true);
  assert.equal(matchesEpisode('Game of Thrones Todas as Temporadas WEB-DL', { season: 3, episode: 7 }), true);

  // Faixa absurda é erro de leitura: não expande. O padrão de temporada única
  // ainda lê o último número, e tudo bem — uma busca por S01 não casa com 90.
  const absurda = parseTitleSeasonEpisode('Coisa 1 a 90 temporada').seasons;
  assert.equal(absurda.includes(1), false, 'não pode inventar cobertura de 90 temporadas');
  assert.equal(matchesEpisode('Coisa 1 a 90 temporada', { season: 1, episode: 1 }), false);
});

test('matchesBrTitle corta obra derivada que só começa com o nome', () => {
  // Especial animado e documentário: cobrem 2/2 do nome da série e entravam na
  // lista do S01E01. Só a precisão — quanto do título sobra fora da busca —
  // separa isso de um pack legítimo.
  const nomes = ['Game of Thrones'];
  const opts = { isSeries: true, allNames: nomes };
  assert.equal(
    matchesBrTitle('Game of Thrones: A Conquista e a Rebeliao Uma Historia Animada (2017)', 'Game of Thrones', '2011', opts),
    false,
  );
  assert.equal(
    matchesBrTitle('Game of Thrones A Ultima Vigilia Torrent (2019) Legendado WEB DL', 'Game of Thrones', '2011', opts),
    false,
  );
  assert.equal(
    matchesBrTitle('Game of Thrones 1a Temporada Dublado Torrent (2011) HDTV', 'Game of Thrones', '2011', opts),
    true,
  );

  // A release legítima carrega os DOIS nomes; medir contra um só condenaria o
  // outro como conteúdo estranho. Por isso a precisão exige a lista completa.
  const starWars = ['Star Wars', 'Guerra nas Estrelas'];
  assert.equal(
    matchesBrTitle('Colecao Guerra nas Estrelas [Star wars] BluRay 1080p Dublado', 'Guerra nas Estrelas', '1977', {
      allNames: starWars,
    }),
    true,
  );
  // Sem `allNames` a checagem de precisão não roda — quem chama não tem a
  // informação. O veículo aqui não pode ter número de sequência: "Fallout 4"
  // morreria na regra de sequência, que é outra checagem.
  assert.equal(
    matchesBrTitle('Fallout Torrent (2015) Legendado WEB DL', 'Fallout', null),
    true,
  );
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

test('matchesEpisode lê "Exx" solto no formato dos resolvers BR', () => {
  const want = { season: 1, episode: 1 };
  // Formato real dos resolvers: temporada por extenso + episódio solto.
  assert.equal(matchesEpisode('A Casa do Dragão 1ª Temporada (2022) WEB-DL E01 [DUBLADO]', want), true);
  assert.equal(matchesEpisode('A Casa do Dragão 1ª Temporada (2022) WEB-DL E02 [DUBLADO]', want), false);
  assert.equal(matchesEpisode('A Casa do Dragão 1ª Temporada (2022) / WEB-DL | E07 [2160p opção 44]', want), false);
  // Intervalo de episódios soltos cobre o pedido.
  assert.equal(matchesEpisode('Serie 1ª Temporada E01 a E10 720p', { season: 1, episode: 5 }), true);
  // Sem temporada no título, "e" seguido de número é conjunção/ruído, não episódio.
  assert.equal(matchesEpisode('Lilo e Stitch E02 Live Action', want), true);
  // EAC3 não vira episódio 3.
  assert.equal(matchesEpisode('Serie 1ª Temporada E01 DDP5 1 EAC3 1080p', { season: 1, episode: 3 }), false);
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

test('limitByQuality aplica cotas por qualidade após o debrid sem reordenar', () => {
  const streams = [
    { id: '4k-a', _quality: '2160p' },
    { id: '4k-b', _quality: '2160p' },
    { id: '1080-a', _quality: '1080p' },
    { id: '1080-b', _quality: '1080p' },
    { id: '720-a', _quality: '720p' },
    { id: 'sd-a', _quality: 'SD' },
  ];
  const out = limitByQuality(streams, {
    '2160p': 1, '1080p': 2, '720p': 0, '480p': 100, SD: 1,
  });
  assert.deepEqual(out.map((s) => s.id), ['4k-a', '1080-a', '1080-b', 'sd-a']);
});

test('selectQualityCandidates reserva candidatos para cada cota configurada', () => {
  const streams = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `4k-${i}`, _quality: '2160p' })),
    { id: '1080-a', _quality: '1080p' },
    { id: '1080-b', _quality: '1080p' },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 4,
    qualityLimits: { '2160p': 2, '1080p': 2 },
  });
  assert.deepEqual(out.map((s) => s.id), ['4k-0', '4k-1', '1080-a', '1080-b']);
});

test('selectQualityCandidates não envia excedentes de qualidade limitada ao debrid', () => {
  const streams = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `4k-${i}`, _quality: '2160p' })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `1080-${i}`, _quality: '1080p' })),
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 40,
    qualityLimits: { '2160p': 2, '1080p': 3, '720p': 0, '480p': 0, SD: 0 },
    candidateFactor: 4,
  });
  assert.equal(out.length, 20);
  assert.equal(out.filter((s) => s._quality === '2160p').length, 8);
  assert.equal(out.filter((s) => s._quality === '1080p').length, 12);
});

test('selectQualityCandidates mantém pool ampliado nas qualidades ilimitadas', () => {
  const streams = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `4k-${i}`, _quality: '2160p' })),
    ...Array.from({ length: 180 }, (_, i) => ({ id: `1080-${i}`, _quality: '1080p' })),
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 160,
    qualityLimits: { '2160p': 2, '1080p': 100, '720p': 100, '480p': 100, SD: 100 },
    candidateFactor: 4,
  });
  assert.equal(out.length, 160);
  assert.equal(out.filter((s) => s._quality === '2160p').length, 8);
});

test('selectQualityCandidates preserva BR dentro de qualidade limitada', () => {
  const streams = [
    { id: 'global-a', _quality: '1080p', _br: false },
    { id: 'global-b', _quality: '1080p', _br: false },
    { id: 'br-a', _quality: '1080p', _br: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 2,
    qualityLimits: { '1080p': 2 },
    brReservedSlots: 1,
  });
  assert.deepEqual(out.map((s) => s.id), ['global-a', 'br-a']);
});

test('selectQualityCandidates preserva BR em qualidade ilimitada', () => {
  const streams = [
    ...Array.from({ length: 200 }, (_, i) => ({ id: `global-${i}`, _quality: '1080p', _br: false })),
    { id: 'br-a', _quality: '1080p', _br: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 160,
    qualityLimits: { '2160p': 100, '1080p': 100, '720p': 100, '480p': 100, SD: 100 },
    brReservedSlots: 1,
  });
  assert.equal(out.length, 160);
  assert.ok(out.some((s) => s.id === 'br-a'));
});

test('limitReservingBr combina reserva, cotas e máximo sem vazar internos', () => {
  const streams = [
    { id: 'global-4k', _quality: '2160p', _br: false, _seeders: 100 },
    { id: 'br-1080-a', _quality: '1080p', _br: true, _seeders: 1 },
    { id: 'br-1080-b', _quality: '1080p', _br: true, _seeders: 1 },
    { id: 'global-1080', _quality: '1080p', _br: false, _seeders: 50 },
  ];
  const out = limitReservingBr(streams, {
    brReservedSlots: 2,
    maxResults: 3,
    qualityLimits: { '2160p': 1, '1080p': 1 },
  });
  assert.deepEqual(out.map((s) => s.id), ['br-1080-a', 'global-4k']);
  assert.ok(out.every((s) => Object.keys(s).every((key) => !key.startsWith('_'))));
  assert.ok(out.every((s) => !('_indexer' in s)));
});

test('limitByIndexer aplica teto por fonte e trata 0 como sem limite', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'yts-3', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'therarbg' },
    { id: 'sem-fonte', _indexer: '' },
  ];
  assert.deepEqual(
    limitByIndexer(streams, 2).map((s) => s.id),
    ['yts-1', 'yts-2', 'rarbg-1', 'sem-fonte'],
  );
  // Ao contrário das cotas por qualidade, 0 aqui é "desligado", não "nenhum".
  assert.equal(limitByIndexer(streams, 0).length, 5);
  // Indexador desconhecido não vira um balde comum entre streams sem metadado.
  assert.equal(limitByIndexer([...streams, { id: 'outro', _indexer: '' }], 1).length, 4);
  // Maiúsculas/minúsculas são a mesma fonte.
  assert.equal(limitByIndexer([{ _indexer: 'YTS' }, { _indexer: 'yts' }], 1).length, 1);
});

test('cota por indexador não consome as vagas reservadas BR', () => {
  const streams = [
    { id: 'br-1', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-2', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-3', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'yts-2', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'yts-3', _quality: '1080p', _br: false, _indexer: 'yts' },
  ];
  // Cota 1, mas 2 vagas reservadas: o BluDV entrega 2 dublados mesmo assim.
  const out = limitReservingBr(streams, { brReservedSlots: 2, maxResults: 10, maxPerIndexer: 1 });
  assert.deepEqual(out.map((s) => s.id), ['br-1', 'br-2', 'yts-1']);
});

test('cota por indexador limita o BR que passa da reserva', () => {
  const streams = [
    { id: 'br-1', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-2', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-3', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
  ];
  // Sem reserva, o teto vale para todo mundo: o BluDV para no limite de 2.
  const out = limitReservingBr(streams, { brReservedSlots: 0, maxResults: 10, maxPerIndexer: 2 });
  assert.deepEqual(out.map((s) => s.id), ['br-1', 'br-2', 'yts-1']);
});

test('limitReservingBr coloca todas as fontes BR primeiro quando solicitado', () => {
  const streams = [
    { id: 'global-4k', _quality: '2160p', _br: false },
    { id: 'br-1080-a', _quality: '1080p', _br: true },
    { id: 'global-1080', _quality: '1080p', _br: false },
    { id: 'br-720', _quality: '720p', _br: true },
  ];
  const out = limitReservingBr(streams, {
    brReservedSlots: 0,
    brFirst: true,
    maxResults: 4,
  });
  assert.deepEqual(out.map((s) => s.id), ['br-1080-a', 'br-720', 'global-4k', 'global-1080']);
});

test('limitReservingBr mantém ordem natural sem prioridade e ainda garante BR', () => {
  const streams = [
    { id: 'global-4k', _quality: '2160p', _br: false },
    { id: 'global-1080-a', _quality: '1080p', _br: false },
    { id: 'global-1080-b', _quality: '1080p', _br: false },
    { id: 'br-720', _quality: '720p', _br: true },
  ];
  const out = limitReservingBr(streams, {
    brReservedSlots: 1,
    brFirst: false,
    maxResults: 3,
  });
  assert.deepEqual(out.map((s) => s.id), ['global-4k', 'global-1080-a', 'br-720']);
});

test('resolveSearchNames cobre o Cinemeta que não conhece o id', () => {
  const titles = { pt: 'A Origem', original: 'Inception', year: '2010' };

  // Caminho normal: Cinemeta responde e manda no nome da busca.
  const comMeta = resolveSearchNames({
    meta: { name: 'Inception', year: '2010' },
    titles,
    imdbId: 'tt1375666',
  });
  assert.equal(comMeta.name, 'Inception');
  assert.deepEqual(comMeta.names, ['Inception', 'A Origem', 'Inception']);

  // Cinemeta 404 e TMDB responde: a query passava a ser a string crua
  // "tt1375666" e o filtro de título, preso a `meta?.name`, se desligava
  // inteiro — qualquer lixo do indexador ia direto pro usuário.
  const semMeta = resolveSearchNames({ meta: null, titles, imdbId: 'tt1375666' });
  assert.equal(semMeta.name, 'Inception', 'usa o original, que é o que o indexador global publica');
  assert.equal(semMeta.year, '2010', 'o ano precisa sobreviver: matchesBrTitle depende dele');
  assert.deepEqual(semMeta.names, ['A Origem', 'Inception'], 'o filtro continua tendo por que cortar');

  // Só o pt-BR disponível: melhor que o id cru.
  const soPt = resolveSearchNames({ meta: null, titles: { pt: 'Coringa' }, imdbId: 'tt7286456' });
  assert.equal(soPt.name, 'Coringa');

  // Nenhuma das duas APIs respondeu: aí sim o id cru é o que sobrou.
  const semNada = resolveSearchNames({ meta: null, titles: null, imdbId: 'tt7286456' });
  assert.equal(semNada.name, 'tt7286456');
  assert.deepEqual(semNada.names, [], 'sem nome não há filtro possível — e o gate tem que ver isso');
});

test('matchesName não aceita pedaço de palavra nem título curto esvaziado', () => {
  // "Disclosure Day" tem título pt-BR "Dia D". Cortando palavra de até 2 letras
  // ele virava o token único `dia`, comparado por substring: aceitava "O DIABO
  // Veste Prada" e "Um DIA de Sorte". O lixo tomava as vagas BR reservadas e
  // empurrava pra fora o "Dia D (2026) WEB-DL [1080p DUBLADO]" de verdade.
  assert.equal(matchesName('O Diabo Veste Prada 2 (2026) WEB-DL [1080p DUBLADO]', 'Dia D'), false);
  assert.equal(matchesName('Um Dia de Sorte em Nova York Torrent (2026)', 'Dia D'), false);
  assert.equal(matchesName('Homem-Aranha: Um Novo Dia (2026) [opção 3]', 'Dia D'), false);
  assert.equal(matchesName('Dia D (2026) WEB-DL [1080p DUBLADO]', 'Dia D'), true);

  // Mesma raiz, com "A Origem" (Inception) puxando uma série inteira.
  assert.equal(matchesName('Origem 4ª Temporada (2026) WEB-DL [DUBLADO]', 'A Origem'), false);
  assert.equal(matchesName('Pearl: Uma História de Origem "X" Torrent (2022)', 'A Origem'), false);
  assert.equal(matchesName('A Origem (2010) BluRay 1080p Dublado', 'A Origem'), true);

  // O aperto não pode custar recall: pack de coleção e variação de numeral
  // continuam passando, e é deles que vêm boa parte das fontes dubladas.
  assert.equal(
    matchesName('Trilogia: O Senhor dos Anéis Versão Estendida', 'O Senhor dos Anéis: A Sociedade do Anel'),
    true,
  );
  assert.equal(matchesName('Coleção Guerra nas Estrelas [Star wars] BluRay 1080p', 'Guerra nas Estrelas'), true);
  assert.equal(matchesName('Duna: Parte 2 (2024) Dual Áudio', 'Duna: Parte Dois'), true);
  // Pontuação exótica no título não pode virar token perdido.
  assert.equal(matchesName('WALL-E (2008) BluRay Dublado', 'WALL·E'), true);
});

test('cota de qualidade não come a fonte BR antes da reserva agir', () => {
  // Config real de usuário: max1080p=3. As fontes BR publicam seeders=1, então
  // chegam no fim do balde de 1080p — a cota levava as três globais mais
  // semeadas e cortava a BR ANTES de brFirst/brReservedSlots existirem.
  const streams = [
    { id: 'global-a', _quality: '1080p', _br: false, _seeders: 209 },
    { id: 'global-b', _quality: '1080p', _br: false, _seeders: 159 },
    { id: 'global-c', _quality: '1080p', _br: false, _seeders: 125 },
    { id: 'global-d', _quality: '1080p', _br: false, _seeders: 30 },
    { id: 'br-1080', _quality: '1080p', _br: true, _seeders: 1 },
  ];
  const limits = { '2160p': 3, '1080p': 3, '720p': 3, '480p': 3 };

  const first = limitReservingBr([...streams], {
    brFirst: true,
    brReservedSlots: 6,
    maxResults: 40,
    qualityLimits: limits,
  });
  assert.deepEqual(first.map((s) => s.id), ['br-1080', 'global-a', 'global-b']);

  // Sem prioridade visual a BR mantém a posição natural, mas ainda ocupa uma
  // das três vagas da cota em vez de sumir.
  const natural = limitReservingBr([...streams], {
    brFirst: false,
    brReservedSlots: 6,
    maxResults: 40,
    qualityLimits: limits,
  });
  assert.deepEqual(natural.map((s) => s.id), ['global-a', 'global-b', 'br-1080']);

  // Sem reserva pedida e sem prioridade, a cota volta a ser puro seeders.
  const semReserva = limitReservingBr([...streams], {
    brFirst: false,
    brReservedSlots: 0,
    maxResults: 40,
    qualityLimits: limits,
  });
  assert.deepEqual(semReserva.map((s) => s.id), ['global-a', 'global-b', 'global-c']);
});

test('selectQualityCandidates preserva todos os BR candidatos quando brFirst está ativo', () => {
  const streams = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `global-${i}`, _quality: '1080p', _br: false })),
    { id: 'br-a', _quality: '1080p', _br: true },
    { id: 'br-b', _quality: '720p', _br: true },
  ];
  const out = selectQualityCandidates(streams, {
    maxResults: 5,
    brReservedSlots: 0,
    brFirst: true,
  });
  assert.ok(out.some((s) => s.id === 'br-a'));
  assert.ok(out.some((s) => s.id === 'br-b'));
});

test('sentinela de 1 KB dos indexers BR conta como tamanho desconhecido', () => {
  const unknown = toStremioStream({ title: 'Serie 1a Temporada', infoHash: HASH, size: 1024 });
  assert.ok(!unknown.title.includes('💾'), 'não exibe tamanho inventado');
  assert.equal(unknown._size, 0);
  // Acima do sentinela é tamanho de verdade e volta a aparecer.
  const real = toStremioStream({ title: 'Serie 1a Temporada', infoHash: HASH, size: 2 * 1024 ** 3 });
  assert.ok(real.title.includes('💾 2.00 GB'));
  assert.equal(real._size, 2 * 1024 ** 3);
});

test('sem resolução no título não é SD e tem balde próprio', () => {
  // Fonte BR típica: nenhuma resolução no título.
  assert.equal(qualityFromTitle('Devoradores de Estrelas (2026) [opção 3]'), UNKNOWN_QUALITY);
  assert.equal(qualityFromTitle('A Casa do Dragão 1ª Temporada (2022) WEB-DL [DUBLADO]'), UNKNOWN_QUALITY);
  // SD exige marca explícita de baixa qualidade.
  assert.equal(qualityFromTitle('Filme 2019 DVDRip XviD'), 'SD');
  assert.equal(qualityFromTitle('Filme 2019 SDTV'), 'SD');
  assert.equal(qualityFromTitle('Filme 2026 576p WEBRip x265'), 'SD');
  assert.equal(qualityFromTitle('Filme 2019 CAM'), 'SD');
  // Resolução declarada continua ganhando.
  assert.equal(qualityFromTitle('Filme 2019 1080p WEB-DL'), '1080p');
  assert.ok(QUALITY_KEYS.includes(UNKNOWN_QUALITY));
});

test('zerar a cota de SD não esconde mais as fontes BR', () => {
  const br = toStremioStream({ title: 'Devoradores de Estrelas (2026) [opção 3]', infoHash: HASH, seeders: 1, isBr: true });
  const sd = toStremioStream({ title: 'Devoradores de Estrelas 2026 DVDRip', infoHash: OTHER, seeders: 9 });
  const out = sortAndLimit([br, sd], { qualityLimits: { SD: 0 }, maxResults: 10 });
  assert.equal(out.length, 1, 'só o DVDRip cai na cota zerada de SD');
  assert.match(out[0].title, /opção 3/);
  // E a cota nova corta o balde certo quando o usuário quiser.
  assert.equal(sortAndLimit([br, sd], { qualityLimits: { [UNKNOWN_QUALITY]: 0 }, maxResults: 10 }).length, 1);
});

test('resolução desconhecida não vira rótulo nem grupo de binge do SD', () => {
  const s = toStremioStream({ title: 'Devoradores de Estrelas (2026) [opção 3] DUBLADO', infoHash: HASH, seeders: 1 });
  const details = s.name;
  assert.ok(!/sem resolução|SD/.test(details), `linha não anuncia resolução: ${details}`);
  assert.ok(details.startsWith('DUB'), details);
  assert.ok(!s.behaviorHints.bingeGroup.includes('SD'));
});

test('filtro de resolução preserva fonte sem resolução pelo balde próprio', () => {
  const br = toStremioStream({
    title: 'Prometheus (2012) [opção 3] DUBLADO',
    infoHash: 'd'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const global4k = toStremioStream({
    title: 'Prometheus 2012 2160p WEB-DL',
    infoHash: 'e'.repeat(40),
    seeders: 100,
  });
  const limits = { [UNKNOWN_QUALITY]: 100 };
  const out = sortAndLimit([br, global4k], {
    maxResults: 10,
    qualityFilter: ['2160p', '1080p', '720p'],
    qualityLimits: limits,
  });

  assert.deepEqual(new Set(out.map((item) => item.infoHash)), new Set([br.infoHash, global4k.infoHash]));
});

test('cota zero de sem resolução continua ocultando esse balde', () => {
  const br = toStremioStream({
    title: 'Prometheus (2012) [opção 3] DUBLADO',
    infoHash: 'f'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const out = sortAndLimit([br], {
    maxResults: 10,
    qualityFilter: ['2160p', '1080p', '720p'],
    qualityLimits: { [UNKNOWN_QUALITY]: 0 },
  });

  assert.deepEqual(out, []);
});

test('filtro de qualidade usa a resolução declarada, não substring do título', () => {
  const br4k = toStremioStream({
    title: 'Prometheus (2012) 4K UHD DUBLADO',
    infoHash: '1'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const out = sortAndLimit([br4k], {
    maxResults: 10,
    qualityFilter: ['2160p'],
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].infoHash, br4k.infoHash);
});

test('tamanho fabricado pelo indexer vira desconhecido, não valor exibido', () => {
  // 1,62 TB é o carimbo da definição Cardigann do redetorrent em 53 das 93
  // releases de uma busca real. Exibi-lo mente para o usuário e, com filtro de
  // tamanho ligado, apagaria a fonte dublada inteira.
  const absurdo = toStremioStream({
    title: 'House of the Dragon S01E02 DUAL 1080p', infoHash: HASH, seeders: 1, size: 1784881034035,
  });
  assert.equal(absurdo._size, 0);
  assert.doesNotMatch(absurdo.title, /TB/);
  // Tamanho plausível continua intacto.
  const real = toStremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 5, size: 8 * 1024 ** 3,
  });
  assert.equal(real._size, 8 * 1024 ** 3);
  assert.match(real.title, /8(\.\d+)? GB/);
  // Filtro de tamanho não pode descartar quem tem tamanho desconhecido.
  const out = sortAndLimit([absurdo], { maxSizeGb: 20 });
  assert.equal(out.length, 1);
});

test('merge de hash igual leva a marca BR para o rótulo, não só para o campo', () => {
  // A MESMA release vinda de um indexer global e de um BR: o merge já
  // propagava _br (a vaga reservada depende dele), mas o name continuava o do
  // vencedor. Na tela a fonte dublada brasileira aparecia SEM "BR" — o usuário
  // via a lista encabeçada por algo que não reconhecia como nacional.
  const global = toStremioStream({
    title: 'Fallout 1a Temporada Dublada e Dual 2160p', infoHash: HASH,
    seeders: 1, size: 11 * 1024 ** 3, tracker: 'HDRTorrent', indexer: 'hdrtorrent', isBr: false,
  });
  const br = toStremioStream({
    title: 'Fallout 1a Temporada (2024) WEB-DL [DUBLADO]', infoHash: HASH,
    seeders: 1, tracker: 'Bludv', indexer: 'bludv-cardigann', isBr: true,
  });
  const [merged] = dedupeByHash([global, br]);
  assert.equal(merged._br, true);
  assert.equal(merged._dubbed, true);
  assert.match(merged.name, /BR/);
  assert.match(merged.name, /DUAL|DUB/);
  // Sem merge de origem, o rótulo não muda.
  const soGlobal = toStremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 9, indexer: 'therarbg',
  });
  assert.equal(dedupeByHash([soGlobal])[0].name, soGlobal.name);
});

// Plano futuro: filtro relevante CRU compartilhado.
//
// Hoje o fallback de pack (doSearch) dispara com `raw.items.length === 0` —
// balde vazio. O plano troca isso por "zero itens RELEVANTES": um post
// parecido que o filtro de título descartaria de qualquer forma não pode
// segurar a busca por episódio e deixar o usuário sem o pack da temporada.
// O contrato é UM filtro cru compartilhado — a MESMA classificação que o
// buildStreams aplica na lista inteira serve para decidir se o pack deve
// rodar. `relevantRaw` é o helper real exportado por format.js; estes casos
// impedem que o gatilho e o corte final voltem a divergir.
test('filtro relevante cru: lixo não segura o fallback de pack', () => {
  const ctx = { names: ['Fallout'], year: 2024, isSeries: true, season: 1, episode: 1 };
  // Post "parecido" que o filtro estrito já derruba: zero relevante, pack dispara.
  assert.deepEqual(
    relevantRaw([{ title: 'Missão: Impossível – Efeito Fallout S01E01 1080p', isBr: true }], ctx),
    [],
  );
  // Spin-off do Rick and Morty: mesmo prefixo, mesmo ano, temporada certa.
  // O filtro compartilhado precisa rejeitá-la para liberar o fallback do pack.
  assert.deepEqual(
    relevantRaw(
      [{ title: 'Rick e Morty: O Anime 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', isBr: true }],
      { names: ['Rick and Morty', 'Rick e Morty'], year: 2024, isSeries: true, season: 1, episode: 1 },
    ),
    [],
  );
});

test('filtro relevante cru: release certa impede o fallback de pack', () => {
  const ctx = {
    names: ['House of the Dragon', 'A Casa do Dragão'],
    year: 2022,
    isSeries: true,
    season: 1,
    episode: 2,
  };
  const relevantes = [
    { title: 'House of the Dragon S01E02.The Rogue Prince  HMAX  DDP5.1.x264 NTb 1080p', isBr: true },
    { title: '1A TEMPORADA COMPLETA      House of the Dragon S01. HMAX  DDP5.1.Atmos x264 SMURF 1080p', isBr: true },
  ];
  assert.equal(relevantRaw(relevantes, ctx).length, 2);
});

test('filtro relevante cru rejeita spin-off global por episódio', () => {
  const ctx = {
    names: ['Rick and Morty', 'Rick e Morty'],
    year: 2013,
    isSeries: true,
    season: 1,
    episode: 2,
  };
  const items = [
    { title: 'Rick And Morty The Anime S01E02 720p HEVC' },
    { title: 'Rick and Morty S01E02.The Vat of Acid Episode 1080p WEB-DL' },
  ];
  assert.deepEqual(relevantRaw(items, ctx), [items[1]]);
});

test('identidade global preserva série curta e sufixo regional', () => {
  const cases = [
    ['S01E02.From.1080p.WEBRip.x264-EVOLVE', ['From']],
    ['S01E02.The.Bear.1080p.WEBRip.x264-EVOLVE', ['The Bear']],
    ['S01E02.Shogun.1080p.WEBRip.x264-GROUP', ['Shogun']],
    ['The Office US S01E02 1080p WEB-DL', ['The Office']],
  ];
  for (const [title, names] of cases) {
    assert.equal(relevantRaw([{ title }], {
      names, isSeries: true, season: 1, episode: 2,
    }).length, 1, title);
  }
});


// Caminho GLOBAL de filme: `matchesName` aprova QUALQUER sequência da franquia
// ("Scary Movie 2" cobre 2/2 tokens de "Scary Movie") e até outra obra que só
// cita as duas palavras da busca ("Titanic 2000 (Scary Sexy Disaster Movie)").
// O filtro BR estrito tem regra de sequência + prefixo + ano (`matchesBrTitle`);
// o global não tinha nenhuma — a sequência entrava na lista do filme certo e o
// usuário via o 2/3/4 antes do original.
test('filtro relevante cru: filme global descarta sequência e obra parecida', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const items = [
    { title: 'Scary Movie 2 (2001) 1080p BluRay' },
    { title: 'Scary Movie 3 (2003) 720p WEB-DL' },
    { title: 'Scary Movie 4 (2006) 1080p x264' },
    { title: 'Scary Movie II 720p HDRip' },
    { title: 'Scary Movie Part Two 1080p BluRay' },
    // Paródia de 1999 que só cita as palavras: começa em "Titanic", não no nome
    // procurado, e o ano denuncia outra obra — o global não conferia nenhum dos
    // dois e a deixava competir com o original de 2000.
    { title: 'Titanic 2000 (Scary Sexy Disaster Movie) 1999 DVDRip' },
  ];
  for (const item of items) {
    assert.deepEqual(relevantRaw([item], ctx), [], item.title);
  }
});

// A contraparte do descarte: o ORIGINAL com tags de indexer (YTS.MX, x264), o
// alias pt-BR e o pack de coleção sem número explícito continuam passando. Tag
// de release e palavra de empacotamento não podem virar "sequência" na regra
// nova.
test('filtro relevante cru: filme global mantém original, alias e coleção', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const items = [
    { title: 'Scary Movie (2000) 1080p YTS.MX' },
    { title: 'Scary Movie 2000 x264-RARBG' },
    { title: 'Todo Mundo em Pânico (2000) Dublado 720p' },
    { title: 'Todo Mundo em Pânico Coleção Completa BluRay 1080p Dublado' },
  ];
  for (const item of items) {
    assert.equal(relevantRaw([item], ctx).length, 1, item.title);
  }
});

test('filtro relevante cru: artigo inicial do release não desliga o filme global', () => {
  // A regra de prefixo nova compara o primeiro token RELEVANTE; crua, ela
  // reprova release que abre com artigo quando o alias não o carrega — "The
  // Hulk" contra a busca "Hulk" tem primeiro token 'the' x 'hulk'. Artigo é
  // ruído do release, não outra obra: "The"/"La" não podem condenar a release
  // certa nem quando o alias omite o artigo.
  const cases = [
    { title: 'The Hulk (2003) 1080p BluRay', names: ['Hulk'], year: 2003 },
    { title: 'The Green Mile (1999) 1080p WEB-DL', names: ['Green Mile'], year: 1999 },
    { title: 'La Vie est Belle (1997) 720p DVDRip', names: ['Vie est Belle'], year: 1997 },
  ];
  for (const { title, names, year } of cases) {
    assert.equal(
      relevantRaw([{ title }], { names, year, isSeries: false }).length,
      1,
      title,
    );
  }
});

// Títulos reais do Jackett/ThePirateBay numa busca por "Scary Movie 2000": o
// REMUX e o YTS são o filme certo; as duas coleções da franquia, o pack
// completo e o "Scary Movie 2" são outra coisa; a paródia de 1999 só cita as
// palavras. O contrato cru tem que separar os dois lados sem gastar rede.
test('filtro relevante cru: títulos reais do Jackett/TPB para Scary Movie 2000', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const keep = [
    'Scary Movie 2000 REPACK BluRay 1080p DTS-HD MA 5 1 AVC HYBRID REMUX-FraMeST',
    'Scary Movie (2000) 720p BRRip x264 -YTS',
  ];
  const drop = [
    'Scary Movie 1-5 Collection 2000-2013 1080p BluRay HEVC x265 5.1 BONE',
    'Scary Movie Collection 1-5 2000-2013 720p BluRay x264 Mkvking',
    'The Scary Movie Complete 5 Film Collection - Comedy 2000-2013 En',
    'Scary Movie 2 2001 1080p BluRayRip Opus 5 1 x265-Lootera',
    'Titanic 2000 (Scary Sexy Disaster Movie) 1999 [DvdRip ENG]',
  ];
  for (const title of keep) {
    assert.equal(relevantRaw([{ title }], ctx).length, 1, title);
  }
  for (const title of drop) {
    assert.deepEqual(relevantRaw([{ title }], ctx), [], title);
  }
});

test('filtro relevante cru: artigo tolerado não abre obra diferente com ano', () => {
  // "The Suicide Squad (2021)" é OUTRO filme, não o de 2016: tolerar o artigo
  // inicial no prefixo não pode deixá-lo entrar — o ano tem que cortar.
  const item = { title: 'The Suicide Squad (2021) 1080p BluRay' };
  assert.deepEqual(
    relevantRaw([item], { names: ['Suicide Squad'], year: 2016, isSeries: false }),
    [],
  );
});

// Corpus real dos sites BR (scraper do Jackett) numa busca por "Scary Movie
// 2000": os packs de coleção, o filme certo e até o título com artigo solto
// ("A Todo Mundo em Pânico") são a obra procurada; o balde de 82 filmes, as
// sequências 2/4 e o "Missão: Impossível –" são outra coisa. A via BR passa
// pelo matchesBrTitle estrito, e o contrato cru tem que separar os dois lados.
test('filtro relevante cru: corpus real BR dublado do Scary Movie 2000', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const keep = [
    'Coleçao Todo Mundo Em Pânico – – Blu-Ray (2000-2013) [720p BLU-RAY DUBLADO 1.28 GB]',
    'Coleçao Todo Mundo Em Pânico – – Blu-Ray (2000-2013) [DUBLADO opção 2]',
    'Todo Mundo em Pânico: Coleção (2000 a 2013) [1080p LEGENDADO 6.19 GB]',
    'Todo Mundo em Pânico (2000) [1080p LEGENDADO 2.30 GB]',
    'A Todo Mundo em Pânico (2000) Dublado',
  ];
  const drop = [
    '82 Filmes em Bluray Dual Audio (2012-2013-2014-2015) [720p BLURAY DUBLADO 1 GB]',
    'Todo Mundo em Pânico 2 (2001) Dublado 1080p',
    'Todo Mundo em Pânico 4 (2006) Legendado',
    'Missão: Impossível – Todo Mundo em Pânico (2000)',
  ];
  for (const title of keep) {
    assert.equal(relevantRaw([{ title, isBr: true }], ctx).length, 1, title);
  }
  for (const title of drop) {
    assert.deepEqual(relevantRaw([{ title, isBr: true }], ctx), [], title);
  }
});

test('filtro relevante cru: filme pedido COM numeral continua casando', () => {
  // O nome procurado JÁ carrega a sequência ("Deadpool 2" contra release
  // "Deadpool 2"). A regra de sequência compara contra o que a busca pediu —
  // condenar número solto mataria qualquer filme cujo título tem sequência no
  // próprio nome.
  const ctx = { names: ['Deadpool 2'], year: 2018, isSeries: false };
  const item = { title: 'Deadpool 2 (2018) 1080p WEB-DL x264' };
  assert.deepEqual(relevantRaw([item], ctx), [item]);
});

test('filtro relevante cru: série não trata temporada como sequência de filme', () => {
  // "Round 6 2ª Temporada": em série o número antes do ruído é a TEMPORADA, não
  // a sequência da franquia. A regra nova de filme não pode vazar para série,
  // senão a 2ª temporada some da lista do S02E01.
  const item = { title: 'Round 6 2ª Temporada (2025) WEB-DL 1080p DUBLADO' };
  assert.deepEqual(
    relevantRaw([item], {
      names: ['Round 6', 'Squid Game', 'Round Six'],
      year: 2025,
      isSeries: true,
      season: 2,
      episode: 1,
    }),
    [item],
  );
});

test('limitByIndexer usa o override individual quando a chave existe', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'yts-3', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'rarbg' },
    { id: 'rarbg-2', _indexer: 'rarbg' },
  ];
  // Cota global 1: o override do yts amplia para 3 e o do rarbg mantém 1.
  const out = limitByIndexer(streams, 1, new Set(), { yts: 3, rarbg: 1 });
  assert.deepEqual(out.map((s) => s.id), ['yts-1', 'yts-2', 'yts-3', 'rarbg-1']);
});

test('limitByIndexer: override 0 é sem limite, não "nenhum"', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'rarbg' },
  ];
  // Global 1; yts com override 0 fica sem teto; rarbg sem override cai no global.
  const out = limitByIndexer(streams, 1, new Set(), { yts: 0 });
  assert.deepEqual(out.map((s) => s.id), ['yts-1', 'yts-2', 'rarbg-1']);
});

test('limitByIndexer cai no teto global para indexador sem override', () => {
  const streams = [
    { id: 'yts-1', _indexer: 'yts' },
    { id: 'yts-2', _indexer: 'yts' },
    { id: 'rarbg-1', _indexer: 'rarbg' },
  ];
  // Só o rarbg tem override; o yts continua preso ao maxPerIndexer global.
  assert.deepEqual(
    limitByIndexer(streams, 1, new Set(), { rarbg: 5 }).map((s) => s.id),
    ['yts-1', 'rarbg-1'],
  );
});

test('vaga reservada BR fura o teto individual do indexador', () => {
  const streams = [
    { id: 'br-1', _indexer: 'bludv', _br: true },
    { id: 'br-2', _indexer: 'bludv', _br: true },
    { id: 'br-3', _indexer: 'bludv', _br: true },
    { id: 'yts-1', _indexer: 'yts' },
  ];
  // Override 1 no bludv e reserva de 2: as duas primeiras BR furam a cota, a
  // terceira (fora da reserva) é barrada e ainda conta para a contagem.
  const exempt = new Set([streams[0], streams[1]]);
  const out = limitByIndexer(streams, 2, exempt, { bludv: 1, yts: 5 });
  assert.deepEqual(out.map((s) => s.id), ['br-1', 'br-2', 'yts-1']);
});

test('reserva BR fura a cota individual por indexador em limitReservingBr', () => {
  const streams = [
    { id: 'br-1', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-2', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'br-3', _quality: '1080p', _br: true, _dubbed: true, _indexer: 'bludv' },
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
  ];
  // Override 1 no bludv com 2 vagas reservadas: a reserva continua entregando
  // os dois dublados acima da cota individual.
  const out = limitReservingBr(streams, {
    brReservedSlots: 2,
    maxResults: 10,
    maxPerIndexer: 1,
    indexerLimits: { bludv: 1 },
  });
  assert.deepEqual(out.map((s) => s.id), ['br-1', 'br-2', 'yts-1']);
});

test('cota individual rejeitada não consome vaga de qualidade', () => {
  const streams = [
    { id: 'yts-1', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'yts-2', _quality: '1080p', _br: false, _indexer: 'yts' },
    { id: 'rarbg-1', _quality: '1080p', _br: false, _indexer: 'rarbg' },
  ];
  const out = limitReservingBr(streams, {
    brFirst: false,
    maxResults: 10,
    qualityLimits: { '1080p': 2 },
    indexerLimits: { yts: 1 },
  });
  assert.deepEqual(out.map((s) => s.id), ['yts-1', 'rarbg-1']);
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
    const streams = [];
    for (let i = 0; i < 220; i += 1) {
      const exact = i % 2 === 0;
      streams.push(toStremioStream({
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

  const opts = { season: 1, episode: 5, maxResults: 220 };
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
  const streams = [];
  const seedersByHash = new Map();
  for (let i = 0; i < 250; i += 1) {
    const infoHash = (i + 1).toString(16).padStart(40, '0');
    const seeders = 1 + ((i * 13) % 900);
    seedersByHash.set(infoHash, seeders);
    streams.push(toStremioStream({
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
