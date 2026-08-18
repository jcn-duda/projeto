const { test } = require('node:test');
const assert = require('node:assert');

// A flag precisa ser fixada ANTES do require: config.js lê o process.env uma
// única vez no carregamento, e cada arquivo de teste roda em processo próprio.
process.env.JACKETT_PT_SWEEP_GLOBAL = 'false';

const config = require('../src/config');

test('JACKETT_PT_SWEEP_GLOBAL=false desliga a varredura pt-BR nos globais', () => {
  assert.equal(config.jackett.ptSweepGlobal, false);
});

// Filme usa o título pt-BASE (sem subtítulo, sem ano) — tracker global casa
// por palavras. Série continua com a query do SxxEyy/pack, porque o corte
// por episódio chega depois. O gate "pt difere do original" mora no
// seletor puro abaixo — sem ele, a varredura rodava em TODO filme.
const { ptSweepQueryFor } = require('../src/providers/search-plan');

test('filme usa título pt base; série usa a query do SxxEyy/pack', () => {
  // Filme com pt localizado: strip do subtítulo, sem ano.
  const filTitles = { pt: 'Jornada nas Estrelas: O Filme', original: 'Star Trek: The Motion Picture' };
  assert.equal(
    ptSweepQueryFor({ season: null, titles: filTitles, activePtQuery: 'Jornada nas Estrelas: O Filme 1979' }),
    'Jornada nas Estrelas',
  );
  // Filme sem pt localizado (pt === original): null — gate evita fan-out inútil.
  const enTitles = { pt: 'Joker', original: 'Joker' };
  assert.equal(
    ptSweepQueryFor({ season: null, titles: enTitles, activePtQuery: null }),
    null,
  );
  // Série: usa activePtQuery direto (já leva o gate e o SxxEyy/pack).
  const serTitles = { pt: 'Fallout', original: 'Fallout' };
  assert.equal(
    ptSweepQueryFor({ season: 1, titles: serTitles, activePtQuery: 'Fallout S01E01' }),
    'Fallout S01E01',
  );
});
