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
  markCachedName,
  matchesQualityFilter,
  toStremioStream,
  normalizeTitle,
  matchesName,
  resolveSearchNames,
  matchesEpisode,
  matchesBrTitle,
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
  assert.equal(s.name, '[PM+]\n1080p');
  assert.ok(!s.name.includes('Coringa'));
  assert.ok(!s.name.includes('👤'));
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
  assert.ok(s.name.includes('1080p DUB'));
  assert.ok(s.title.includes('Dublado'));
});

test('toStremioStream preserva a marca de origem BR do provider', () => {
  const s = toStremioStream({ title: 'Coringa Dublado', infoHash: HASH, isBr: true, seeders: 1 });
  assert.equal(s._br, true);
  assert.equal(s.name, '[PM+]\nDUB BR');
});

test('layout do Stremio mantém name compacto e detalhes na coluna larga', () => {
  const release = 'Sinners.2025.2160p.iT.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-HONE';
  const s = toStremioStream({
    title: release,
    infoHash: HASH,
    seeders: 181,
    size: 23.99 * 1024 ** 3,
    tracker: 'The Pirate Bay',
  });

  assert.equal(s.name, '[PM+]\n4K');
  assert.ok(s.name.length < 30);
  assert.ok(!s.name.includes('Sinners'));
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

  assert.equal(brUnknown.name, '[PM+]\nBR');
  assert.equal(dual.name, '[PM+]\n1080p DUAL BR');
  assert.equal(legendado.name, '[PM+]\n720p LEG');
});

test('selo de cache entra na marca curta sem deslocar a qualidade', () => {
  const name = '[PM+]\n1080p DUB BR';
  assert.equal(markCachedName(name), '[PM+] ⚡\n1080p DUB BR');
  assert.equal(markCachedName('Outro\n720p'), '⚡ Outro\n720p');
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
  // Sem `allNames` a checagem não roda — quem chama não tem a informação.
  assert.equal(
    matchesBrTitle('Fallout 4 (PC) [2015] Download Torrent', 'Fallout', null),
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
  const details = s.name.split('\n')[1];
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
