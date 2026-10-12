#!/usr/bin/env node
/**
 * Gera `scripts/golden/corpus-stream-quotas.json`: casos de `limitByIndexer`
 * (src/utils/stream-quotas.ts). Gerador descartável do corpus; o arquivo
 * commitado é a fonte. Os ids são estáveis: nunca renomear; caso novo recebe
 * id no fim.
 *
 * Forma de entrada (JSON com `op: "indexer"`):
 *   streams:        [{ indexer: string | null }]  -> StreamCandidate com só `_indexer`
 *   maxPerIndexer:  number (cota global; 0 = sem limite)
 *   exempt:         [índice de streams]           -> o Set de identidade do TS
 *   indexerLimits:  { chaveMinuscula: number }    -> cota por indexador
 *
 * A casca de dados aceita só número e string/null, para o oráculo Node e o
 * porte Rust receberem exatamente o mesmo valor (`"2"` viraria 2 no JS e 0 no
 * `as_f64`).
 *
 * Parte escrita à mão cobre as bordas; a parte pseudoaleatória (semente fixa)
 * cobre combinações de fontes, cotas e reservas. Nada de Math.random: o corpus
 * tem que sair igual em toda geração.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'scripts/golden/corpus-stream-quotas.json');

const cases = [];
const add = (note, obj) => {
  const streams = obj.streams.map((s) => {
    if (s.indexer !== null && typeof s.indexer !== 'string') {
      throw new Error(`indexer precisa ser string ou null: ${note}`);
    }
    return { indexer: s.indexer };
  });
  if (typeof obj.maxPerIndexer !== 'number') throw new Error(`maxPerIndexer precisa ser número: ${note}`);
  const exempt = obj.exempt ?? [];
  for (const i of exempt) {
    if (!Number.isInteger(i) || i < 0 || i >= streams.length) throw new Error(`exempt fora do intervalo: ${note}`);
  }
  const indexerLimits = obj.indexerLimits ?? {};
  for (const [k, v] of Object.entries(indexerLimits)) {
    if (typeof v !== 'number') throw new Error(`indexerLimits.${k} precisa ser número: ${note}`);
  }
  const input = { op: 'indexer', streams, maxPerIndexer: obj.maxPerIndexer, exempt, indexerLimits };
  cases.push({ id: `sq-${String(cases.length + 1).padStart(3, '0')}`, note, input: JSON.stringify(input) });
};

const s = (...names) => names.map((indexer) => ({ indexer }));

// Sem cota: a lista volta inteira, inclusive com fonte repetida e sem fonte.
add('sem cota e sem override devolve tudo', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: 0 });
add('lista vazia devolve vazio', { streams: [], maxPerIndexer: 2 });
add('cota global 0 com override ainda ativa filtro, mas 0 em tudo deixa passar', { streams: s('yts', 'yts'), maxPerIndexer: 0, indexerLimits: { yts: 0 } });

// Cota global simples.
add('cota 1 corta o segundo da mesma fonte', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: 1 });
add('cota 2 entre fontes intercaladas', { streams: s('yts', 'rarbg', 'yts', 'bludv', 'yts', 'rarbg'), maxPerIndexer: 2 });
add('cota conta cada fonte à parte', { streams: s('yts', 'rarbg', 'yts', 'yts', 'rarbg', 'rarbg'), maxPerIndexer: 2 });
add('cota igual ao total não corta', { streams: s('a', 'a', 'a'), maxPerIndexer: 3 });
add('cota acima do total não corta', { streams: s('a', 'a'), maxPerIndexer: 9 });
add('cota negativa vira sem limite', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: -3 });
add('cota fracionária trunca (1.9 -> 1)', { streams: s('yts', 'yts'), maxPerIndexer: 1.9 });
add('cota fracionária 2.5 trunca para 2', { streams: s('yts', 'yts', 'yts', 'yts'), maxPerIndexer: 2.5 });

// Fonte ausente: nunca conta, nunca corta.
add('indexer null nunca é cortado', { streams: s(null, null, null), maxPerIndexer: 1 });
add('indexer vazio nunca é cortado', { streams: s('', '', ''), maxPerIndexer: 1 });
add('indexer só com espaços conta como vazio', { streams: s('   ', '\t', 'yts', 'yts'), maxPerIndexer: 1 });
add('sem indexador não entra no balde de outras fontes', { streams: s(null, 'yts', null, 'yts'), maxPerIndexer: 1 });

// Normalização da chave: trim + minúsculas.
add('caixa diferente é a mesma fonte', { streams: s('YTS', 'yts', 'Yts'), maxPerIndexer: 1 });
add('espaços ao redor são a mesma fonte', { streams: s('yts ', ' yts', 'yts'), maxPerIndexer: 2 });
add('acento minúsculo e maiúsculo são a mesma fonte', { streams: s('Ação', 'ação', 'AÇÃO'), maxPerIndexer: 1 });
add('nomes parecidos são fontes diferentes', { streams: s('yts', 'yts-mx', 'yts2'), maxPerIndexer: 1 });

// Override por fonte.
add('override acima da global libera mais', { streams: s('bludv', 'bludv', 'bludv', 'bludv'), maxPerIndexer: 1, indexerLimits: { bludv: 3 } });
add('override 0 libera a fonte inteira', { streams: s('bludv', 'bludv', 'bludv'), maxPerIndexer: 1, indexerLimits: { bludv: 0 } });
add('override abaixo da global aperta a fonte', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: 3, indexerLimits: { yts: 1 } });
add('override só vale para a própria fonte', { streams: s('yts', 'yts', 'yts', 'rarbg', 'rarbg', 'rarbg'), maxPerIndexer: 1, indexerLimits: { yts: 2 } });
add('fonte sem override usa a global', { streams: s('yts', 'yts', 'rarbg', 'rarbg'), maxPerIndexer: 1, indexerLimits: { yts: 2 } });
add('override com global 0 limita só a fonte citada', { streams: s('yts', 'yts', 'yts', 'rarbg', 'rarbg'), maxPerIndexer: 0, indexerLimits: { yts: 1 } });
add('override negativo vira sem limite', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: 1, indexerLimits: { yts: -4 } });
add('override fracionário trunca (1.5 -> 1)', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: 0, indexerLimits: { yts: 1.5 } });
add('objeto de override vazio é o mesmo que nenhum', { streams: s('yts', 'yts'), maxPerIndexer: 1, indexerLimits: {} });
add('chave de override com maiúscula nunca casa (fonte é minúscula)', { streams: s('YTS', 'YTS', 'YTS'), maxPerIndexer: 1, indexerLimits: { YTS: 5 } });
add('override para fonte que não aparece não muda nada', { streams: s('yts', 'yts'), maxPerIndexer: 1, indexerLimits: { rarbg: 9 } });

// Reserva (exempt): passa mesmo acima da cota, mas CONTA.
add('reserva conta para o limite da própria fonte', { streams: s('yts', 'yts', 'yts'), maxPerIndexer: 1, exempt: [0] });
add('reserva no meio passa e segue contando', { streams: s('yts', 'yts', 'yts', 'yts'), maxPerIndexer: 1, exempt: [1] });
add('reserva fura o teto e a seguinte continua cortada', { streams: s('yts', 'yts(r)', 'yts', 'yts'), maxPerIndexer: 1, exempt: [1] });
add('duas reservas de cota 1 deixam as duas e cortam a terceira', { streams: s('yts', 'yts', 'yts', 'yts'), maxPerIndexer: 1, exempt: [1, 2] });
add('reserva com fonte nula passa de qualquer jeito', { streams: s(null, 'yts'), maxPerIndexer: 1, exempt: [0] });
add('reserva com fonte vazia passa de qualquer jeito', { streams: s('', ''), maxPerIndexer: 1, exempt: [1] });
add('reserva de fonte com override 1 conta igual', { streams: s('bludv', 'bludv', 'bludv'), maxPerIndexer: 0, indexerLimits: { bludv: 1 }, exempt: [0] });
add('reserva com cota 0 não muda o resultado', { streams: s('yts', 'yts'), maxPerIndexer: 0, exempt: [0, 1] });
add('reserva não ajuda outra fonte', { streams: s('yts', 'rarbg', 'yts'), maxPerIndexer: 1, exempt: [1] });
add('reservas de fontes diferentes não se somam', { streams: s('yts', 'rarbg', 'yts', 'rarbg'), maxPerIndexer: 1, exempt: [0, 1] });

// Cotas altas e listas longas.
add('lista longa com cota 3 e três fontes', { streams: s('a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c'), maxPerIndexer: 3 });
add('lista longa sem cota é idêntica à entrada', { streams: s('a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'), maxPerIndexer: 0 });

// Pseudoaleatório com semente fixa (mulberry32): combinações de fonte, cota,
// override e reserva. Determinístico: o corpus é a fonte, não o PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261012);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const POOL = ['yts', 'rarbg', 'bludv', 'mico', 'Yts', ' RARBG ', 'BluDV', '', null, 'Ação'];
const KEYS = ['yts', 'rarbg', 'bludv', 'mico', 'ação'];
for (let n = 0; n < 45; n += 1) {
  const len = 1 + Math.floor(rnd() * 10);
  const streams = Array.from({ length: len }, () => ({ indexer: pick(POOL) }));
  const maxPerIndexer = Math.floor(rnd() * 4);
  const indexerLimits = {};
  for (const k of KEYS) {
    if (rnd() < 0.35) indexerLimits[k] = Math.floor(rnd() * 4);
  }
  const exempt = [];
  for (let i = 0; i < len; i += 1) {
    if (rnd() < 0.2) exempt.push(i);
  }
  add(`pseudoaleatório ${n + 1} (semente fixa)`, { streams, maxPerIndexer, indexerLimits, exempt });
}

const corpus = {
  version: 'corpus-stream-quotas/1',
  note:
    'stream-quotas.ts: limitByIndexer. Entrada JSON com op "indexer". Saída: JSON com os índices ' +
    'mantidos, na ordem original (ex.: "[0,2]"). Índices, não identidade de objeto. IDs estáveis: ' +
    'nunca renomear; caso novo recebe id no fim.',
  cases,
};

writeFileSync(OUT, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
console.log(`[corpus] ${cases.length} casos -> scripts/golden/corpus-stream-quotas.json`);
