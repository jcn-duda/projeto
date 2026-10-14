#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-matching-tokens-decisions.json`: casos JSON das
 * decisões de matching-tokens (precisão, ano, sequência nomeada, live action,
 * adaptação e primeiro token). Gerador descartável de corpus, não do golden:
 * o corpus commitado é a fonte; rodar de novo reescreve o mesmo conteúdo.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-matching-tokens-decisions.json');

const T = (s) => s.split(' ').filter(Boolean);

const cases = [];
const add = (note, obj) => cases.push({ note, input: JSON.stringify(obj) });

// precisão: título limpo, com ruído, pack e cauda
add('precisão: título igual à busca', { op: 'precision', tokens: T('deadpool 2'), wanted: T('deadpool 2') });
add('precisão: token estranho na cabeça', { op: 'precision', tokens: T('deadpool 2 zumbi'), wanted: T('deadpool 2') });
add('precisão: ruído de release não conta', { op: 'precision', tokens: T('deadpool 2 1080p webrip'), wanted: T('deadpool 2') });
add('precisão: pack na cabeça é pulado', { op: 'precision', tokens: T('colecao guerra nas estrelas'), wanted: T('guerra estrelas') });
add('precisão: só ruído dá 1', { op: 'precision', tokens: T('1080p dublado legendado'), wanted: T('x') });
add('precisão: cauda do encoder não derruba', { op: 'precision', tokens: T('zumbilandia 2009 derew'), wanted: T('zumbilandia') });
add('precisão: sem cutTail mede a lista inteira', { op: 'precision', tokens: T('zumbilandia 2009 derew'), wanted: T('zumbilandia'), cutTail: false });
add('precisão: cabeça vazia usa lista inteira', { op: 'precision', tokens: T('2009 zumbi'), wanted: T('zumbi') });
add('precisão: lista vazia de busca', { op: 'precision', tokens: T('a filme'), wanted: [] });
add('precisão: token 2u não é número de precisão', { op: 'precision', tokens: T('happy death day 2u'), wanted: T('happy death day') });

// ano: filme e série, um e vários anos
add('ano: filme único dentro de ±2', { op: 'year', tokens: T('filme 2011'), year: '2010', series: false });
add('ano: filme único fora de ±2', { op: 'year', tokens: T('filme 2014'), year: '2010', series: false });
add('ano: sem ano no catálogo não corta', { op: 'year', tokens: T('filme 2014'), year: null, series: false });
add('ano: sem ano no título não corta', { op: 'year', tokens: T('filme 1080p'), year: '2010', series: false });
add('ano: intervalo cobre o catálogo', { op: 'year', tokens: T('colecao 2002 2016'), year: 2004, series: false });
add('ano: intervalo não cobre e nenhum perto', { op: 'year', tokens: T('colecao 2002 2016'), year: 2026, series: false });
add('ano: intervalo com um ano perto passa', { op: 'year', tokens: T('colecao 2002 2016'), year: '2016', series: false });
add('ano: série basta um ano recente', { op: 'year', tokens: T('serie 2019 2024'), year: '2024', series: true });
add('ano: série com todos os anos antigos corta', { op: 'year', tokens: T('serie 2010 2012'), year: '2024', series: true });
add('ano: série no limite de −2 passa', { op: 'year', tokens: T('serie 2022'), year: '2024', series: true });
add('ano: ano numérico no catálogo', { op: 'year', tokens: T('filme 2010'), year: 2010, series: false });

// sequência nomeada: ano exato contra universo de nomes
add('sequel: nome da busca + ano diferente corta', { op: 'sequel', tokens: T('resident evil apocalypse 2004'), universe: T('resident evil'), catalogYear: '2002' });
add('sequel: mesmo ano não corta', { op: 'sequel', tokens: T('resident evil apocalypse 2002'), universe: T('resident evil'), catalogYear: '2002' });
add('sequel: sem ano no título não corta', { op: 'sequel', tokens: T('resident evil apocalypse'), universe: T('resident evil'), catalogYear: '2002' });
add('sequel: só tokens do universo não corta', { op: 'sequel', tokens: T('resident evil 2004'), universe: T('resident evil'), catalogYear: '2002' });
add('sequel: sem ano no catálogo não corta', { op: 'sequel', tokens: T('resident evil apocalypse 2004'), universe: T('resident evil'), catalogYear: null });
add('sequel: ruído antes do ano não é estranho', { op: 'sequel', tokens: T('resident evil 1080p 2004'), universe: T('resident evil'), catalogYear: '2002' });

// live action: contaminação de adaptação
add('live: anime com faixa que cobre a estreia passa', { op: 'liveAction', text: 'One Piece 1999-2023 live action', premiereYear: '1999' });
add('live: live action longe da estreia corta', { op: 'liveAction', text: 'One Piece Live Action 2023 2026', premiereYear: '1999' });
add('live: live action perto da estreia passa', { op: 'liveAction', text: 'One Piece Live Action 2000', premiereYear: '1999' });
add('live: sem marcador não corta', { op: 'liveAction', text: 'One Piece 2026', premiereYear: '1999' });
add('live: sem estreia não corta', { op: 'liveAction', text: 'One Piece Live Action 2026', premiereYear: null });
add('live: resolução não conta como ano', { op: 'liveAction', text: 'Live Action 1280x720 2005', premiereYear: '1999' });
add('live: separador NBSP entre live e action', { op: 'liveAction', text: 'Live Action 2026', premiereYear: '1999' });
add('live: separador BOM entre live e action', { op: 'liveAction', text: 'Live﻿Action 2026', premiereYear: '1999' });
add('live: ano colado em dígitos não é ano', { op: 'liveAction', text: 'Live Action 120262', premiereYear: '1999' });
add('live: ponto como separador', { op: 'liveAction', text: 'live.action 2026', premiereYear: '1999' });
add('live: LIVE-ACTION maiúsculo', { op: 'liveAction', text: 'LIVE-ACTION 2026', premiereYear: '1999' });
add('live: palavra colada não casa', { op: 'liveAction', text: 'liveaction2026 2026', premiereYear: '1999' });

// adaptação: exige série (season não nulo) e as provas de live action
add('adaptação: série com live action longe corta', { op: 'adaptation', request: { season: 1 }, text: 'One Piece Live Action 2026', year: '1999' });
add('adaptação: filme (season null) nunca corta', { op: 'adaptation', request: { season: null }, text: 'One Piece Live Action 2026', year: '1999' });
add('adaptação: request sem season nunca corta', { op: 'adaptation', request: {}, text: 'One Piece Live Action 2026', year: '1999' });
add('adaptação: série sem marcador passa', { op: 'adaptation', request: { season: 2 }, text: 'One Piece 2026', year: '1999' });

// primeiro token que nomeia (artigo e pack pulados, curto pulado)
add('first: artigo e pack pulados', { op: 'first', tokens: T('the colecao hulk') });
add('first: palavra de até 2 letras pulada', { op: 'first', tokens: T('of ab rocky') });
add('first: nada significativo cai no primeiro', { op: 'first', tokens: T('the of') });
add('first: lista vazia dá -', { op: 'first', tokens: [] });
add('first: marcador de episódio pulado', { op: 'first', tokens: T('s01e02 casa') });
add('first: palavra com 3 emojis conta por unidades UTF-16', { op: 'first', tokens: ['😀😀😀', 'ab'] });
add('first: 2 emojis (4 unidades UTF-16) nomeia', { op: 'first', tokens: ['😀😀', 'ab'] });

const body = cases
  .map((c, i) => ({ id: `md-${String(i + 1).padStart(3, '0')}`, input: c.input, note: c.note }))
  .map((c) => '    ' + JSON.stringify(c))
  .join(',\n');

writeFileSync(
  OUT,
  `{
  "version": "corpus-matching-tokens-decisions/1",
  "note": "Decisões de matching-tokens.ts com argumentos explícitos. A entrada é JSON com 'op' e os argumentos; a saída é número, 1/0 ou token ('-' para undefined). IDs estáveis: caso novo recebe id novo no fim.",
  "cases": [
${body}
  ]
}
`,
);
console.log(`[corpus] ${cases.length} casos`);
