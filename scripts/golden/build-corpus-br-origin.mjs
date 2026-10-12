#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-br-origin.json`: títulos para os predicados de
 * origem BR (`hasPtSigns` e `brOriginMark` de `src/utils/br-origin.ts`).
 * Gerador descartável do corpus; o arquivo commitado é a fonte.
 *
 * Além dos casos escritos à mão (sites BR, acentos em caixa alta, `bthd` com
 * fronteira, e os caracteres em que o `/i` do JS e o Unicode do Rust divergem:
 * ſ, U+212A KELVIN SIGN e ı), entram os títulos dos corpora de normalização e
 * de vocabulário, que cobrem o restante do alfabeto.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-br-origin.json');

const hand = [
  '', 'Filme sem marca', 'The Dark Knight 2008 1080p',
  'X-Men - O Filme 1080p - The Pirate Filmes', 'Troia - The Pirate Filmes',
  'Zumbilândia BDRip derew 720p', 'zumbilandia (www.thepiratefilmes.com)',
  'www.UIndex.org - Movie 2020 1080p', 'www.nerdfilmes.org - Filme 2010',
  'HDBTHD.com Movie 2020', 'Movie bthd 2020', 'bthd', 'xbthd x', 'BTHD',
  'hdtorrents.net Movie', 'hdtorrent Movie', 'torrentbr Movie', 'Lapumia 720p',
  'OPERAÇÃO INVASÃO 2020', 'Operação Invasão 2020', 'OPERAÇÕES 2020',
  'Cães de Guerra 2010', 'Cidade de Deus 2002 1080p', 'Coração Valente 1995',
  'Dublado 1080p', 'DUBLADO 1080p', 'dublagem pt', 'Temporada 2 Completa',
  'Episódio 3', 'Coleção Guerra nas Estrelas', 'Filme ſ de noite',
  'Filme K de noite', 'Dublıdo cidade', 'Ç cidade', 'Zumbilandia BDRip',
  'Movie de noite', 'Movie de de', 'Movie das dos', 'Movie 2020 entre sobre atrás',
  'filmes', 'O Filme 2019', 'Filmes Antigos', 'Pirate Filmes Movie',
  'Ação de Ouro', 'Fúria Selvagem 2014', 'Vingança 2010', 'Maldição 2015',
  'ASSASSINO 1990', 'estreia 2024', 'nacional 1080p',
  // Isolam o caractere: só o ſ, o K de Kelvin ou o ı decidem se casa.
  'Movie filmes 2010', 'Movie filmeſ 2010', 'Movie FILMEſ 2010',
  'nerdfilmes 2010', 'nerdfilmeſ 2010', 'Movie capitulo 2', 'Movie capıtulo 2',
  'Movie capítulo 2', 'Movie KK 2010', 'Movie hdtorrent 2010',
  'Movie hdtorrent 2010', 'Movie İLMES 2010', 'Movie ılmes 2010',
];

const base = [
  ...JSON.parse(readFileSync(path.join(REPO, 'scripts/golden/corpus-title-normalization.json'), 'utf8')).cases,
  ...JSON.parse(readFileSync(path.join(REPO, 'scripts/golden/corpus-matching-vocabulary.json'), 'utf8')).cases,
].map((c) => c.input);

const all = [...hand, ...base];
const body = all
  .map((input, i) => ({
    id: `bo-${String(i + 1).padStart(3, '0')}`,
    input,
    note: i < hand.length ? 'caso escrito à mão: origem BR' : 'título herdado dos corpora de normalização e de vocabulário',
  }))
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-br-origin/1",
  "note": "Títulos para hasPtSigns e brOriginMark (src/utils/br-origin.ts). Saída: 'pt=<0|1> origin=<0|1>'. Inclui ſ, U+212A e ı, onde o /i do JS difere do Unicode do Rust. IDs estáveis.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${all.length} casos`);
