// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// normalizeTitle (Unicode-aware desde a correção de escrita não-latina) e os
// portões de matchesName — nome degenerado ('??'), escrita não-latina,
// pedaço de palavra, artigo inglês, token repetido e fallback de nome curto.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeTitle,
  matchesName,
  endsWithSequenceMarker,
  filterRelevantRaw as relevantRaw,
} from '../src/utils/format.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('normalizeTitle tira acentos e pontuação', () => {
  assert.equal(normalizeTitle('Coringa: Dublado!'), 'coringa dublado');
  assert.equal(normalizeTitle('À Prova de Fogo'), 'a prova de fogo');
});

test('matchesName aceita variações mas rejeita título fora', () => {
  assert.equal(matchesName('Joker 2019 1080p BluRay', 'Joker'), true);
  // Release BR vem só com o título em português.
  assert.equal(matchesName('Coringa Dublado 1080p', 'Coringa'), true);
  assert.equal(matchesName('Vingadores Guerra Infinita', 'Coringa'), false);
  // Nome sem palavra aproveitável não pode dar passe livre: um alias
  // degenerado ('??', CJK) aprovava QUALQUER release via names.some no
  // filterRelevantRaw. Fail-closed — sem evidência do que casar, nada casa.
  assert.equal(matchesName('qualquer coisa', '??'), false);
});

test('matchesName: nome não-latino casa release não-latina e segue negando latino', () => {
  // O normalizador agora preserva \p{L}\p{N}\p{M}: "すずめの戸締まり" gera UM
  // token e "Убойные каникулы" idem. Contra título latino seguem negando pelo
  // caminho NORMAL (token japonês/cirílico não está nos tokens latinos) — não
  // mais pelo fail-closed do nome vazio; contra a própria release, casam.
  assert.equal(matchesName('Suzume 2022 1080p WEB-DL x264', 'すずめの戸締まり'), false);
  assert.equal(matchesName('Attack on Titan S01E01 1080p', '進撃の巨人'), false);
  assert.equal(matchesName('すずめの戸締まり 2022 1080p', 'すずめの戸締まり'), true);
  // Caso real do Rutor visto em tt1465522: "Убойные каникулы / Tucker and Dale…".
  assert.equal(matchesName('Убойные каникулы 2010 BDRip', 'Убойные каникулы'), true);
  // Contraprova latina: o mesmo mecanismo continua aceitando o nome real.
  assert.equal(matchesName('Suzume 2022 1080p WEB-DL x264', 'Suzume'), true);
  assert.equal(matchesName('Attack on Titan S01E01 1080p', 'Attack on Titan'), true);
});

test('matchesName não aceita pedaço de palavra nem título curto esvaziado', () => {
  // "Disclosure Day" tem título pt-BR "Dia D". Cortando palavra de até 2 letras
  // ele virava o token único `dia`, comparado por substring: aceitava "O DIABO
  // Veste Prada" e "Um DIA de Sorte". O lixo tomava as vagas BR reservadas e
  // empurrava pra fora o "Dia D (2026) WEB-DL [1080p DUBLADO]" de verdade.
  assert.equal(matchesName('O Diabo Veste Prada 2 (2026) WEB-DL [1080p DUBLADO]', 'Dia D'), false);
  assert.equal(matchesName('Um Dia de Sorte em Nova York Torrent (2026)', 'Dia D'), false);
  assert.equal(matchesName('Homem-Aranha: Um Novo Dia (2026) [opção 3]', 'Dia D'), false);
  assert.equal(matchesName('Dia D (2026) WEB-DL [1080p DUBLADO]', 'Dia D'), true);

  // Mesma raiz, com "A Origem" (Inception) puxando uma série inteira.
  assert.equal(matchesName('Origem 4ª Temporada (2026) WEB-DL [DUBLADO]', 'A Origem'), false);
  assert.equal(matchesName('Pearl: Uma História de Origem "X" Torrent (2022)', 'A Origem'), false);
  assert.equal(matchesName('A Origem (2010) BluRay 1080p Dublado', 'A Origem'), true);

  // O aperto não pode custar recall: pack de coleção e variação de numeral
  // continuam passando, e é deles que vêm boa parte das fontes dubladas.
  assert.equal(
    matchesName('Trilogia: O Senhor dos Anéis Versão Estendida', 'O Senhor dos Anéis: A Sociedade do Anel'),
    true,
  );
  assert.equal(matchesName('Coleção Guerra nas Estrelas [Star wars] BluRay 1080p', 'Guerra nas Estrelas'), true);
  assert.equal(matchesName('Duna: Parte 2 (2024) Dual Áudio', 'Duna: Parte Dois'), true);
  // Pontuação exótica no título não pode virar token perdido.
  assert.equal(matchesName('WALL-E (2008) BluRay Dublado', 'WALL·E'), true);
});

test('matchesName: a série-mãe The Walking Dead também não aceita Shaun (era 0.667)', () => {
  // Nome mais curto = razão mais inflada: no bug, [the, walking, dead] contra
  // "Shaun of the Dead" fazia 2/3 = 0.667, ainda acima do corte de Dead City.
  assert.equal(matchesName('Shaun of the Dead 2004 1080p BluRay x264', 'The Walking Dead'), false);
  assert.equal(matchesName('The Walking Dead S11E24 1080p AMZN WEB-DL', 'The Walking Dead'), true);

  const out = relevantRaw(
    [
      { title: 'The Walking Dead S01E01 1080p WEB-DL x264', magnet: `magnet:?xt=urn:btih:${HASH}` },
      { title: 'Shaun of the Dead 2004 720p BrRip XviD', magnet: `magnet:?xt=urn:btih:${OTHER}` },
    ],
    { names: ['The Walking Dead'], year: '2010–', isSeries: true, season: 1, episode: 1 },
  );
  assert.equal(out.length, 1);
  assert.match(out[0].title || '', /S01E01/);
});

test('matchesName: token repetido no nome não vale dois acertos', () => {
  // Isolado do artigo: o nome não tem "the"/"o". Antes do dedup o "zumbi"
  // duplicado fazia 3/5 = 0.600 e o candidato passava com uma ocorrência só.
  assert.equal(matchesName('Zumbi Vale 2019 1080p', 'Zumbi Zumbi Vale Oeste Norte'), false);
  assert.equal(matchesName('Zumbi Zumbi Vale Oeste Norte 2019 1080p', 'Zumbi Zumbi Vale Oeste Norte'), true);
});

test('matchesName: artigo inglês não conta como token significativo', () => {
  // Isolado do dedup: o nome não tem token repetido. O "the" do nome fazia
  // 2/3 = 0.667 contra qualquer candidato que tivesse "the" + uma palavra.
  assert.equal(matchesName('The Dead Zone 1983 1080p', 'The Walking Dead'), false);
  // Quando o candidato tem o artigo, ele não atrapalha — só não ajuda.
  assert.equal(matchesName('The Walking Dead 2010 S01 DVDRip', 'The Walking Dead'), true);
});

test('matchesName: fallback mantém nome curto que É um artigo', () => {
  // O artigo só sai do conjunto significativo quando sobram >= 2 tokens
  // longos; em "The Bear" ele É metade do título e fica. Sem o fallback a
  // troca do filtro custaria os nomes curros com artigo.
  assert.equal(matchesName('The Bear S01E01 1080p WEB-DL', 'The Bear'), true);
  assert.equal(matchesName('The Office S09 720p', 'The Office'), true);
  assert.equal(matchesName('From S01E01 1080p', 'From'), true);
  assert.equal(matchesName('Shogun S01E01 2160p', 'Shogun'), true);

  // Pelo caminho real da série, com a guarda de ano nova ativa.
  const bear = relevantRaw(
    [{ title: 'The Bear S01E01 1080p WEB-DL x264', magnet: `magnet:?xt=urn:btih:${HASH}` }],
    { names: ['The Bear'], year: '2022–', isSeries: true, season: 1, episode: 1 },
  );
  assert.equal(bear.length, 1, 'The Bear não pode sumir');
  const shogun = relevantRaw(
    [{ title: 'Shōgun S01E01 2160p WEB-DL', magnet: `magnet:?xt=urn:btih:${HASH}` }],
    { names: ['Shōgun'], year: '2024–', isSeries: true, season: 1, episode: 1 },
  );
  assert.equal(shogun.length, 1, 'Shogun não pode sumir');
});

test('endsWithSequenceMarker: mesmo corte do franchiseRoot, só no fim', () => {
  assert.equal(endsWithSequenceMarker('Se Beber, Não Case! Parte II'), true);
  assert.equal(endsWithSequenceMarker('O Senhor dos Anéis: O Retorno do Rei'), false);
  // O helper só olha o fim — "Apollo 13" termina em número e responde true
  // de propósito: quem protege "Distrito 9"/"Apollo 13" (número É o nome da
  // obra) é a trava de 2+ palavras do franchiseRoot, e o gate do degrau no
  // search-plan exige `franchise !== bare`. Não "consertar" o helper.
  assert.equal(endsWithSequenceMarker('Apollo 13'), true);
});

