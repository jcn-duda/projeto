// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// temporada/episódio — parseTitleSeasonEpisode, matchesEpisode, cobertura de
// pack, T-format de parsing, dubbedLieVerdict e decodeEntities.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseTitleSeasonEpisode,
  matchesEpisode,
  seasonCoverageExcludes,
  dubbedLieVerdict,
  decodeEntities,
} from '../src/utils/format.js';

test('auditoria conservadora dos cinco packs reais de True Detective', () => {
  const promised = true;
  const lies = [
    'True.Detective.S02E01.1080p.WEBRip.x264.DD5.1-RARBG.mkv',
    'True.Detective.S02E01.HDTV.x264-KILLERS[ettv].mp4',
    'True Detective (2014) Season 2 S02 + Extras/True.Detective.S02.1080p.BluRay.x265-afm72.mkv',
    'True.Detective.2014.S02.1080p.BDRip.DDP5.1.10bit.x265-ToVaR.mkv',
  ];
  for (const path of lies) assert.equal(dubbedLieVerdict([path], promised).lie, true, path);
  // É dublado real, mas da temporada errada: idioma não pode condená-lo.
  assert.equal(dubbedLieVerdict(['1ª Temporada (2014)/S01E01 - Dublado Dual.mp4'], promised).lie, false);
  // Ausência de PT sem prova EN é ambígua; falso negativo é preferível.
  assert.equal(dubbedLieVerdict(['True.Detective.S02E01.1080p.mkv'], promised).lie, false);
});

test('cobertura explícita exclui temporada — o claim singular COMPLETA vence a menção descritiva', () => {
  const single = parseTitleSeasonEpisode('True Detective 3ª Temporada Completa Dublada');
  assert.equal(seasonCoverageExcludes(single, 2), true);
  assert.equal(matchesEpisode('True Detective 3ª Temporada Completa Dublada', { season: 2, episode: 1 }), false);
  // Medido no True Detective (hdrtorrent): "2ª Temporada Dublada e Dual 1ª
  // TEMPORADA COMPLETA" entregava só arquivos S01. Tratar a dupla menção como
  // ambígua fazia o pack S01 entrar na lista do S02E01 e ocupar vaga BR — o
  // claim singular COMPLETA é a cobertura real, a outra menção é descrição.
  const ambiguous = parseTitleSeasonEpisode('True Detective 2ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA DUBLADA');
  assert.equal(seasonCoverageExcludes(ambiguous, 2), false, 'o parser continua unindo; quem decide é a guarda do matchesEpisode');
  assert.equal(matchesEpisode('True Detective 2ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA DUBLADA', { season: 2, episode: 1 }), false);
  // A temporada realmente contida continua passando.
  assert.equal(matchesEpisode('True Detective 2ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA DUBLADA', { season: 1, episode: 1 }), true);
});

test('parseTitleSeasonEpisode cobre SxxExx, 1x04, packs e pt-BR', () => {
  assert.deepEqual(parseTitleSeasonEpisode('House Of The Dragon S01E04 2160p'), {
    seasons: [1], episodes: [4], complete: false, seasonPack: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie 1x04 720p'), {
    seasons: [1], episodes: [4], complete: false, seasonPack: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie S02E01-E03'), {
    seasons: [2], episodes: [1, 2, 3], complete: false, seasonPack: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('A Casa Do Dragao 1a Temporada WEB-DL Dual'), {
    seasons: [1], episodes: [], complete: false, seasonPack: false,
  });
  assert.deepEqual(parseTitleSeasonEpisode('Serie S01 Completa'), {
    seasons: [1], episodes: [], complete: false, seasonPack: false,
  });
  // Filme com "Episódio II" no nome não pode virar episódio de série.
  assert.deepEqual(parseTitleSeasonEpisode('Star Wars Episodio II Ataque dos Clones'), {
    seasons: [], episodes: [], complete: false, seasonPack: false,
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

  // LISTA de ordinais, não faixa: "1ª 2ª 3ª … 7ª Temporadas". Só o último
  // número encosta na palavra, então o padrão de temporada única lia [7] e o
  // pack inteiro sumia das seis primeiras. Título real do hdrtorrent, e o único
  // falso corte numa varredura de 3.794 títulos dos indexers BR.
  const lista = parseTitleSeasonEpisode(
    'Game of Thrones 1ª 2ª 3ª 4ª 5ª 6ª e 7ª Temporadas Dublada e Dual TODAS AS TEMPORADAS COMPLETAS DA 1ª À 7ª',
  );
  assert.deepEqual([...lista.seasons].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(matchesEpisode('Game of Thrones 1ª 2ª 3ª 4ª 5ª 6ª e 7ª Temporadas', { season: 3, episode: 1 }), true);

  // O plural é a âncora. No singular o número colado é a temporada do item, e o
  // post amplo em volta não pode devolver as outras temporadas para a lista.
  const item = parseTitleSeasonEpisode('True Blood Todas as Temporadas Completas Dublada e Dual 3ª TEMPORADA Dubbed 720P');
  assert.deepEqual(item.seasons, [3]);
  assert.equal(matchesEpisode('True Blood Todas as Temporadas Completas Dublada e Dual 3ª TEMPORADA', { season: 1, episode: 1 }), false);

  // Dígito preso a palavra técnica não vira temporada: só "2 temporadas" conta.
  assert.deepEqual(parseTitleSeasonEpisode('Serie X DDP5 1 Atmos 2 Temporadas').seasons, [2]);

  // Faixa absurda é erro de leitura: não expande. O padrão de temporada única
  // ainda lê o último número, e tudo bem — uma busca por S01 não casa com 90.
  const absurda = parseTitleSeasonEpisode('Coisa 1 a 90 temporada').seasons;
  assert.equal(absurda.includes(1), false, 'não pode inventar cobertura de 90 temporadas');
  assert.equal(matchesEpisode('Coisa 1 a 90 temporada', { season: 1, episode: 1 }), false);
});

test('pack de uma temporada não cobre outra temporada (True Detective S04E06)', () => {
  const s2 = 'True Detective 2ª Temporada Completa Dublada 2ª TEMPORADA COMPLETA Dual BLURAY 720P';
  const s1 = 'True Detective Completa Dublada 1ª TEMPORADA COMPLETA Dual BLURAY 720P';
  assert.equal(matchesEpisode(s2, { season: 4, episode: 6 }), false);
  assert.equal(matchesEpisode(s1, { season: 4, episode: 6 }), false);
  assert.equal(matchesEpisode(s2, { season: 2, episode: 1 }), true);
  assert.equal(matchesEpisode(s1, { season: 1, episode: 1 }), true);
});

test('"Temporada Completa" sem número não é série inteira, mas ainda passa', () => {
  const r = parseTitleSeasonEpisode('TEMPORADA COMPLETA 1080p Dublado');
  assert.equal(r.complete, false);
  assert.equal(r.seasonPack, true);
  // Sem pista de número, a brecha deliberada mantém a fonte BR na lista.
  assert.equal(matchesEpisode('TEMPORADA COMPLETA 1080p Dublado', { season: 4, episode: 6 }), true);
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

test('parseTitleSeasonEpisode entende T01 E004 sem interpretar T isolado', () => {
  assert.deepEqual(parseTitleSeasonEpisode('Jornada nas Estrelas T01 E004 Dublado').seasons, [1]);
  assert.deepEqual(parseTitleSeasonEpisode('Jornada nas Estrelas T01 E004 Dublado').episodes, [4]);
  assert.equal(matchesEpisode('Jornada nas Estrelas T01 E004 Dublado', { season: 1, episode: 5 }), false);
  assert.deepEqual(parseTitleSeasonEpisode('Temporada T').seasons, []);
  assert.deepEqual(parseTitleSeasonEpisode('Temporada T').episodes, []);
});

test('parseTitleSeasonEpisode preserva lista T01 E001 e E002', () => {
  assert.deepEqual(parseTitleSeasonEpisode('Serie T01 E001 e E002').episodes, [1, 2]);
});

// 6.3 — O parser lê o T-format dos trackers ("T01 E004", "T01E004") e o corte
// por episódio passa a valer de verdade: hoje sem o T-format, "matchesEpisode"
// libera a release para QUALQUER episódio.
test('parseTitleSeasonEpisode lê T01 E004 e T01E004 e corta o episódio pedido', () => {
  // Objeto completo, não só seasons/episodes: complete continua false e nada
  // além do T-format é lido.
  assert.deepEqual(parseTitleSeasonEpisode('Jornada Nas Estrelas T01 E004 1080p DUBLADO'), {
    seasons: [1], episodes: [4], complete: false, seasonPack: false,
  });
  // Sem espaço entre T/E também é o formato publicado pelos trackers.
  assert.deepEqual(parseTitleSeasonEpisode('Jornada Nas Estrelas T01E004 1080p DUBLADO'), {
    seasons: [1], episodes: [4], complete: false, seasonPack: false,
  });
  assert.equal(matchesEpisode('Jornada Nas Estrelas T01 E004 1080p DUBLADO', { season: 1, episode: 4 }), true);
  assert.equal(matchesEpisode('Jornada Nas Estrelas T01 E004 1080p DUBLADO', { season: 1, episode: 5 }), false);
  assert.equal(matchesEpisode('Jornada Nas Estrelas T01 E004 1080p DUBLADO', { season: 2, episode: 4 }), false);
});

test('T-format: hífen vira intervalo inclusivo; lista por e/vírgula/espaço não expande', () => {
  // Hífen/travessão no título CRU é intervalo inclusivo (E001-E010 → 1..10).
  // A normalização apaga o hífen (tudo vira espaço); a distinção precisa ser
  // lida do título cru, senão o E010 viraria lista de dois episódios.
  const faixa = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(parseTitleSeasonEpisode('Serie T01 E001-E010 720p').episodes, faixa);
  assert.equal(matchesEpisode('Serie T01 E001-E010 720p', { season: 1, episode: 5 }), true);
  assert.equal(matchesEpisode('Serie T01 E001-E010 720p', { season: 1, episode: 11 }), false);
  // Separador "e": lista de episódios, NÃO intervalo.
  assert.deepEqual(parseTitleSeasonEpisode('Serie T01 E001 e E002 720p').episodes, [1, 2]);
  assert.equal(matchesEpisode('Serie T01 E001 e E002 720p', { season: 1, episode: 2 }), true);
  // Vírgula idem: lista.
  assert.deepEqual(parseTitleSeasonEpisode('Serie T01 E001, E002 720p').episodes, [1, 2]);
  // Espaço SEM hífen não vira intervalo: E001 E010 é [1, 10], e o E05 não passa.
  assert.deepEqual(parseTitleSeasonEpisode('Serie T01 E001 E010 720p').episodes, [1, 10]);
  assert.equal(matchesEpisode('Serie T01 E001 E010 720p', { season: 1, episode: 5 }), false);
});

test('parseTitleSeasonEpisode não lê T solto nem T dentro de palavra', () => {
  // O T só conta colado ao dígito da temporada E ao E do episódio: "The 100",
  // "Torrent 2 E4", "T2 Trainspotting", "ST01E02" e "Lilo e Stitch 2" não são
  // temporada nenhuma.
  const semPista = ['The 100', 'Torrent 2 E4', 'T2 Trainspotting', 'ST01E02', 'Lilo e Stitch 2', 'Temporada T'];
  for (const title of semPista) {
    const r = parseTitleSeasonEpisode(title);
    assert.deepEqual(r.seasons, [], title);
    assert.deepEqual(r.episodes, [], title);
  }
});

// Fase E — pack de UMA temporada declarada não pode ser ampliado por uma
// menção descritiva de outra no MESMO título. Caso real (True Detective,
// hdrtorrent): o post dizia "2ª Temporada Dublada e Dual 1ª TEMPORADA
// COMPLETA", entregava só arquivos S01 e entrava na lista pedindo S02E01 —
// o parser fundia as duas menções em seasons=[2,1].
test('"Nº Temporada Completa" singular declara a cobertura exata do pack', () => {
  const packMentiroso = 'True Detective 2ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA  DUBLADA Dual  720P 720p, Bluray, HD';
  // A menção "2ª Temporada" NÃO dá cobertura de S02…
  assert.equal(matchesEpisode(packMentiroso, { season: 2, episode: 1 }), false, 'pack S1 não cobre S02E01');
  // …e a temporada realmente contida continua passando (sem falso negativo).
  assert.equal(matchesEpisode(packMentiroso, { season: 1, episode: 1 }), true, 'pack S1 cobre S01E01');

  // A outra ordem também declara: "Temporada 2 Completa".
  assert.equal(matchesEpisode('Serie Nacional Temporada 2 Completa Dublado 1080p', { season: 1, episode: 1 }), false);
  assert.equal(matchesEpisode('Serie Nacional Temporada 2 Completa Dublado 1080p', { season: 2, episode: 1 }), true);

  // Regressão do plural documentado na varredura dos títulos BR: lista de
  // ordinais antes do PLURAL é multi-temporada de verdade e não pode ser cortada.
  assert.equal(matchesEpisode('True Detective 1ª 2ª 3ª Temporadas Completa Dual Áudio 1080p', { season: 2, episode: 1 }), true);

  // Regressão do comportamento já medido: pack singular da temporada PEDIDA passa.
  assert.equal(matchesEpisode('Serie Boa 2ª Temporada Completa Dual Áudio 720p', { season: 2, episode: 3 }), true);
});

test('entidade HTML não pode apagar a temporada do pack', () => {
  // Caso medido (Dois Homens e Meio, The Pirate Bay): o post vem como
  // "4&ordf; Temporada Completa [Dublado]". Sem `ordf` na tabela, o parser não
  // lia temporada nenhuma — e pack sem temporada declarada casa QUALQUER
  // episódio, então os packs da 4ª, 5ª e 6ª apareciam na lista do S01E01.
  const cru = 'Dois Homens e Meio 4&ordf; Temporada Completa [Dublado]';
  assert.equal(decodeEntities(cru), 'Dois Homens e Meio 4ª Temporada Completa [Dublado]');
  assert.deepEqual(parseTitleSeasonEpisode(decodeEntities(cru)).seasons, [4]);
  assert.equal(matchesEpisode(decodeEntities(cru), { season: 1, episode: 1 }), false);
  assert.equal(matchesEpisode(decodeEntities(cru), { season: 4, episode: 1 }), true);

  // A tabela é consultada em minúsculas; letra única herda a caixa do nome.
  assert.equal(decodeEntities('Dual &Aacute;udio'), 'Dual Áudio');
  assert.equal(decodeEntities('10&ordm; Temp'), '10º Temp');
  // Entidade desconhecida continua intacta, e "&Amp;" não vira "&" maiúsculo.
  assert.equal(decodeEntities('&naoexiste; x'), '&naoexiste; x');
  assert.equal(decodeEntities('&Amp; teste'), '& teste');
});

