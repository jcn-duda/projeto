import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickFile, pickWorkFile, looksMultiWorkFiles, workCoverage, WorkPickError, isWorkPickError, isEpisodePickError,
  NoVideoError,
} from '../src/debrid/common.js';

// Escolha POR OBRA dentro de pack multi-filme: a dica assinada na URL de play
// (nomes + ano) guia o pickFile; sem casamento confiável a escolha falha com
// WorkPickError (falha explícita), nunca cai no maior arquivo — que tocaria o
// filme errado.

const f = (path: any, size: any) => ({ path, size });

// Pack "Jornada nas Estrelas (Todos os filmes 1979-2016) Dublado": franquia
// se contém ("Jornada nas Estrelas" está em todos), o ano é o desempate.
const PACK = [
  f('Jornada nas Estrelas O Filme (1979) Dublado 1080p.mkv', 8 * 1024 ** 3),
  f('Jornada nas Estrelas II A Ira de Khan (1982) Dublado 1080p.mkv', 9 * 1024 ** 3),
  f('Star Trek Into Darkness (2013) Dublado 1080p.mkv', 11 * 1024 ** 3),
  f('Extras/Behind the Scenes Making Of.mkv', 2 * 1024 ** 3),
];

test('workCoverage mede fração de tokens significativos do nome', () => {
  assert.equal(workCoverage('Jornada nas Estrelas O Filme (1979).mkv', 'Jornada nas Estrelas'), 1);
  assert.equal(workCoverage('Arquivo Qualquer.mkv', 'Jornada nas Estrelas'), 0);
  // Nome sem token significativo não casa com nada.
  assert.equal(workCoverage('qualquer coisa', 'O A'), 0);
  assert.equal(workCoverage('It 2017 1080p.mkv', 'It'), 1);
});

test('pickWorkFile casa por nome e desempata por ano', () => {
  const hint = { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1982 };
  const file = pickWorkFile(PACK, hint);
  assert.equal(file!.path, 'Jornada nas Estrelas II A Ira de Khan (1982) Dublado 1080p.mkv');

  // Obra que não existe no pack: falha explícita, não o maior arquivo.
  assert.equal(pickWorkFile(PACK, { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1991 }), null);

  // Dois candidatos plausíveis sem ano: ambíguo, falha explícita.
  const semAno = pickWorkFile(PACK, { names: ['Jornada nas Estrelas', 'Star Trek'] });
  assert.equal(semAno, null);

  // Nenhum nome casa: falha explícita.
  assert.equal(pickWorkFile(PACK, { names: ['Blade Runner'], year: 1982 }), null);
});

test('pickFile com dica escolhe a obra certa em pack multi-filme', () => {
  const file = pickFile(PACK, {
    work: { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1979 },
  });
  assert.equal(file!.path, 'Jornada nas Estrelas O Filme (1979) Dublado 1080p.mkv');
});

test('pickFile com dica falha quando a obra não está no pack', () => {
  // Sem casamento confiável lança WorkPickError: quem chama responde 404 e o
  // usuário escolhe outro stream — tocar o maior arquivo seria o filme errado.
  assert.throws(
    () => pickFile(PACK, {
      work: { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1991 },
    }),
    (err) => isWorkPickError(err),
  );
});

test('pickFile com dica ignora extras na contagem de vídeos principais', () => {
  // Pack com UM filme + extras: o filme é o único vídeo principal, e a dica
  // não pode condená-lo por falta de casamento com "Making Of".
  const pack = [
    f('Jornada nas Estrelas O Filme (1979) Dublado 1080p.mkv', 8 * 1024 ** 3),
    f('Extras/Featurette - Making Of.mkv', 1 * 1024 ** 3),
    f('Extras/Interviews.mkv', 500 * 1024 ** 2),
  ];
  const file = pickFile(pack, { work: { names: ['Jornada nas Estrelas'], year: 1979 } });
  assert.equal(file!.path, 'Jornada nas Estrelas O Filme (1979) Dublado 1080p.mkv');
});

test('pickFile sem dica mantém o comportamento antigo (maior vídeo)', () => {
  // Compatibilidade: URL antiga sem `w` segue tocando o maior arquivo.
  const file = pickFile(PACK, {});
  assert.equal(file!.path, 'Star Trek Into Darkness (2013) Dublado 1080p.mkv');
});

test('pickFile com s/e tem precedência sobre a dica (série)', () => {
  const series = [
    f('Show S01E02.mkv', 1 * 1024 ** 3),
    f('Show S01E03.mkv', 4 * 1024 ** 3),
  ];
  const file = pickFile(series, { season: 1, episode: 2 });
  assert.equal(file!.path, 'Show S01E02.mkv');
});

test('pickFile reconhece nomenclatura BR de episódios dentro de pack', () => {
  const formats = [
    'Show S01E05.mkv', 'Show s1e5.mkv', 'Show S01.E05.mkv', 'Show S01_E05.mkv',
    'Show S01 - E05.mkv', 'Show 1x05.mkv', 'Show 01x5.mkv', 'Show Episódio 05.mkv',
    'Show Capitulo 05.mkv', 'Show EP05.mkv', 'Show E05.mkv', 'Show S01E005.mkv',
    'Show T01 - 005.mkv',
    // Forma TxxEyy de packs BR reais ("True Detective 1ª Temporada Completa
    // Dual BluRay": arquivos "T01E01 - O Distante Brilho da Escuridão.mkv").
    // Não casa nos fracos porque o \b não existe entre "T01" e "E05".
    'Show T01E05.mkv', 'Show.T01E05.mkv', 'T01E05 - Nome do Episódio.mkv',
  ];
  for (const path of formats) {
    const file = pickFile([f(path, 1), f('Show S01E06.mkv', 2)], { season: 1, episode: 5 });
    assert.equal(file!.path, path, path);
  }
});

test('pickFile não aceita número nu sem pista da temporada', () => {
  assert.throws(
    () => pickFile([f('Show.05.Coisa.mkv', 1), f('Show.06.Coisa.mkv', 2)], { season: 4, episode: 5 }),
    (err) => isEpisodePickError(err),
  );
});

test('pickFile falha explicitamente se pack multi-vídeo não identifica episódio', () => {
  assert.throws(
    () => pickFile([f('parte-a.mkv', 1), f('parte-b.mkv', 2)], { season: 1, episode: 5 }),
    (err) => isEpisodePickError(err),
  );
  const only = pickFile([f('episodio-sem-nome.mkv', 1)], { season: 1, episode: 5 });
  assert.equal(only!.path, 'episodio-sem-nome.mkv');
});

test('pickFile: EP solto em pack multi-temporada aplainado toca a temporada pedida', () => {
  // Ambos os arquivos casam "EP09"; só o caminho da temporada distingue. O
  // resultado tem que ser o da temporada pedida, não o primeiro da listagem.
  const pack = [
    f('Show/Season 1/EP09.mkv', 1 * 1024 ** 3),
    f('Show/Season 4/EP09.mkv', 1 * 1024 ** 3),
  ];
  const file = pickFile(pack, { season: 4, episode: 9 });
  assert.equal(file!.path, 'Show/Season 4/EP09.mkv');
});

test('pickFile: pack com temporadas divergentes e sem casamento forte falha explícito', () => {
  // Nenhum arquivo declara a temporada pedida (S03) e há marcadores de outras
  // temporadas no pack: aceitar o "EP09" solto seria adivinhar a qual
  // temporada ele pertence. 404 honesto em vez de episódio errado.
  const pack = [
    f('Show/S01/EP09.mkv', 1 * 1024 ** 3),
    f('Show/S02/EP09.mkv', 1 * 1024 ** 3),
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 9 }),
    (err) => isEpisodePickError(err),
  );
});

test('pickFile: marcador que confirma a temporada pedida não bloqueia o EP solto', () => {
  // O S01E06 do mesmo pack confirma que o "Episódio 05" é da temporada 1;
  // só um marcador DIVERGENTE deve criar ambiguidade.
  const pack = [
    f('Show Episódio 05.mkv', 1),
    f('Show S01E06.mkv', 2),
  ];
  const file = pickFile(pack, { season: 1, episode: 5 });
  assert.equal(file!.path, 'Show Episódio 05.mkv');
});

test('pickFile: pasta "2ª Temporada" declara a temporada pedida (forma pt-BR)', () => {
  const pack = [
    f('2ª Temporada/Episodio 05.mkv', 1),
    f('2ª Temporada/Episodio 06.mkv', 2),
  ];
  const file = pickFile(pack, { season: 2, episode: 5 });
  assert.equal(file!.path, '2ª Temporada/Episodio 05.mkv');
});

test('pickFile: pack só de EP solto, sem temporada numerada, continua tocando', () => {
  // Sem marcador de temporada algum, o pack é presumivelmente da temporada
  // pedida — a forma clássica dos packs BR.
  const pack = [
    f('Show/EP05.mkv', 1),
    f('Show/EP06.mkv', 2),
  ];
  const file = pickFile(pack, { season: 1, episode: 5 });
  assert.equal(file!.path, 'Show/EP05.mkv');
});

test('looksMultiWorkFiles distingue obras por anos dos vídeos principais', () => {
  assert.equal(looksMultiWorkFiles(PACK), true);
  assert.equal(looksMultiWorkFiles([
    f('Jornada nas Estrelas O Filme (1979).mkv', 8 * 1024 ** 3),
    f('Extras/Making Of.mkv', 1 * 1024 ** 3),
  ]), false);
  assert.equal(looksMultiWorkFiles([]), false);
});

test('looksMultiWorkFiles é permissivo para encodes do mesmo filme ou sem ano', () => {
  assert.equal(looksMultiWorkFiles([
    f('Jornada nas Estrelas (1979) 720p.mkv', 4 * 1024 ** 3),
    f('Jornada nas Estrelas (1979) 1080p.mkv', 8 * 1024 ** 3),
  ]), false);
  assert.equal(looksMultiWorkFiles([
    f('Jornada nas Estrelas 720p.mkv', 4 * 1024 ** 3),
    f('Jornada nas Estrelas 1080p.mkv', 8 * 1024 ** 3),
  ]), false);
});

test('pickFile toca o maior encode quando o filme único não tem ano nos nomes', () => {
  const file = pickFile([
    f('Star Trek The Motion Picture 720p.mkv', 4 * 1024 ** 3),
    f('Star Trek The Motion Picture 1080p.mkv', 8 * 1024 ** 3),
  ], { work: { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1979 } });
  assert.equal(file!.path, 'Star Trek The Motion Picture 1080p.mkv');
});

test('pickFile aceita título curto usando todos os tokens disponíveis', () => {
  const file = pickFile([
    f('It (2017) 720p.mkv', 4 * 1024 ** 3),
    f('It (2017) 1080p.mkv', 8 * 1024 ** 3),
  ], { work: { names: ['It'], year: 2017 } });
  assert.equal(file!.path, 'It (2017) 1080p.mkv');
  assert.equal(looksMultiWorkFiles([
    f('It 1920x1080.mkv', 4 * 1024 ** 3),
    f('It 1920x1080 WEB.mkv', 8 * 1024 ** 3),
  ]), false);
});

test('pickFile com pack=true lança WorkPickError em trilogia sem ano no arquivo', () => {
  // Poderoso Chefão Parte I/II/III: a listagem disse que é pack, mas os
  // arquivos não têm anos distintos e pickWorkFile não consegue desempatar.
  const godfather = [
    f('The Godfather Part I.mkv', 4 * 1024 ** 3),
    f('The Godfather Part II.mkv', 5 * 1024 ** 3),
    f('The Godfather Part III.mkv', 3 * 1024 ** 3),
  ];
  assert.throws(
    () => pickFile(godfather, { work: { names: ['O Poderoso Chefão', 'The Godfather'], year: 1972, pack: true } }),
    (err) => isWorkPickError(err),
  );
});

test('pickFile sem pack e sem anos toca o maior arquivo (não lança)', () => {
  const encodes = [
    f('Star Trek The Motion Picture 720p.mkv', 4 * 1024 ** 3),
    f('Star Trek The Motion Picture 1080p.mkv', 8 * 1024 ** 3),
  ];
  const file = pickFile(encodes, { work: { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1979 } });
  assert.equal(file!.path, 'Star Trek The Motion Picture 1080p.mkv');
});

test('pickFile com pack=true e obra identificável pelo ano escolhe certo', () => {
  const file = pickFile(PACK, {
    work: { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1982, pack: true },
  });
  assert.equal(file!.path, 'Jornada nas Estrelas II A Ira de Khan (1982) Dublado 1080p.mkv');
});

test('pickFile distingue listagem vazia de torrent sem vídeo', () => {
  // Listagem COM arquivos e nenhum vídeo é prova determinística de magnet
  // quebrado: lança NoVideoError para o /resolve gravar bad no banco.
  assert.throws(() => pickFile([{ path: 'readme.txt', size: 100 }], {}), NoVideoError);
  // Listagem VAZIA é transferência fria ("ainda baixando"): null, prova nenhuma.
  assert.equal(pickFile([], {}), null);
});

// Vídeo único com nome técnico: o caso True Detective S03E02. O pack anunciava
// a temporada 3 mas continha só "S03E07" — o fallback antigo tocava o episódio
// 7 em silêncio. Agora o nome do arquivo é conferido contra o pedido.
test('pickFile: vídeo único com OUTRO episódio lança EpisodePickError com evidência', () => {
  assert.throws(
    () => pickFile([f('True.Detective.S03E07.1080p.WEB.mkv', 2 * 1024 ** 3)], { season: 3, episode: 2 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err), 'erro tipado');
      assert.ok(Array.isArray(err.evidence?.declaredEpisodes), 'evidência presente');
      assert.ok(err.evidence.declaredEpisodes.includes(7), 'o arquivo declara o episódio 7');
      assert.equal(err.evidence.wantedEpisode, 2);
      assert.equal(err.evidence.wantedSeason, 3);
      return true;
    },
  );
});

test('pickFile: vídeo único de OUTRA temporada (sem episódio) também lança', () => {
  assert.throws(
    () => pickFile([f('Show.S02.1080p.mkv', 2 * 1024 ** 3)], { season: 3, episode: 2 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence.declaredSeasons.includes(2), 'declara a temporada 2');
      assert.equal(err.evidence.declaredEpisodes.length, 0, 'sem episódio declarado');
      return true;
    },
  );
});

test('pickFile: episódio certo em temporada errada lança (dimensões independentes)', () => {
  // O arquivo casa o episódio 5 pedido, mas declara a temporada 2 — a
  // checagem de temporada não pode depender de "não haver episódio declarado",
  // senão este caso tocava o episódio certo da temporada errada.
  assert.throws(
    () => pickFile([f('Show.S02E05.1080p.mkv', 2 * 1024 ** 3)], { season: 3, episode: 5 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence.declaredSeasons.includes(2), 'declara a temporada 2');
      assert.ok(err.evidence.declaredEpisodes.includes(5), 'declara o episódio 5 (que casa)');
      return true;
    },
  );
});

test('pickFile: vídeo único com o episódio certo resolve normalmente', () => {
  const file = pickFile([f('Show.S03E02.mkv', 2 * 1024 ** 3)], { season: 3, episode: 2 });
  assert.equal(file!.path, 'Show.S03E02.mkv');
});

test('pickFile: nomes sem declaração de s/e continuam passando (compatibilidade)', () => {
  // Torrent de episódio sem nome técnico, filme sem s/e e token de resolução
  // (1920x1080 não pode virar S20/E108 no parse) — nenhum pode condenar.
  assert.equal(
    pickFile([f('episodio-sem-nome.mkv', 1)], { season: 1, episode: 5 })!.path,
    'episodio-sem-nome.mkv',
  );
  assert.equal(
    pickFile([f('Filme.2019.1080p.BluRay.x264.mkv', 1)], { season: 1, episode: 5 })!.path,
    'Filme.2019.1080p.BluRay.x264.mkv',
  );
  assert.equal(
    pickFile([f('Show.1920x1080.WEB.mkv', 1)], { season: 1, episode: 5 })!.path,
    'Show.1920x1080.WEB.mkv',
  );
  // Nome de série inteira cobre qualquer episódio.
  assert.equal(
    pickFile([f('Show Todas as Temporadas 1080p.mkv', 1)], { season: 1, episode: 5 })!.path,
    'Show Todas as Temporadas 1080p.mkv',
  );
});

test('pickFile: tag de áudio colada em dígito não vira temporada', () => {
  // O padrão de temporada do parseTitleSeasonEpisode (`s(\d)`) não exige
  // fronteira à esquerda, então "DTS5.1"/"Atmos5.1" eram lidos como S05 e
  // condenavam episódio legítimo sem marcador no nome — o arquivo não declara
  // temporada nenhuma, e recusar aqui é 404 em play bom.
  for (const path of [
    'Nome.do.Episodio.DTS5.1.mkv',
    'Nome.do.Episodio.Atmos5.1.mkv',
    'O.Distante.Brilho.DTS5.1.x264.mkv',
  ]) {
    assert.equal(pickFile([f(path, 1)], { season: 3, episode: 2 })!.path, path, path);
  }
  // A limpeza não pode cegar a checagem: "S03"/"S02" com separador antes
  // continuam sendo temporada de verdade, com ou sem a tag de áudio ao lado.
  assert.equal(
    pickFile([f('Show.S03.1080p.DTS5.1.mkv', 1)], { season: 3, episode: 2 })!.path,
    'Show.S03.1080p.DTS5.1.mkv',
  );
  assert.throws(
    () => pickFile([f('Show.S02.1080p.DTS5.1.mkv', 1)], { season: 3, episode: 2 }),
    (err) => isEpisodePickError(err),
  );
});

test('pickWorkFile usa basename: pasta "Trilogia (1985-1990)" não contamina casamento de ano', () => {
  // Paths reais do AllDebrid: a pasta raiz carrega a faixa de anos do pack.
  const pack = [
    f('Ritorno al futuro Trilogia (1985-1990)/Ritorno al futuro - Back to the Future 1 (1985) ITA 2160p.mkv', 3.7 * 1024 ** 3),
    f('Ritorno al futuro Trilogia (1985-1990)/Ritorno al futuro - Back to the Future 2 (1989) ITA 2160p.mkv', 3.7 * 1024 ** 3),
    f('Ritorno al futuro Trilogia (1985-1990)/Ritorno al futuro - Back to the Future 3 (1990) ITA 2160p.mkv', 3.8 * 1024 ** 3),
  ];
  // Pediu 1985: antes do fix, 1985 casava nos 3 (pasta) → maior → filme 3.
  // Depois do fix, 1985 só casaria em Back to the Future 1 (1985) pelo basename.
  // Mas "Back to the Future" tem cobertura com "De Volta para o Futuro"?
  // workCoverage testa basename primeiro — basename não tem "Ritorno al futuro".
  // Com basename: cobertura dos basenames "back to the future 1 (1985)" etc.
  // contra names=["de volta para o futuro","back to the future"] → "back","to",
  // "the","future" casam nos basenames → cobertura OK para os 3 → ano desempata.
  const file = pickWorkFile(pack, { names: ['De Volta para o Futuro', 'Back to the Future'], year: 1985 });
  assert.ok(file, 'deve encontrar um arquivo');
  assert.match(String(file!.path), /1985/, 'deve escolher o filme de 1985, não o de 1990');
});

test('pickFile: layout de canais de áudio não vira episódio nu', () => {
  // Caso medido no True Detective: "…S03E07…DDP5.1.H.264-NTb.mkv" casava o
  // EPISÓDIO 1 pelo "1" nu de "DDP5.1", e como "S03" satisfazia a temporada
  // isso virava escolha FORTE — o play do E01 recebia o E07 antes de qualquer
  // checagem. Vale para o episódio 1 de qualquer série com áudio 5.1/7.1.
  const e07 = 'True.Detective.S03E07.The.Final.Country.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv';
  for (const episode of [1, 2, 5]) {
    assert.throws(
      () => pickFile([f(e07, 3 * 1024 ** 3)], { season: 3, episode }),
      (err) => isEpisodePickError(err),
      `E07 não pode servir o episódio ${episode}`,
    );
  }
  assert.equal(pickFile([f(e07, 1)], { season: 3, episode: 7 })!.path, e07, 'o episódio dele continua tocando');
  for (const path of ['Show.S02E09.1080p.TrueHD.7.1.Atmos.mkv', 'Show.S02E09.1080p.AAC2.0.mkv']) {
    assert.throws(
      () => pickFile([f(path, 1)], { season: 2, episode: 1 }),
      (err) => isEpisodePickError(err),
      path,
    );
  }

  // O episódio 1 de verdade continua casando, nas três formas que o achavam
  // antes — inclusive as que dependem do número nu ("S03.01", "S5.1").
  const ok: [string[], number, number, string][] = [
    [['True.Detective.S03E01.1080p.AMZN.WEB-DL.DDP5.1.mkv'], 3, 1, 'True.Detective.S03E01.1080p.AMZN.WEB-DL.DDP5.1.mkv'],
    [['Show/Temporada 3/Episodio 01 DDP5.1.mkv'], 3, 1, 'Show/Temporada 3/Episodio 01 DDP5.1.mkv'],
    [['Show.S03.01.DDP5.1.mkv', 'Show.S03.02.DDP5.1.mkv'], 3, 1, 'Show.S03.01.DDP5.1.mkv'],
    [['Show.S5.1.mkv', 'Show.S5.2.mkv'], 5, 1, 'Show.S5.1.mkv'],
    [['S01E05.1080p.DDP5.1.mkv', 'S01E01.1080p.DDP5.1.mkv'], 1, 1, 'S01E01.1080p.DDP5.1.mkv'],
  ];
  for (const [paths, season, episode, esperado] of ok) {
    const file = pickFile(paths.map((p, i) => f(p, i + 1)), { season, episode });
    assert.equal(file!.path, esperado, paths.join(' + '));
  }
});
