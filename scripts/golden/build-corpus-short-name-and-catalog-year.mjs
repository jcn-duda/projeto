#!/usr/bin/env node
/**
 * Gera os corpora de `short-name-tail.ts` e `catalog-year.ts`
 * (`corpus-short-name-tail.json` e `corpus-catalog-year.json`). Gerador
 * descartável do corpus: o arquivo commitado é a fonte.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = (s) => s.split(' ').filter(Boolean);

function writeCorpus(file, version, note, cases, prefix) {
  const body = cases
    .map((c, i) => ({ id: `${prefix}-${String(i + 1).padStart(3, '0')}`, input: JSON.stringify(c.obj), note: c.note }))
    .map((c) => '    ' + JSON.stringify(c))
    .join(',\n');
  writeFileSync(
    path.join(REPO, 'scripts/golden', file),
    `{
  "version": "${version}",
  "note": "${note}",
  "cases": [
${body}
  ]
}
`,
  );
  console.log(`[corpus] ${file}: ${cases.length} casos`);
}

// shortNameTailContradicts: só `prefix` com um token no run; o resto é falso.
const shortCases = [
  { note: 'prefix de 1 token, sem ano depois: não corta', obj: { op: 'shortTail', tokens: T('monster hunter'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'prefix de 1 token, palavra estranha antes do ano: corta', obj: { op: 'shortTail', tokens: T('monster hunter 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'token estranho pertence ao universo: não corta', obj: { op: 'shortTail', tokens: T('monster hunter 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster', 'hunter'] } },
  { note: 'nome de 1 token ausente da lista: não corta', obj: { op: 'shortTail', tokens: T('hunter 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'run com 2 tokens: fora do escopo, não corta', obj: { op: 'shortTail', tokens: T('resident evil apocalypse 2004'), check: { kind: 'prefix', want: 'resident', run: ['resident', 'evil'] }, universe: ['resident', 'evil'] } },
  { note: 'kind skip: não corta', obj: { op: 'shortTail', tokens: T('monster hunter 2021'), check: { kind: 'skip' }, universe: ['monster'] } },
  { note: 'kind no-token: não corta', obj: { op: 'shortTail', tokens: T('monster hunter 2021'), check: { kind: 'no-token' }, universe: ['monster'] } },
  { note: 'sem ano no título: não corta', obj: { op: 'shortTail', tokens: T('monster hunter pets'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'run ausente nos tokens: não corta', obj: { op: 'shortTail', tokens: T('filme 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'ruído entre o nome e a palavra estranha é pulado', obj: { op: 'shortTail', tokens: T('monster 1080p hunter 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'dígitos puros antes do ano não contam como estranhos', obj: { op: 'shortTail', tokens: T('monster 42 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'palavra curta (2 letras) antes do ano não conta', obj: { op: 'shortTail', tokens: T('monster of 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'título em outro script antes do ano não conta', obj: { op: 'shortTail', tokens: ['monster', '光環', '2021'], check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'nome repetido no título: avança até a primeira ocorrência', obj: { op: 'shortTail', tokens: T('monster monster 2021'), check: { kind: 'prefix', want: 'monster', run: ['monster'] }, universe: ['monster'] } },
  { note: 'palavra do nome ausente com ano logo depois', obj: { op: 'shortTail', tokens: T('x 2021'), check: { kind: 'prefix', want: 'x', run: ['x'] }, universe: [] } },
];

// catalogYearOf / catalogAltYearOf: meta e tmdb como texto ou null.
const yearCases = [
  { note: 'mesmo ano nos dois', obj: { op: 'catalog', meta: '2010', tmdb: '2010' } },
  { note: 'divergência de até 2 anos: usa meta', obj: { op: 'catalog', meta: '2011', tmdb: '2010' } },
  { note: 'divergência acima de 2: usa tmdb', obj: { op: 'catalog', meta: '1967', tmdb: '1964' } },
  { note: 'meta vazia: usa tmdb', obj: { op: 'catalog', meta: '', tmdb: '2010' } },
  { note: 'tmdb ausente: usa meta', obj: { op: 'catalog', meta: '2010', tmdb: null } },
  { note: 'ambos ausentes: null', obj: { op: 'catalog', meta: null, tmdb: null } },
  { note: 'ano com texto ao redor', obj: { op: 'catalog', meta: '2010–2012', tmdb: '2010' } },
  { note: 'meta sem ano e tmdb com ano: usa tmdb', obj: { op: 'catalog', meta: 'sem ano', tmdb: '2001' } },
  { note: 'Monster: divergência acima de 2 nos dois sentidos', obj: { op: 'catalog', meta: '2018', tmdb: '2021' } },
  { note: 'alt: divergência acima de 2 devolve o outro', obj: { op: 'alt', meta: '2018', tmdb: '2021' } },
  { note: 'alt: divergência de até 2 não devolve nada', obj: { op: 'alt', meta: '2011', tmdb: '2010' } },
  { note: 'alt: sem tmdb não devolve nada', obj: { op: 'alt', meta: '2018', tmdb: null } },
  { note: 'alt: sem meta e tmdb com ano não devolve nada', obj: { op: 'alt', meta: null, tmdb: '2001' } },
  { note: 'alt: tmdb escolhido quando meta diverge muito', obj: { op: 'alt', meta: '1967', tmdb: '1964' } },
];

writeCorpus(
  'corpus-short-name-tail.json',
  'corpus-short-name-tail/1',
  'Caso de short-name-tail.ts (shortNameTailContradicts). Entrada JSON com tokens, check (skip, no-token ou prefix) e universe. Saída 1/0.',
  shortCases,
  'st',
);
writeCorpus(
  'corpus-catalog-year.json',
  'corpus-catalog-year/1',
  'Casos de catalog-year.ts: catalogYearOf (op catalog) e catalogAltYearOf (op alt). Saída: o ano em texto, null como o literal null, ou o ano alternativo.',
  yearCases,
  'cy',
);
