#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-episode-parse.json`: títulos para
 * `parseTitleSeasonEpisode` e `seasonCoverageExcludes` (episode-matching.ts).
 * Gerador descartável do corpus; o arquivo commitado é a fonte.
 *
 * Cada padrão do parser tem pelo menos um caso escrito à mão, e o resto vem dos
 * corpora de normalização e de vocabulário, para cobrir o alfabeto.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-episode-parse.json');

const hand = [
  '', 'Game of Thrones S01E04 1080p', 'Show S01E01-E10 1080p', 'Show S01 E01 E02 720p',
  'Show S01E01E02', 'Show S03E01-02 WEB', 'Show S01E05-720p', 'Show S02E01 EP 07',
  'Show S01 EP (01-07) 1TamilMV', 'Show s01-ep 12-14', 'Novela T01 E004', 'Novela T01E001-E010',
  'Novela T01E001 E002', 'Novela T01E001, E002 E010', 'Novela T01E001 and E005',
  'Jesus [Capítulo 086 ao 123]', 'Novela [EP 050-056]', 'It Capítulo 2 2019',
  'Anime 1x04 720p', 'Filme 1280x720 2010', 'Game of Thrones Primeira Temporada Dual Audio',
  'Show Décima Primeira Temporada', 'Show Primeira Segunda Temporada', 'Show 1ª até 8ª Temporada',
  'Show 1a ate 8a temporadas', 'Show 1 a 5 temporadas', 'Show 1ª 2ª 3ª 4ª 5ª 6ª e 7ª Temporadas',
  'Show 1ª 2ª Temporada', 'Show S01-S04 1080p', 'Show S01 - S04', 'Show S02-13 anime',
  'Show S01-02E01', 'Show S1-3E1', 'Show S01 S04', 'Show S04-S01', 'Show s01 s03 pack',
  'Show season 2', 'Show Temporada 1', 'Show 1 Temporada', 'Show 2a Temporada Completa',
  'Show Todas as Temporadas', 'Show Série Completa', 'Show Temporadas Completas',
  'Show Temporada (2011) 720p', 'Show Temporada 2011', 'Show Episódio 4 Temporada 2',
  'Show 1ª Temporada (2022) WEB-DL E02', 'Lilo e Stitch 2', 'Show S01 e02 e04',
  'Show S01 E01 a E10', 'DDP5 1 Atmos Show', 'BS8 Show S01', 'Show S01 Episódio II',
  'Star Wars Episódio II', 'Show Episódio 12 Temporada 3 E12', 'Show 2 temporadas S01E01',
  'One Piece S1000E1001', 'Show S01E0010', 'Show s1e1 e2 e3', 'Show s01e1234',
  'Show S1 EP 1-35 1080p', 'Show EP 07', 'Show E07 1080p', 'Show E01 a E03', 'Show E01 E03',
  'Show 3 Temporadas 1080p', 'Show 2ª Temporada 1080p', 'Show S01E01 Temporada 4 S02',
  'Show SX1E01', 'Show s01 ep 1 2 3', 'Show t01 e1 e2', 'Show 4 x 10', 'Show 5x123',
];

const base = [
  ...JSON.parse(readFileSync(path.join(REPO, 'scripts/golden/corpus-title-normalization.json'), 'utf8')).cases,
  ...JSON.parse(readFileSync(path.join(REPO, 'scripts/golden/corpus-matching-vocabulary.json'), 'utf8')).cases,
].map((c) => c.input);

const all = [...hand, ...base];
const seasons = [null, 1, 2, 4, 9, 12];

const cases = [];
for (const title of all) {
  cases.push({ id: '', op: 'parse', title });
}
// Cobertura: para os títulos escritos à mão, testa a regra de temporada.
for (const title of hand) {
  for (const season of seasons) {
    cases.push({ id: '', op: 'excludes', title, season });
  }
}

const body = cases
  .map((c, i) => {
    const { op, title, season } = c;
    const input = op === 'excludes' ? { op, title, season } : { op, title };
    return {
      id: `ep-${String(i + 1).padStart(4, '0')}`,
      input: JSON.stringify(input),
      note: op === 'excludes' ? 'seasonCoverageExcludes sobre o parse do título' : 'parseTitleSeasonEpisode',
    };
  })
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-episode-parse/1",
  "note": "episode-matching.ts: parseTitleSeasonEpisode (op parse) e seasonCoverageExcludes (op excludes). Saída do parse: 's=… e=… c=0|1 p=0|1', listas na ordem de inserção. Entrada JSON. IDs estáveis.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${cases.length} casos`);
