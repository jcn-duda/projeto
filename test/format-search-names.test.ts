// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// nomes de busca — resolveSearchNames, parseStremioId, buildSearchQuery,
// numeralSearchVariant, isMultiWorkCollection e franchiseRoot.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  isMultiWorkCollection,
  franchiseRoot,
  parseStremioId,
  buildSearchQuery,
  resolveSearchNames,
  numeralSearchVariant,
} from '../src/utils/format.js';

test('filmografia é palavra forte de pack; saga e "temporada completa" continuam fracas', () => {
  // Medido nos 1203 títulos prontos de uma conta real: "filmografia" aparece
  // 1 vez e é pack; "saga" 3 vezes (2 delas filme comum) e "completa" 11
  // (quase todas "Temporada Completa") — por isso só a primeira é forte.
  assert.equal(isMultiWorkCollection('FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR'), true);
  assert.equal(isMultiWorkCollection('Filmography Collection 1979'), true);
  assert.equal(isMultiWorkCollection('[Saga Crepúsculo]'), false);
  assert.equal(isMultiWorkCollection('The Twilight Saga Breaking Dawn Part 1'), false);
  assert.equal(isMultiWorkCollection('Lost Girl 1ª Temporada Completa'), false);
});

test('franchiseRoot corta subtítulo e sequência com trava de 2+ palavras', () => {
  assert.equal(franchiseRoot('Jornada nas Estrelas: O Filme'), 'Jornada nas Estrelas');
  assert.equal(franchiseRoot('Jornada nas Estrelas II'), 'Jornada nas Estrelas');
  assert.equal(franchiseRoot('Missão: Impossível'), 'Missão: Impossível', 'prefixo de 1 palavra não é cortado');
  assert.equal(franchiseRoot('Star Trek'), 'Star Trek', 'sem separador, título inteiro');
  assert.equal(franchiseRoot(''), '');
});

test('parseStremioId separa filme de episódio', () => {
  assert.deepEqual(parseStremioId('tt1254207'), { imdbId: 'tt1254207', season: null, episode: null });
  assert.deepEqual(parseStremioId('tt0903747:1:2'), { imdbId: 'tt0903747', season: 1, episode: 2 });
});

test('buildSearchQuery monta filme com ano e série SxxEyy', () => {
  assert.equal(buildSearchQuery({ name: 'Joker', year: 2019 }), 'Joker 2019');
  assert.equal(
    buildSearchQuery({ name: 'Breaking Bad' }, { season: 1, episode: 1 }),
    'Breaking Bad S01E01',
  );
});

test('resolveSearchNames cobre o Cinemeta que não conhece o id', () => {
  const titles = { pt: 'A Origem', original: 'Inception', year: '2010' };

  // Caminho normal: Cinemeta responde e manda no nome da busca.
  const comMeta = resolveSearchNames({
    meta: { name: 'Inception', year: '2010' },
    titles,
    imdbId: 'tt1375666',
  });
  assert.equal(comMeta.name, 'Inception');
  assert.deepEqual(comMeta.names, ['Inception', 'A Origem', 'Inception']);

  // Cinemeta 404 e TMDB responde: a query passava a ser a string crua
  // "tt1375666" e o filtro de título, preso a `meta?.name`, se desligava
  // inteiro — qualquer lixo do indexador ia direto pro usuário.
  const semMeta = resolveSearchNames({ meta: null, titles, imdbId: 'tt1375666' });
  assert.equal(semMeta.name, 'Inception', 'usa o original, que é o que o indexador global publica');
  assert.equal(semMeta.year, '2010', 'o ano precisa sobreviver: matchesBrTitle depende dele');
  assert.deepEqual(semMeta.names, ['A Origem', 'Inception'], 'o filtro continua tendo por que cortar');

  // Só o pt-BR disponível: melhor que o id cru.
  const soPt = resolveSearchNames({ meta: null, titles: { pt: 'Coringa' }, imdbId: 'tt7286456' });
  assert.equal(soPt.name, 'Coringa');

  // Nenhuma das duas APIs respondeu: aí sim o id cru é o que sobrou.
  const semNada = resolveSearchNames({ meta: null, titles: null, imdbId: 'tt7286456' });
  assert.equal(semNada.name, 'tt7286456');
  assert.deepEqual(semNada.names, [], 'sem nome não há filtro possível — e o gate tem que ver isso');
});

test('numeralSearchVariant: tt0084726 romano gera a variante arábica preservando ano/pontuação', () => {
  // Caso real do recall BR: o TMDB grava "II" e os sites BR ora "II", ora "2".
  assert.equal(
    numeralSearchVariant('Jornada nas Estrelas II: A Ira de Khan 1982'),
    'Jornada nas Estrelas 2: A Ira de Khan 1982',
  );
  // Série: o marcador SxxEyy (dígitos) não toca o padrão romano e fica intacto.
  assert.equal(
    numeralSearchVariant('Jornada nas Estrelas II: A Ira de Khan S01E01'),
    'Jornada nas Estrelas 2: A Ira de Khan S01E01',
  );
  assert.equal(numeralSearchVariant('Star Trek II: The Wrath of Khan'), 'Star Trek 2: The Wrath of Khan');
  assert.equal(numeralSearchVariant('Rocky II'), 'Rocky 2');
});

test('numeralSearchVariant não gera variante para números comuns nem I/X isolados', () => {
  const semVariante = [
    'Apollo 13 1995',   // dígito, não romano
    'District 9 2009',  // dígito, não romano
    '1917 2019',        // ano virou título
    'Fast X 2023',      // X fora da faixa II..IX
    'I Am Legend 2007', // I isolado é artigo
    'X Men 2000',       // X isolado é marca
    'V de Vingança 2005',
    'O V de Vingança 2005',
  ];
  for (const query of semVariante) {
    assert.equal(numeralSearchVariant(query), null, `query "${query}" não deveria gerar variante`);
  }
});

test('numeralSearchVariant: dois numerais ambíguos não geram variante', () => {
  // Trocar um e deixar o outro inventaria um filme que não existe.
  assert.equal(numeralSearchVariant('Rocky II: Parte IV'), null);
  assert.equal(numeralSearchVariant('Título II IV'), null);
});

