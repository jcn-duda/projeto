// Equivalência contextual `%` -> `percent` na identidade de "3%".
//
// Medido nas APIs reais (napi + pipeline): `names:["3%"]` rejeitava
// `3.Percent.S01E01`, `3 Percent S01` e o pack
// `3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)`, enquanto
// `names:["3%","3 Percent"]` aceitava. A grafia só vale quando o NOME carrega
// o símbolo; "24 Percent", "3 Por Cento" e "3 Body Problem" seguem fora.
//
// A ordem é a do `stream-builder-pipeline`: relevância de título SEM
// season/episode e, depois, filtro de episódio COM season/episode.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  filterRelevantRaw,
  matchesShortNameIdentity,
  shortNameIdentity,
} from '../src/utils/format.js';
import { normalizeTitle } from '../src/utils/title-normalization.js';
import { filterSeriesEpisodeRaw } from '../src/providers/stream-builder-episode-filter.js';

const LEGITIMOS = [
  '3.Percent.S01E01.1080p.WEB-DL',
  '3 Percent S01',
  '3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)',
  '3 % S01E01 1080p',
];

const HOMONIMOS = [
  '3 Body Problem S01E01 1080p',
  '3 Percent Body Problem S01E01 1080p',
  '3 Percentual S01E01 1080p',
  '3 Por Cento S01E01 1080p',
  '100 Percent S01E01 1080p',
  '20 Percent S01E01 1080p',
  '100PercentWolf S01E01 1080p',
  '3PercentBodyProblem S01E01 1080p',
];

/** Universo como o pipeline monta: `normalizeTitle(name).split(' ')`. */
function seriesUniverse(names: string[]): string[] {
  return names.flatMap((name) => normalizeTitle(name).split(' ').filter(Boolean));
}

function pipelineKeeps(names: string[], title: string, season = 1, episode = 1): boolean {
  const titleCtx = { names, year: 2016, isSeries: true };
  const relevant = filterRelevantRaw([{ title }], titleCtx);
  if (relevant.length !== 1) return false;
  const { kept } = filterSeriesEpisodeRaw(relevant, season, episode, seriesUniverse(names), {
    names,
  });
  return kept.length === 1;
}

test('identidade real aceita percent só quando o nome tem o símbolo', () => {
  const check = shortNameIdentity('3%');
  assert.deepEqual(check, {
    kind: 'prefix',
    want: '3',
    run: ['3'],
    percentSpelling: true,
  });

  for (const title of LEGITIMOS) {
    assert.equal(matchesShortNameIdentity(title, check), true, `legítimo: ${title}`);
  }
  for (const title of HOMONIMOS) {
    assert.equal(matchesShortNameIdentity(title, check), false, `homônimo: ${title}`);
  }
});

test('nome sem símbolo preserva a forma e não ganha equivalência', () => {
  const vinteQuatro = shortNameIdentity('24');
  assert.deepEqual(vinteQuatro, { kind: 'prefix', want: '24', run: ['24'] });
  assert.equal('percentSpelling' in vinteQuatro, false);
  assert.equal(matchesShortNameIdentity('24 Percent S01E01', vinteQuatro), false);
  assert.equal(matchesShortNameIdentity('24 S01E01', vinteQuatro), true);
});

test('dn alternativo carrega a grafia sem afrouxar o título', () => {
  const check = shortNameIdentity('3%');
  const usaDn = matchesShortNameIdentity(
    '3 Body Problem S01E01',
    check,
    null,
    '3.Percent.S01E01.1080p.WEB-DL',
  );
  assert.equal(usaDn, true);
  assert.equal(
    matchesShortNameIdentity('3 Body Problem S01E01', check, null, '3 Body Problem S01E01'),
    false,
  );
  // "por cento" não ganhou equivalência.
  assert.equal(
    matchesShortNameIdentity('3 Body Problem S01E01', check, null, '3 Por Cento S01E01'),
    false,
  );
});

test('pipeline real: relevância sem S/E e episódio com S/E', () => {
  const nomes = ['3%'];
  for (const title of LEGITIMOS) {
    assert.equal(pipelineKeeps(nomes, title), true, `pipeline legítimo: ${title}`);
  }
  for (const title of HOMONIMOS) {
    assert.equal(pipelineKeeps(nomes, title), false, `pipeline homônimo: ${title}`);
  }

  // Obra certa, episódio errado: a relevância (sem S/E) mantém e só a etapa
  // de episódio corta — prova a ordem real das duas decisões.
  const titleCtx = { names: nomes, year: 2016, isSeries: true };
  const relevante = filterRelevantRaw([{ title: '3.Percent.S01E02.1080p' }], titleCtx);
  assert.equal(relevante.length, 1);
  const { kept, dropped } = filterSeriesEpisodeRaw(
    relevante,
    1,
    1,
    seriesUniverse(nomes),
    { names: nomes },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test('alias textual não perde a obra correta', () => {
  for (const nomes of [['3%'], ['3%', '3 Percent']]) {
    for (const title of [
      '3.Percent.S01E01.1080p.WEB-DL',
      '3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)',
    ]) {
      assert.equal(pipelineKeeps(nomes, title), true, `${nomes.join('/')}: ${title}`);
    }
    assert.equal(pipelineKeeps(nomes, '3 Body Problem S01E01 1080p'), false, nomes.join('/'));
  }
});

test('multiplicidade, ordem e nomes antigos seguem intactos', () => {
  assert.equal(matchesShortNameIdentity('9-1-1 S01E01 1080p', shortNameIdentity('9-1-1')), true);
  assert.equal(matchesShortNameIdentity('9 1 S01E01 1080p', shortNameIdentity('9-1-1')), false);
  assert.equal(
    matchesShortNameIdentity('11.22.63 S01E01 1080p', shortNameIdentity('11.22.63')),
    true,
  );
  assert.equal(
    matchesShortNameIdentity('11 22 64 S01E01 1080p', shortNameIdentity('11.22.63')),
    false,
  );
  for (const name of ['V', 'It', 'Up', '光環']) {
    assert.equal(shortNameIdentity(name).kind, 'no-token', name);
  }
});
