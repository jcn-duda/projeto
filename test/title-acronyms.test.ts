// Sigla com ponto no título (G.O.R.A., 2004 — medido em 2026-10-04): a consulta
// "G.O.R.A. 2004" não achava nada nos trackers e o filtro lia "g o r a", que
// nunca casava com a release "GORA 2004 1080p".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTitle, collapseAcronyms } from '../src/utils/title-normalization.js';
import { buildSearchQuery } from '../src/utils/search-names.js';
import { shapeSearchQuery } from '../src/providers/jackett-query.js';

test('sigla com ponto vira uma palavra nos dois lados', () => {
  assert.equal(normalizeTitle('G.O.R.A.'), 'gora');
  assert.equal(normalizeTitle('G.O.R.A.2004.1080p.HMAX.WEB-DL.DDP2.0.H.264-TURG').split(' ')[0], 'gora');
  assert.equal(normalizeTitle('GORA 2004 1080p').split(' ')[0], 'gora');
  assert.equal(normalizeTitle('M.A.S.H'), 'mash');
  assert.equal(normalizeTitle('U.S.Marshals.1998'), 'us marshals 1998');
});

test('ponto que não é sigla fica como estava', () => {
  assert.equal(normalizeTitle('Once.Upon.a.Time.in.Hollywood.2019'), 'once upon a time in hollywood 2019');
  assert.equal(normalizeTitle('Movie.DDP5.1.H.264'), 'movie ddp5 1 h 264');
  assert.equal(normalizeTitle('V.for.Vendetta'), 'v for vendetta');
  assert.equal(collapseAcronyms('Jornada nas Estrelas 2ª Temporada'), 'Jornada nas Estrelas 2ª Temporada');
});

test('global recebe a sigla sem pontos; BR, com pontos (o WordPress casa o literal)', () => {
  const gora = buildSearchQuery({ name: 'G.O.R.A.', year: 2004 });
  assert.equal(gora, 'G.O.R.A. 2004');
  assert.equal(shapeSearchQuery('yts', gora, false), 'GORA 2004');
  assert.equal(shapeSearchQuery('thepiratebay', 'A.I. Artificial Intelligence 2001', false), 'AI Artificial Intelligence 2001');
  // BLUDV, 2026-10-04: "S.W.A.T." → 127 itens, "SWAT" → 0.
  assert.equal(shapeSearchQuery('bludv-cardigann', 'S.W.A.T. S01E02', true), 'S.W.A.T.');
});
