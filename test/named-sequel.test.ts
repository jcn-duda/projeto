// Sequel nomeada com ano EXATO diferente do catálogo (named-sequel).
// Medido: Apocalypse (2004) / Extinction (2007) entravam na lista do
// Resident Evil (2002) porque cobriam os tokens da franquia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterRelevantRaw as relevantRaw } from '../src/utils/format.js';
import { namedSequelContradicts } from '../src/utils/matching-tokens.js';
import { titleTokens } from '../src/utils/matching-vocabulary.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const magnet = (h: string, dn: string) => `magnet:?xt=urn:btih:${h}&dn=${encodeURIComponent(dn)}`;

const RE_BASE = {
  names: ['Resident Evil', 'O Hóspede Maldito'],
  year: 2002,
  isSeries: false,
  season: null,
  episode: null,
};

test('named-sequel: Apocalypse e Extinction fora da busca Resident Evil 2002', () => {
  const apocalypse = {
    title: 'Resident Evil: Apocalypse (2004) 1080p BluRay',
    magnet: magnet(HASH, 'Resident.Evil.Apocalypse.2004'),
  };
  const extinction = {
    title: 'Resident Evil: Extinction (2007) 720p WEB-DL',
    magnet: magnet(OTHER, 'Resident.Evil.Extinction.2007'),
  };
  const rejected: Array<{ title: string; reason: string }> = [];
  const result = relevantRaw([apocalypse, extinction], RE_BASE, (item, reason) => {
    rejected.push({ title: String(item.title || ''), reason });
  });
  assert.equal(result.length, 0, 'sequels nomeadas com ano diferente saem');
  // Apocalypse (2004) cabe no ±2 do yearContradicts — named-sequel é quem corta.
  // Extinction (2007) já morre no title (±2) antes de chegar na regra nova.
  const apo = rejected.find((r) => /Apocalypse/i.test(r.title));
  assert.ok(apo, 'Apocalypse rejeitado');
  assert.equal(apo!.reason, 'named-sequel');
});

test('named-sequel: Resident Evil (2002) YIFY permanece', () => {
  const item = {
    title: 'Resident Evil (2002) 1080p BluRay YIFY',
    magnet: magnet(HASH, 'Resident.Evil.2002.1080p.BluRay.YIFY'),
  };
  assert.equal(relevantRaw([item], RE_BASE).length, 1);
});

test('named-sequel: "Resident Evil 1 - O Hóspede Maldito (2002)" permanece', () => {
  const item = {
    title: 'Resident Evil 1 - O Hóspede Maldito (2002) 1080p Dual',
    magnet: magnet(HASH, 'Resident.Evil.1.O.Hospede.Maldito.2002'),
    isBr: true,
  };
  assert.equal(relevantRaw([item], RE_BASE).length, 1);
});

test('named-sequel: Batman Ressurge sem ano continua morrendo por SEQUENCE_WORDS', () => {
  const nomes = ['Batman: O Cavaleiro das Trevas', 'The Dark Knight'];
  const ctx = { names: nomes, year: 2008, isSeries: false, season: null, episode: null };
  const sequela = {
    title: 'Batman: O Cavaleiro Das Trevas Ressurge 720p HD Dublado',
    magnet: magnet(HASH, 'Cavaleiro.Das.Trevas.Ressurge'),
    isBr: true,
  };
  const rejected: string[] = [];
  const result = relevantRaw([sequela], ctx, (_item, reason) => rejected.push(reason));
  assert.equal(result.length, 0);
  // Sem ano declarado ⇒ named-sequel não engaja; SEQUENCE_WORDS/estrutura corta.
  assert.ok(!rejected.includes('named-sequel'), `esperado title, got ${rejected.join(',')}`);
});

test('named-sequel: busca explícita Apocalypse 2004 deixa Apocalypse passar', () => {
  const ctx = {
    names: ['Resident Evil: Apocalypse', 'O Hóspede Maldito: Apocalipse'],
    year: 2004,
    isSeries: false,
    season: null,
    episode: null,
  };
  const apocalypse = {
    title: 'Resident Evil: Apocalypse (2004) 1080p BluRay',
    magnet: magnet(HASH, 'Resident.Evil.Apocalypse.2004'),
  };
  assert.equal(relevantRaw([apocalypse], ctx).length, 1);
});

test('namedSequelContradicts: FP ~0 em títulos legítimos do mesmo ano', () => {
  // Corpus mínimo de obras com o MESMO ano no título — nenhum deve contradizer.
  const cases: Array<{ title: string; names: string[]; year: number }> = [
    { title: 'Resident Evil (2002) 1080p BluRay YIFY', names: ['Resident Evil', 'O Hóspede Maldito'], year: 2002 },
    { title: 'Resident Evil 1 - O Hóspede Maldito (2002) Dual', names: ['Resident Evil', 'O Hóspede Maldito'], year: 2002 },
    { title: 'Batman O Cavaleiro Das Trevas (2008) 720p Dublado', names: ['Batman: O Cavaleiro das Trevas', 'The Dark Knight'], year: 2008 },
    { title: 'A Origem (2010) 1080p BluRay Dublado', names: ['A Origem', 'Inception'], year: 2010 },
    { title: 'Scary Movie (2000) 1080p BluRay', names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000 },
    { title: 'Suzume 2022 1080p WEB-DL x264', names: ['Suzume'], year: 2022 },
    { title: 'Inception (2010) 1080p BluRay', names: ['Inception', 'A Origem'], year: 2010 },
    { title: 'The Dark Knight (2008) 1080p BluRay x264', names: ['The Dark Knight', 'Batman: O Cavaleiro das Trevas'], year: 2008 },
  ];
  let fp = 0;
  for (const c of cases) {
    const tokens = titleTokens(c.title);
    const universe = c.names.flatMap((n) => titleTokens(n));
    if (namedSequelContradicts(tokens, universe, c.year)) {
      fp += 1;
      console.log(`[named-sequel FP] ${c.title}`);
    }
  }
  console.log(`[named-sequel] FP count=${fp}/${cases.length}`);
  assert.equal(fp, 0, `falso positivo named-sequel: ${fp}`);
});

test('namedSequelContradicts: Apocalypse 2004 vs catálogo 2002', () => {
  const tokens = titleTokens('Resident Evil: Apocalypse (2004) 1080p');
  const universe = ['Resident Evil', 'O Hóspede Maldito'].flatMap((n) => titleTokens(n));
  assert.equal(namedSequelContradicts(tokens, universe, 2002), true);
  assert.equal(namedSequelContradicts(tokens, universe, 2004), false);
});

test('named-sequel: Sonic 3 BR com ano nacional ±1 passa', () => {
  // Nomes da obra pedida (sequência), não só "Sonic" — senão SEQUENCE/precisão
  // cortam por title antes do named-sequel. Ano 2025 no post BR × catálogo 2024.
  const ctx = {
    names: ['Sonic the Hedgehog 3', 'Sonic 3', 'Sonic 3 O Filme'],
    year: 2024,
    isSeries: false,
    season: null,
    episode: null,
  };
  const item = {
    title: 'Sonic 3 O Filme (2025) [1080p DUBLADO]',
    magnet: magnet(HASH, 'Sonic.3.O.Filme.2025'),
    isBr: true,
  };
  const rejected: string[] = [];
  assert.equal(relevantRaw([item], ctx, (_i, reason) => rejected.push(reason)).length, 1);
  assert.ok(!rejected.includes('named-sequel'));
});

test('named-sequel: Wicked Parte 1 BR com ano nacional ±1 passa', () => {
  const ctx = {
    names: ['Wicked', 'Wicked: Parte 1'],
    year: 2024,
    isSeries: false,
    season: null,
    episode: null,
  };
  const item = {
    title: 'Wicked: Parte 1 (2025) [1080p DUAL]',
    magnet: magnet(HASH, 'Wicked.Parte.1.2025'),
    isBr: true,
  };
  const rejected: string[] = [];
  assert.equal(relevantRaw([item], ctx, (_i, reason) => rejected.push(reason)).length, 1);
  assert.ok(!rejected.includes('named-sequel'));
});

test('named-sequel: Apocalypse global (sem isBr) continua cortado', () => {
  const apocalypse = {
    title: 'Resident Evil: Apocalypse (2004) 1080p BluRay',
    magnet: magnet(HASH, 'Resident.Evil.Apocalypse.2004'),
  };
  const rejected: string[] = [];
  const result = relevantRaw([apocalypse], RE_BASE, (_item, reason) => rejected.push(reason));
  assert.equal(result.length, 0);
  assert.ok(rejected.includes('named-sequel'));
});

test('named-sequel: Apocalypse com isBr:true passa (ano nacional não é sequela)', () => {
  // Precisão BR aceita (±2); named-sequel exigiria ano EXATO e cortaria o
  // global — com isBr o predicado não engaja. BR com subtítulo+ano nacional
  // é o caso a poupar; Apocalypse/Extinction globais continuam cortados.
  const apocalypse = {
    title: 'Resident Evil: Apocalypse (2004) 1080p BluRay Dual',
    magnet: magnet(HASH, 'Resident.Evil.Apocalypse.2004'),
    isBr: true,
  };
  const rejected: string[] = [];
  const result = relevantRaw([apocalypse], RE_BASE, (_item, reason) => rejected.push(reason));
  assert.equal(result.length, 1, 'BR não é cortado por named-sequel');
  assert.ok(!rejected.includes('named-sequel'));
});
