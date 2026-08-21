import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickFile, pickWorkFile, looksMultiWorkFiles, workCoverage, WorkPickError, isWorkPickError, isEpisodePickError,
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

test('pickFile torrent sem vídeo devolve null (não lança WorkPickError)', () => {
  assert.equal(pickFile([{ path: 'readme.txt', size: 100 }], {}), null);
  assert.equal(pickFile([], {}), null);
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
