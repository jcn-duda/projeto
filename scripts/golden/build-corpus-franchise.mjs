#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-franchise.json`: casos de `franchise-base.ts`
 * (guardas `franchiseBaseContradicts` e `franchiseExtensionContradicts`) e dos
 * helpers de `release-name-matching.ts` que elas usam (`nameCoverageTokens` e
 * `isMultiWorkCollection`). Gerador descartável do corpus; o arquivo commitado
 * é a fonte.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-franchise.json');

const cases = [];
const add = (note, obj) => cases.push({ note, input: JSON.stringify(obj) });

// franchiseBaseContradicts: continuação por subtítulo sem ano, com um ano que
// não bate com o catálogo.
add('base: subtítulo ausente e ano diferente do catálogo corta', { op: 'base', title: 'Resident Evil (2002) 1080p BrRip', own: null, name: 'Resident Evil: Apocalypse', year: '2004' });
add('base: ano igual ao catálogo não corta', { op: 'base', title: 'Resident Evil (2004) 1080p', own: null, name: 'Resident Evil: Apocalypse', year: '2004' });
add('base: subtítulo presente não corta', { op: 'base', title: 'Resident Evil Apocalypse (2002)', own: null, name: 'Resident Evil: Apocalypse', year: '2004' });
add('base: sem ano no título não corta', { op: 'base', title: 'Resident Evil 1080p', own: null, name: 'Resident Evil: Apocalypse', year: '2004' });
add('base: dois anos no título não corta', { op: 'base', title: 'Resident Evil 2002 2004', own: null, name: 'Resident Evil: Apocalypse', year: '2026' });
add('base: sem ano no catálogo não corta', { op: 'base', title: 'Resident Evil (2002)', own: null, name: 'Resident Evil: Apocalypse', year: null });
add('base: ano de nome (Blade Runner 2049) não é ano de release', { op: 'base', title: 'Blade Runner 2049 1080p', own: null, name: 'Blade Runner 2049', year: '2017' });
add('base: nome sem o ano do nome e ano de release diferente corta', { op: 'base', title: 'Blade Runner (1982) 1080p', own: null, name: 'Blade Runner 2049', year: '2017' });
add('base: pack de coleção fica fora', { op: 'base', title: 'Resident Evil Coleção 2002 2016', own: null, name: 'Resident Evil: Apocalypse', year: '2004' });
add('base: own pré-calculado é usado no lugar do título', { op: 'base', title: 'x', own: ['resident', 'evil', '2002'], name: 'Resident Evil: Apocalypse', year: '2004' });
add('base: own vazio é usado (lista vazia é verdade em JS)', { op: 'base', title: 'Resident Evil (2002)', own: [], name: 'Resident Evil: Apocalypse', year: '2004' });

// franchiseExtensionContradicts: nome nu com subtítulo sem ano logo depois.
add('extension: subtítulo sem ano logo depois do nome corta', { op: 'extension', title: 'Resident Evil Vendetta 1080p', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: título com ano abstém-se', { op: 'extension', title: 'Resident Evil Vendetta 2017', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: palavra de edição não corta', { op: 'extension', title: 'Resident Evil Remastered 1080p', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: palavra de ruído não corta', { op: 'extension', title: 'Resident Evil 1080p', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: palavra de outro nome da obra não corta', { op: 'extension', title: 'Resident Evil Biohazard 1080p', own: null, name: 'Resident Evil', allNames: ['Resident Evil', 'Biohazard'], year: '2026' });
add('extension: número depois do nome não é subtítulo', { op: 'extension', title: 'Resident Evil 2 1080p', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: palavra com menos de 3 letras não corta', { op: 'extension', title: 'Resident Evil Ab', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: palavra com acento não corta (regex só a-z)', { op: 'extension', title: 'Resident Evil Vendettá', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: nome ausente no título não corta', { op: 'extension', title: 'Monster Hunter Vendetta', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: sem ano no catálogo não corta', { op: 'extension', title: 'Resident Evil Vendetta', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: null });
add('extension: pack de coleção fica fora', { op: 'extension', title: 'Resident Evil Vendetta Coleção Todos', own: null, name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });
add('extension: own pré-calculado é usado', { op: 'extension', title: 'x', own: ['resident', 'evil', 'vendetta'], name: 'Resident Evil', allNames: ['Resident Evil'], year: '2026' });

// nameCoverageTokens: tokens do nome, sem artigo e sem curtos quando há 2+ longos.
add('coverage: nome comum', { op: 'coverage', name: 'Resident Evil' });
add('coverage: artigo e palavra curta caem quando há dois longos', { op: 'coverage', name: 'The Office of the Dead' });
add('coverage: com um só token longo mantém todos', { op: 'coverage', name: 'Up in Air' });
add('coverage: repetido deduplica', { op: 'coverage', name: 'Monster Monster Hunter' });
add('coverage: acento e pontuação', { op: 'coverage', name: 'Poção do Avô: Parte 2' });
add('coverage: nome vazio', { op: 'coverage', name: '' });
add('coverage: sigla pontuada', { op: 'coverage', name: 'S.W.A.T. Força Especial' });

// isMultiWorkCollection: palavra forte, ou fraca com faixa de anos.
add('multiWork: trilogia é pack', { op: 'multiWork', title: 'Trilogia Matrix 1080p' });
add('multiWork: filme comum não é pack', { op: 'multiWork', title: 'Monster Hunter 2021 1080p' });
add('multiWork: palavra fraca sem faixa de anos não é pack', { op: 'multiWork', title: 'Todos os Filmes 1080p' });
add('multiWork: palavra fraca com faixa de anos é pack', { op: 'multiWork', title: 'Todos os filmes 1979-2016' });
add('multiWork: faixa com espaço é pack com palavra fraca', { op: 'multiWork', title: 'Filmes 1979 2016' });
add('multiWork: faixa sem palavra fraca não é pack', { op: 'multiWork', title: 'Filme 1979-2016' });
add('multiWork: filmografia é pack forte', { op: 'multiWork', title: 'Filmografia Spielberg' });
add('multiWork: saga é fora', { op: 'multiWork', title: 'The Twilight Saga Breaking Dawn' });
add('multiWork: colecao com acento', { op: 'multiWork', title: 'Coleção Guerra nas Estrelas' });

// Títulos reais dos corpora de normalização e de vocabulário, para os helpers.
const herded = [
  ...JSON.parse(readFileSync0('scripts/golden/corpus-title-normalization.json')).cases,
  ...JSON.parse(readFileSync0('scripts/golden/corpus-matching-vocabulary.json')).cases,
].map((c) => c.input);
for (const title of herded) {
  add('multiWork: título herdado do corpus', { op: 'multiWork', title });
}

function readFileSync0(rel) {
  return readFileSync(path.join(REPO, rel), 'utf8');
}

const body = cases
  .map((c, i) => ({ id: `fr-${String(i + 1).padStart(3, '0')}`, input: c.input, note: c.note }))
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-franchise/1",
  "note": "franchise-base.ts (guardas base e extension) e os helpers nameCoverageTokens e isMultiWorkCollection de release-name-matching.ts. Entrada JSON com op. Saída: 1/0, lista de tokens ou 1/0. IDs estáveis.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${cases.length} casos`);
