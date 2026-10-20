// Equivalência contextual `%` -> `percent` na identidade de "3%".
//
// Medido nas APIs reais (napi + pipeline): `names:["3%"]` rejeitava
// `3.Percent.S01E01`, `3 Percent S01` e o pack
// `3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)`, enquanto
// `names:["3%","3 Percent"]` aceitava. A grafia só vale quando o NOME carrega
// o símbolo; "24 Percent", "3 Por Cento" e "3 Body Problem" seguem fora.
//
// A decisão pura (`matchesShortNameIdentity`) é a que sobrou no TS; a ordem
// relevância × episódio do pipeline agora é do núcleo Rust (o TS de
// `stream-builder-*` saiu no F4.4).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  matchesShortNameIdentity,
  shortNameIdentity,
} from '../src/utils/format.js';

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
