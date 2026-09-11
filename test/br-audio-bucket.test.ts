import { test } from 'node:test';
import assert from 'node:assert';

// Baldes de áudio do título (audioBucket/hasPtSigns) — extraído de
// test/br-title.test.ts na divisão temática (teto 400 linhas): aquele arquivo
// é do filtro estrito de TÍTULO (matchesBrTitle), este é da classificação de
// ÁUDIO, que decide vaga reservada e o que a limpeza pode tocar.
import { audioBucket, hasPtSigns } from '../src/utils/audio-quality.js';

test('audioBucket: dublado explícito cai no balde dub', () => {
  assert.equal(audioBucket('Coringa (2019) BluRay [1080p DUBLADO]'), 'dub');
  assert.equal(audioBucket('Show 1ª Temporada (2022) WEB-DL Dublado'), 'dub');
});

test('audioBucket: Dual sem PT ao lado é ambíguo (dual)', () => {
  assert.equal(audioBucket('Some.Movie.2024.DUAL.1080p.WEB.x264'), 'dual');
  // Dual + PT explícito sobe para dub (looksPtBr).
  assert.equal(audioBucket('Some.Movie.2024.Dual.Audio.PT-BR.1080p'), 'dub');
});

test('audioBucket: sem marca de áudio, mas com sinal de PT (pt)', () => {
  // Vocabulário de post BR sem marca de áudio: "Temporada"/"Completa".
  assert.equal(audioBucket('Show Temporada Completa'), 'pt');
  // Acentos quase exclusivos do pt-BR também contam.
  assert.equal(audioBucket('A Vingança do Coração'), 'pt');
  assert.equal(hasPtSigns('Temporada Completa'), true);
  assert.equal(hasPtSigns('Some.Movie.2024.1080p.WEB.x264'), false);
});

test('audioBucket: release estrangeira sem marca nem sinal de PT (lixo)', () => {
  assert.equal(audioBucket('Some.Movie.2024.1080p.WEB.x264'), 'lixo');
});

test('audioBucket: título PT TODO EM CAIXA ALTA não perde os acentos (não cai no lixo)', () => {
  // Ã/Ç maiúsculos: sem o flag i o sinal sumia, o balde virava 'lixo' e a
  // varredura destrutiva sweepUndubbed apagava o magnet.
  assert.equal(hasPtSigns('OPERAÇÃO INVASÃO 2019'), true);
  assert.notEqual(audioBucket('OPERAÇÃO INVASÃO 2019'), 'lixo');
  assert.equal(audioBucket('OPERAÇÃO INVASÃO 2019'), 'pt');
});
