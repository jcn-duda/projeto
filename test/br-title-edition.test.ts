import { test } from 'node:test';
import assert from 'node:assert';

// Edição do MESMO filme no post BR ("V.Exten", "Extended") não é outra obra.
// Extraído de br-title.test.ts (teto de 400 linhas).
import { matchesBrTitle } from '../src/utils/format.js';
import { titleTokens } from '../src/utils/matching-vocabulary.js';

test('edição estendida abreviada (V.Exten / Extended) não conta como outra obra', () => {
  // Apocalypse Now (2026-09-24): o post "V.Exten" caía a 0,67 de precisão.
  const opts = { isSeries: false, allNames: ['Apocalypse Now'] };
  assert.equal(matchesBrTitle('Apocalypse Now V.Exten (1979) [BluRay 1080p][DUAL]', 'Apocalypse Now', 1979, opts), true);
  assert.equal(matchesBrTitle('Apocalypse Now Extended (1979) 1080p Dublado', 'Apocalypse Now', 1979, opts), true);
  // "V" sozinho segue sendo obra (série "V", "V de Vingança").
  assert.equal(titleTokens('V (2009) 1ª Temporada')[0], 'v');
  assert.equal(titleTokens('V de Vinganca 2005')[0], 'v');
  assert.equal(titleTokens('Apocalypse Now V.Exten (1979)').includes('v'), false);
  // Continuação continua fora: a edição não afrouxa o marcador de sequência.
  const sm = { isSeries: false, allNames: ['Scary Movie'] };
  assert.equal(matchesBrTitle('Scary Movie 2 Extended (2001) Dublado', 'Scary Movie', 2000, sm), false);
});
