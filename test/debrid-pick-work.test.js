const { test } = require('node:test');
const assert = require('node:assert');

// Escolha POR OBRA dentro de pack multi-filme: a dica assinada na URL de play
// (nomes + ano) guia o pickFile; sem casamento confiável a resposta é null
// (falha explícita), nunca o maior arquivo — que tocaria o filme errado.
const { pickFile, pickWorkFile, workCoverage } = require('../src/debrid/common');

const f = (path, size) => ({ path, size });

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
});

test('pickWorkFile casa por nome e desempata por ano', () => {
  const hint = { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1982 };
  const file = pickWorkFile(PACK, hint);
  assert.equal(file.path, 'Jornada nas Estrelas II A Ira de Khan (1982) Dublado 1080p.mkv');

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
  assert.equal(file.path, 'Jornada nas Estrelas O Filme (1979) Dublado 1080p.mkv');
});

test('pickFile com dica falha quando a obra não está no pack', () => {
  // Sem casamento confiável devolve null: quem chama responde 404 e o usuário
  // escolhe outro stream — tocar o maior arquivo seria o filme errado.
  const file = pickFile(PACK, {
    work: { names: ['Jornada nas Estrelas', 'Star Trek'], year: 1991 },
  });
  assert.equal(file, null);
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
  assert.equal(file.path, 'Jornada nas Estrelas O Filme (1979) Dublado 1080p.mkv');
});

test('pickFile sem dica mantém o comportamento antigo (maior vídeo)', () => {
  // Compatibilidade: URL antiga sem `w` segue tocando o maior arquivo.
  const file = pickFile(PACK, {});
  assert.equal(file.path, 'Star Trek Into Darkness (2013) Dublado 1080p.mkv');
});

test('pickFile com s/e tem precedência sobre a dica (série)', () => {
  const series = [
    f('Show S01E02.mkv', 1 * 1024 ** 3),
    f('Show S01E03.mkv', 4 * 1024 ** 3),
  ];
  const file = pickFile(series, { season: 1, episode: 2 });
  assert.equal(file.path, 'Show S01E02.mkv');
});
