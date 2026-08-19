const { test } = require('node:test');
const assert = require('node:assert');

// A flag precisa ser fixada ANTES do require: config.js lê o process.env uma
// única vez no carregamento, e cada arquivo de teste roda em processo próprio.
process.env.JACKETT_PT_SWEEP_GLOBAL = 'false';

const config = require('../src/config');

test('JACKETT_PT_SWEEP_GLOBAL=false desliga a varredura pt-BR nos globais', () => {
  assert.equal(config.jackett.ptSweepGlobal, false);
});

// 6.2 — Filme e série usam o título pt-BASE (sem subtítulo, sem ano, sem
// SxxEyy): tracker global casa por palavras — "Jornada nas Estrelas S01E04"
// devolvia 0 no thepiratebay, o título puro devolvia 6 (incluindo o "T01 E004
// … Dub PT-BR"). O corte por episódio é do matchContext, que roda depois. O
// gate "pt difere do original" mora no seletor puro abaixo — sem ele, a
// varredura rodava em TODO filme.
const { ptSweepQueryFor } = require('../src/providers/search-plan');

test('filme e série usam título pt base na varredura global', () => {
  // Filme com pt localizado: strip do subtítulo, sem ano.
  const filTitles = { pt: 'Jornada nas Estrelas: O Filme', original: 'Star Trek: The Motion Picture' };
  assert.equal(ptSweepQueryFor({ titles: filTitles }), 'Jornada nas Estrelas');
  // Filme sem pt localizado (pt === original): null — gate evita fan-out inútil.
  const enTitles = { pt: 'Joker', original: 'Joker' };
  assert.equal(ptSweepQueryFor({ titles: enTitles }), null);
  // Série: raiz pt, sem SxxEyy — os indexers publicam "T01 E004".
  const serTitles = { pt: 'Jornada nas Estrelas: A Nova Geração', original: 'Star Trek: The Next Generation' };
  assert.equal(ptSweepQueryFor({ titles: serTitles }), 'Jornada nas Estrelas');
});
