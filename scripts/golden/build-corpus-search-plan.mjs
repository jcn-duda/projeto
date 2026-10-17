#!/usr/bin/env node
/**
 * Construtor do corpus do golden `search-plan` (plano da coleta do Jackett).
 *
 * Cada `input` é uma STRING JSON: `{op, ...}`. As ops cobrem TODAS as funções
 * exportadas por `src/providers/search-plan.ts`:
 *
 * - `plan` → `planJackettQueries` (tarefas agrupada/isoladas/sweep; variant,
 *   fallback, franchise, original, multiWork; bordas de string vazia);
 * - `ptSweepIndexers`, `liveIndexers` → listas de indexers;
 * - `ptSweepQuery` → raiz da varredura;
 * - `ptSweepQueryFor`, `dubbedSweepQueryFor` → gate "pt difere do original" e
 *   variante "<raiz> dublado" (com maiúsculas acentuadas, Ç/Ã/Á/İ).
 *
 * Uso: node scripts/golden/build-corpus-search-plan.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts', 'golden', 'corpus-search-plan.json');

const cases = [];
const add = (id, req) => {
  cases.push({ id, input: JSON.stringify(req) });
};

// --- planJackettQueries: agrupado + isolados BR ----------------------------
add('plan-br-isolado-fallback', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: ['thepiratebay', 'bludv-cardigann', 'nerdfilmes'],
  ptBrIndexers: ['bludv-cardigann', 'nerdfilmes'],
});
add('plan-br-sem-ptquery', {
  op: 'plan',
  query: 'Prometheus 2012',
  ptQuery: null,
  selectedIndexers: ['thepiratebay', 'bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-ptquery-vazia-cai-na-query', {
  op: 'plan',
  query: 'Prometheus 2012',
  ptQuery: '',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-ptquery-igual-a-query-sem-fallback', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Joker 2019',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-isolado-global-lento', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: ['thepiratebay', 'redetorrent', 'bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
  isolateIndexers: ['redetorrent', 'bludv-cardigann'],
});
add('plan-sweep-diferente', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: ['thepiratebay', '1337x', 'bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
  sweepQuery: 'Coringa',
});
add('plan-sweep-igual-nao-duplica', {
  op: 'plan',
  query: 'Jornada nas Estrelas',
  ptQuery: 'Jornada nas Estrelas',
  selectedIndexers: ['thepiratebay', '1337x'],
  ptBrIndexers: [],
  sweepQuery: 'Jornada nas Estrelas',
});
add('plan-sweep-vazia-nao-cria-task', {
  op: 'plan',
  query: 'Star Trek',
  selectedIndexers: ['thepiratebay'],
  ptQuery: null,
  sweepQuery: '',
});
add('plan-grouped-vazio-sem-sweep', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: ['bludv-cardigann', 'redetorrent'],
  ptBrIndexers: ['bludv-cardigann'],
  isolateIndexers: ['redetorrent', 'bludv-cardigann'],
  sweepQuery: 'Coringa',
});
add('plan-original-query-global-e-br', {
  op: 'plan',
  query: 'My Name Is Farah S01E01',
  ptQuery: 'Meu Nome é Farah S01E01',
  selectedIndexers: ['therarbg', 'bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
  originalQuery: 'Adım Farah',
});
add('plan-original-vazia-omitida', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: ['therarbg', 'bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
  originalQuery: '',
});
add('plan-original-nao-vai-na-sweep', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: ['therarbg'],
  ptBrIndexers: [],
  sweepQuery: 'Coringa',
  originalQuery: 'Joker',
});
add('plan-multiwork-so-no-br', {
  op: 'plan',
  query: 'Star Trek 2009',
  ptQuery: 'Jornada nas Estrelas 2009',
  selectedIndexers: ['therarbg', 'bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
  multiWorkQuery: 'Jornada nas Estrelas Coleção',
});
add('plan-multiwork-vazia-omitida', {
  op: 'plan',
  query: 'Star Trek 2009',
  ptQuery: 'Jornada nas Estrelas 2009',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
  multiWorkQuery: '',
});
add('plan-variant-romano', {
  op: 'plan',
  query: 'Star Trek II: The Wrath of Khan 1982',
  ptQuery: 'Jornada nas Estrelas II: A Ira de Khan 1982',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-variant-sem-romano', {
  op: 'plan',
  query: 'Apollo 13 1995',
  ptQuery: null,
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-franchise-parte-ii-com-ano', {
  op: 'plan',
  query: 'The Hangover Part II 2011',
  ptQuery: 'Se Beber, Não Case! Parte II 2011',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-franchise-sem-marcador', {
  op: 'plan',
  query: 'Joker: Folie à Deux 2024',
  ptQuery: 'Coringa: Delírio a Dois 2024',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-franchise-numeral-sozinho', {
  op: 'plan',
  query: 'Back to the Future Part III 1990',
  ptQuery: 'De Volta para o Futuro Parte III 1990',
  selectedIndexers: ['bludv-cardigann'],
  ptBrIndexers: ['bludv-cardigann'],
});
add('plan-selecao-vazia', {
  op: 'plan',
  query: 'Joker 2019',
  ptQuery: 'Coringa 2019',
  selectedIndexers: [],
  ptBrIndexers: ['bludv-cardigann'],
  sweepQuery: 'Coringa',
});

// --- ptSweepIndexers -------------------------------------------------------
add('ptSweep-misto', {
  op: 'ptSweepIndexers',
  selectedIndexers: ['thepiratebay', '1337x', 'bludv-cardigann', 'nerdfilmes'],
  ptBrIndexers: ['bludv-cardigann', 'nerdfilmes', 'comandotorrents'],
});
add('ptSweep-tudo-br', {
  op: 'ptSweepIndexers',
  selectedIndexers: ['bludv-cardigann', 'nerdfilmes'],
  ptBrIndexers: ['bludv-cardigann', 'nerdfilmes'],
});
add('ptSweep-index-only-fora', {
  op: 'ptSweepIndexers',
  selectedIndexers: ['thepiratebay', 'redetorrent', 'hdrtorrent'],
  ptBrIndexers: [],
  indexOnlyIndexers: ['redetorrent', 'hdrtorrent'],
});
add('ptSweep-selecao-vazia', {
  op: 'ptSweepIndexers',
  selectedIndexers: [],
  ptBrIndexers: ['bludv-cardigann'],
  indexOnlyIndexers: ['redetorrent'],
});

// --- liveIndexers ----------------------------------------------------------
add('live-tira-index-only', {
  op: 'liveIndexers',
  selectedIndexers: ['thepiratebay', 'redetorrent', 'apachetorrent', 'hdrtorrent', 'bludv-cardigann'],
  indexOnlyIndexers: ['redetorrent', 'apachetorrent', 'hdrtorrent'],
});
add('live-exempt-1337x-fica', {
  op: 'liveIndexers',
  selectedIndexers: ['thepiratebay', '1337x'],
  indexOnlyIndexers: ['1337x'],
  exemptIndexers: ['1337x'],
});
add('live-sem-lista-index-only', {
  op: 'liveIndexers',
  selectedIndexers: ['thepiratebay', 'redetorrent'],
});
add('live-esvazia-tudo', {
  op: 'liveIndexers',
  selectedIndexers: ['redetorrent', 'hdrtorrent'],
  indexOnlyIndexers: ['redetorrent', 'hdrtorrent'],
});

// --- ptSweepQuery ----------------------------------------------------------
add('ptSweepQuery-subtitulo-2-palavras', { op: 'ptSweepQuery', titlePt: 'Jornada nas Estrelas: O Filme' });
add('ptSweepQuery-en-dash', { op: 'ptSweepQuery', titlePt: 'Alice no País das Maravilhas – O Filme' });
add('ptSweepQuery-em-dash', { op: 'ptSweepQuery', titlePt: 'O Senhor dos Anéis — A Sociedade do Anel' });
add('ptSweepQuery-prefixo-1-palavra', { op: 'ptSweepQuery', titlePt: 'Missão: Impossível' });
add('ptSweepQuery-null', { op: 'ptSweepQuery', titlePt: null });
add('ptSweepQuery-so-espacos', { op: 'ptSweepQuery', titlePt: '   ' });
add('ptSweepQuery-marcador-sequencia', { op: 'ptSweepQuery', titlePt: 'Jornada nas Estrelas II: A Ira de Khan' });
add('ptSweepQuery-numero-nome-da-obra', { op: 'ptSweepQuery', titlePt: 'Blade Runner 2049' });

// --- ptSweepQueryFor -------------------------------------------------------
add('ptSweepQueryFor-pt-diferente', {
  op: 'ptSweepQueryFor',
  titles: { pt: 'Jornada nas Estrelas: O Filme', original: 'Star Trek: The Motion Picture' },
});
add('ptSweepQueryFor-pt-igual-original', {
  op: 'ptSweepQueryFor',
  titles: { pt: 'Joker', original: 'Joker' },
});
add('ptSweepQueryFor-pt-null', { op: 'ptSweepQueryFor', titles: { pt: null, original: 'Joker' } });
add('ptSweepQueryFor-titles-null', { op: 'ptSweepQueryFor', titles: null });
add('ptSweepQueryFor-pt-so-espacos', { op: 'ptSweepQueryFor', titles: { pt: '  ', original: 'X' } });
add('ptSweepQueryFor-serie-raiz-pt', {
  op: 'ptSweepQueryFor',
  titles: { pt: 'Jornada nas Estrelas: A Nova Geração', original: 'Star Trek: The Next Generation' },
});

// --- dubbedSweepQueryFor ---------------------------------------------------
add('dubbed-pt-igual-sem-acento', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'Apocalypse Now', en: 'Apocalypse Now', original: 'Apocalypse Now' },
});
add('dubbed-acento-maiusculas', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'CORAÇÃO', en: 'coracao', original: null },
});
add('dubbed-cedilha-til', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'Ação e Reação', en: 'Acao e Reacao', original: 'Acao e Reacao' },
});
add('dubbed-i-pontuado-turco', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'İSTANBUL ÇIĞLIK', en: 'istanbul ciglik', original: null },
});
add('dubbed-usa-original-sem-en', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'Ação', original: 'Acao' },
});
add('dubbed-diferente-nao-varre', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'Coração', en: 'Heart', original: 'Heart' },
});
add('dubbed-pt-null', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: null, en: 'Joker', original: 'Joker' },
});
add('dubbed-sem-original', {
  op: 'dubbedSweepQueryFor',
  titles: { pt: 'Joker', en: null, original: null },
});

const doc = {
  _doc:
    'Corpus do golden `search-plan` (F-1). Cada input é uma STRING JSON com `op` '
    + '(`plan`, `ptSweepIndexers`, `liveIndexers`, `ptSweepQuery`, '
    + '`ptSweepQueryFor`, `dubbedSweepQueryFor`). O oráculo é o TS do branch `esm` '
    + '(`dist/src/providers/search-plan.js`), nunca uma reimplementação.',
  cases,
};
fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`[corpus] ${path.relative(REPO, OUT)}: ${cases.length} casos`);
