const { test } = require('node:test');
const assert = require('node:assert');

// O filtro estrito de releases BR (matchesBrTitle) existe porque os sites BR
// são buscadores WordPress que devolvem posts "parecidos" para query curta:
// buscar "Fallout" trazia "Missão: Impossível – Efeito Fallout", "Fallout 4
// (PC)" e "Cesium Fallout", que tomavam as vagas reservadas da fonte real.
// Tudo aqui é puro — sem rede, sem servidor.
const { matchesBrTitle } = require('../src/utils/format');

test('aceita o post BR real (prefixo + ano batendo)', () => {
  assert.equal(matchesBrTitle('Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', 'Fallout', 2024), true);
  assert.equal(matchesBrTitle('Coringa (2019) BluRay [1080p DUBLADO]', 'Coringa', 2019), true);
});
test('rejeita post que só contém o nome no meio (filme parecido)', () => {
  assert.equal(matchesBrTitle('Missão: Impossível – Efeito Fallout BluRay [720p DUBLADO]', 'Fallout', 2024), false);
  assert.equal(
    matchesBrTitle('Missão: Impossível – Efeito Fallout Torrent (2018) Dual Áudio', 'Fallout', 2024),
    false,
  );
  assert.equal(matchesBrTitle('Cesium Fallout (2024) [LEGENDADO opção 1]', 'Fallout', 2024), false);
});
test('rejeita ano divergente quando o título tem um único ano', () => {
  assert.equal(matchesBrTitle('Fallout 4 (PC) [2015] – Download Torrent [opção 2]', 'Fallout', 2024), false);
  // Mesmo caso com o prefixo certo: o ano é o que denuncia o conteúdo errado.
  assert.equal(matchesBrTitle('Coringa 2 (2024) [1080p DUBLADO]', 'Coringa', 2019), false);
});

test('não decide quando o ano é ambíguo ou ausente', () => {
  // Dois tokens de ano: "2049" é o título, "2017" é o ano do filme — passa.
  assert.equal(matchesBrTitle('Blade Runner 2049 (2017) [1080p DUBLADO]', 'Blade Runner 2049', 2017), true);
  // Post sem ano: segue pelo prefixo, sem condenar por falta de informação.
  assert.equal(matchesBrTitle('Fallout 1ª Temporada Torrent WEB-DL Dual Áudio', 'Fallout', 2024), true);
});

test('ignora artigos e preposições nos dois lados', () => {
  assert.equal(
    matchesBrTitle('O Senhor dos Anéis: A Sociedade do Anel (2001) [1080p DUBLADO]', 'O Senhor dos Anéis', 2001),
    true,
  );
});

test('ano null/desconhecido não aplica a checagem de ano', () => {
  // Sem ano do catálogo, título com ano divergente ainda passa: não há contra o
  // que comparar. (O jogo "Fallout 4" não serve mais de exemplo aqui — hoje ele
  // morre antes, na regra de sequência, com ou sem ano.)
  assert.equal(matchesBrTitle('Fallout 1ª Temporada [2015] – Download Torrent', 'Fallout', null), true);
});

test('sequência barra o jogo mesmo sem ano do catálogo', () => {
  assert.equal(matchesBrTitle('Fallout 4 (PC) [2015] – Download Torrent', 'Fallout', null), false);
});

test('ano do catálogo sujo ("2024–", série em andamento) ainda compara', () => {
  assert.equal(matchesBrTitle('Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', 'Fallout', '2024–'), true);
  assert.equal(matchesBrTitle('Fallout 4 (PC) [2015] – Download Torrent', 'Fallout', '2024–'), false);
});

test('série aceita post de temporada com ano posterior à estreia', () => {
  // O ano do post de série é o da temporada, não o da estreia: rejeitar ano
  // divergente escondia a 2ª temporada inteira (S2 saiu em 2025, catálogo 2024).
  assert.equal(
    matchesBrTitle('Fallout 2ª Temporada (2025) WEB-DL [1080p DUBLADO]', 'Fallout', 2024, { isSeries: true }),
    true,
  );
  // …sem condenar o jogo: ano bem anterior à estreia morre nos dois modos.
  assert.equal(
    matchesBrTitle('Fallout 4 (PC) [2015] – Download Torrent', 'Fallout', 2024, { isSeries: true }),
    false,
  );
  // Post de série sem ano: conservador, passa.
  assert.equal(
    matchesBrTitle('Fallout 2ª Temporada Torrent WEB-DL Dual Áudio', 'Fallout', 2024, { isSeries: true }),
    true,
  );
});

test('filme aceita defasagem de até 2 anos (lançamento BR)', () => {
  // Estreia 2019, post BR com o ano do lançamento nacional (2020).
  assert.equal(matchesBrTitle('Filme Novo (2020) [1080p DUBLADO]', 'Filme Novo', 2019), true);
  // Defasagem maior continua sendo obra diferente.
  assert.equal(matchesBrTitle('Filme Novo (2024) [1080p DUBLADO]', 'Filme Novo', 2019), false);
});

test('continua exigindo o nome como palavra inteira', () => {
  assert.equal(matchesBrTitle('Fallouts e derivados (2024)', 'Fallout', 2024), false);
});

// Títulos reais do redetorrent: marcador SxxEyy à esquerda, nome do episódio
// no meio e tags de fonte/grupo (HMAX, NTb) que não são o nome da obra.
test('aceita release por episódio do redetorrent', () => {
  const names = ['House of the Dragon', 'A Casa do Dragão'];
  assert.equal(
    matchesBrTitle('S02E01   A Casa do Dragão S02E01 x264 DUAL 5.1 1080p', 'A Casa do Dragão', 2022, {
      isSeries: true, allNames: names,
    }),
    true,
  );
  assert.equal(
    matchesBrTitle(
      'House of the Dragon S01E02.The Rogue Prince  HMAX  DDP5.1.x264 NTb 1080p',
      'House of the Dragon', 2022, { isSeries: true, allNames: names },
    ),
    true,
  );
  assert.equal(
    matchesBrTitle('House of the Dragon S01E01. FULL  DUAL.5.1 1080p', 'House of the Dragon', 2022, {
      isSeries: true, allNames: names,
    }),
    true,
  );
  // Pack com rótulo de empacotamento antes do nome.
  assert.equal(
    matchesBrTitle(
      '1A TEMPORADA COMPLETA      House of the Dragon S01. HMAX  DDP5.1.Atmos x264 SMURF 1080p',
      'House of the Dragon', 2022, { isSeries: true, allNames: names },
    ),
    true,
  );
});

test('SxxEyy no título não abre porteira para outra obra', () => {
  const names = ['Fallout'];
  // Outra obra continua morrendo no prefixo mesmo com marcador de episódio.
  assert.equal(
    matchesBrTitle('Missão: Impossível – Efeito Fallout S01E01 1080p', 'Fallout', 2024, {
      isSeries: true, allNames: names,
    }),
    false,
  );
});

// Regra de sequência portada do pacote BRDUB: "Deadpool" casa "Deadpool 2" em
// 100% (todos os tokens da busca estão lá) e o ano não denuncia quando a
// sequência é próxima (2018 contra catálogo 2016 cabe na tolerância ±2).
test('filme: sequência que a busca não pediu é outra obra', () => {
  assert.equal(matchesBrTitle('Deadpool 2 (2018) BluRay DUBLADO', 'Deadpool', 2016), false);
  assert.equal(matchesBrTitle('Sonic 2 O Filme (2022) DUBLADO', 'Sonic O Filme', 2020), false);
  assert.equal(matchesBrTitle('Invasão Zumbi 2 Península (2020) DUBLADO', 'Invasão Zumbi', 2016), false);
  // Numeral por extenso conta igual ao dígito.
  assert.equal(matchesBrTitle('Duna Parte Dois (2024) DUBLADO', 'Duna', 2021), false);
  // A sequência PEDIDA passa.
  assert.equal(matchesBrTitle('Deadpool 2 (2018) BluRay DUBLADO', 'Deadpool 2', 2018), true);
});

test('a regra de sequência não pode matar release legítima', () => {
  // "5.1" (canal de áudio) vira "5 1" na normalização: sem parar no ano, o 5
  // viraria sequência e mataria o post real do Coringa.
  assert.equal(
    matchesBrTitle('Coringa (2020) 5.1 / BluRay – [2160p BLURAY DUBLADO 13 GB]', 'Coringa', 2019),
    true,
  );
  assert.equal(
    matchesBrTitle('Oppenheimer (2023) BluRay [1080p BLURAY DUBLADO 11.64 GB]', 'Oppenheimer', 2023),
    true,
  );
  // Série é isenta: o número antes do ruído é a TEMPORADA, e quem decide qual
  // temporada vale é o matchesEpisode.
  assert.equal(
    matchesBrTitle('Round 6 2ª Temporada (2024) DUBLADO', 'Round 6', 2021, { isSeries: true }),
    true,
  );
  assert.equal(
    matchesBrTitle('Fallout 2ª Temporada (2025) WEB-DL E01 [DUBLADO]', 'Fallout', 2024, { isSeries: true }),
    true,
  );
});

// Plano futuro: série DERIVADA não pode herdar a original.
//
// "Rick and Morty: The Anime" (2024) é uma spin-off com o MESMO prefixo, o
// MESMO ano do catálogo e a MESMA numeração de temporada/episódio da série
// original. Ela passa por todos os filtros atuais e rouba as vagas reservadas
// da original:
// - o pack "1ª Temporada (2024)" cobre o nome inteiro e casa o ano;
// - o "S01E02" desliga a checagem de precisão (pensada para release por
//   episódio, que carrega o NOME do episódio depois do marcador) e a spin-off
//   se aproveita da isenção.
test('spin-off "Rick e Morty: O Anime" não herda a série original (pack)', () => {
  const names = ['Rick and Morty', 'Rick e Morty'];
  assert.equal(
    matchesBrTitle('Rick e Morty: O Anime 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', 'Rick and Morty', 2024, {
      isSeries: true, allNames: names,
    }),
    false,
  );
});

test('spin-off "Rick And Morty The Anime S01E02" não herda a série original (episódio)', () => {
  const names = ['Rick and Morty', 'Rick e Morty'];
  assert.equal(
    matchesBrTitle('Rick And Morty The Anime S01E02 1080p', 'Rick and Morty', 2024, {
      isSeries: true, allNames: names,
    }),
    false,
  );
});

test('a rejeição da spin-off não derruba a release por episódio da série certa', () => {
  // Contrato do perEpisode intacto: release por episódio com o marcador logo
  // após o nome (e o nome do episódio depois dele) continua passando.
  const hotd = ['House of the Dragon', 'A Casa do Dragão'];
  assert.equal(
    matchesBrTitle('House of the Dragon S01E02.The Rogue Prince  HMAX  DDP5.1.x264 NTb 1080p', 'House of the Dragon', 2022, {
      isSeries: true, allNames: hotd,
    }),
    true,
  );
  // E a própria série original com nome de episódio idem.
  const rick = ['Rick and Morty', 'Rick e Morty'];
  assert.equal(
    matchesBrTitle('Rick and Morty S01E02.The Vat of Acid Episode  WEB-DL 1080p', 'Rick and Morty', 2024, {
      isSeries: true, allNames: rick,
    }),
    true,
  );
});

test('a rejeição da spin-off não derruba packs legítimos da série original', () => {
  const rick = ['Rick and Morty', 'Rick e Morty'];
  assert.equal(
    matchesBrTitle('Rick and Morty 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', 'Rick and Morty', 2024, {
      isSeries: true, allNames: rick,
    }),
    true,
  );
  // Pack com rótulo de empacotamento à esquerda (formato do redetorrent).
  const hotd = ['House of the Dragon', 'A Casa do Dragão'];
  assert.equal(
    matchesBrTitle('1A TEMPORADA COMPLETA      House of the Dragon S01. HMAX  DDP5.1.Atmos x264 SMURF 1080p', 'House of the Dragon', 2022, {
      isSeries: true, allNames: hotd,
    }),
    true,
  );
});

// --- Casos de Borda Adicionais (Milestone 1) ---

test('artigos multi-língua e títulos com preposições nos dois lados', () => {
  const names = ['The Lord of the Rings: The Fellowship of the Ring', 'O Senhor dos Anéis: A Sociedade do Anel'];
  assert.equal(
    matchesBrTitle('O Senhor dos Anéis: A Sociedade do Anel (2001) [1080p DUBLADO]', 'O Senhor dos Anéis', 2001, {
      allNames: names,
    }),
    true,
  );
  assert.equal(
    matchesBrTitle('The Lord of the Rings: The Fellowship of the Ring (2001) [1080p DUBLADO]', 'The Lord of the Rings', 2001, {
      allNames: names,
    }),
    true,
  );
});

test('intervalos de anos e múltiplos tokens de ano em séries e filmes', () => {
  // Série com intervalo de anos "2001-2002"
  assert.equal(
    matchesBrTitle('Band of Brothers (2001-2002) Minissérie [1080p DUBLADO]', 'Band of Brothers', 2001, {
      isSeries: true,
    }),
    true,
  );
  // Filme com múltiplos anos (ano no título da obra + ano de lançamento)
  assert.equal(
    matchesBrTitle('Blade Runner 2049 (2017) BluRay [1080p DUBLADO]', 'Blade Runner 2049', 2017),
    true,
  );
});

test('sequência com algarismos romanos vs arábicos em português', () => {
  // Sequência pedida em romano casando com romano
  assert.equal(matchesBrTitle('Gladiador II (2024) [1080p DUBLADO]', 'Gladiador II', 2024), true);
  // Sequência pedida em arábico casando com arábico
  assert.equal(matchesBrTitle('Gladiador 2 (2024) [1080p DUBLADO]', 'Gladiador 2', 2024), true);
  // Sequência não pedida deve ser rejeitada como outra obra
  assert.equal(matchesBrTitle('Gladiador II (2024) [1080p DUBLADO]', 'Gladiador', 2000), false);
  assert.equal(matchesBrTitle('Gladiador 2 (2024) [1080p DUBLADO]', 'Gladiador', 2000), false);
});

test('títulos com acentos, hífens e pontuação especial em português', () => {
  assert.equal(
    matchesBrTitle('À Prova de Balas (2020) WEB-DL [1080p DUBLADO]', 'A Prova de Balas', 2020),
    true,
  );
  assert.equal(
    matchesBrTitle('Pé-de-Meia: O Filme (2022) [720p DUBLADO]', 'Pe de Meia', 2022),
    true,
  );
});

test('variações de formato de ano do catálogo (Cinemeta / TMDB)', () => {
  assert.equal(matchesBrTitle('Série Teste S01 (2024) [1080p DUBLADO]', 'Série Teste', '2024–', { isSeries: true }), true);
  assert.equal(matchesBrTitle('Série Teste S01 (2021) [1080p DUBLADO]', 'Série Teste', '2020-2023', { isSeries: true }), true);
  assert.equal(matchesBrTitle('Filme Teste (2024) [1080p DUBLADO]', 'Filme Teste', 2024), true);
  assert.equal(matchesBrTitle('Filme Teste (2024) [1080p DUBLADO]', 'Filme Teste', null), true);
  assert.equal(matchesBrTitle('Filme Teste (2024) [1080p DUBLADO]', 'Filme Teste', undefined), true);
  assert.equal(matchesBrTitle('Filme Teste (2024) [1080p DUBLADO]', 'Filme Teste', ''), true);
});

test('variações do parâmetro allNames (vazio, null, duplicatas, caracteres especiais)', () => {
  assert.equal(matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', 2019, { allNames: [] }), true);
  assert.equal(matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', 2019, { allNames: null }), true);
  assert.equal(matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', 2019, { allNames: ['Coringa', 'Coringa'] }), true);
  assert.equal(matchesBrTitle('Coringa (2019) [1080p DUBLADO]', 'Coringa', 2019, { allNames: ['!@#$%', 'Coringa'] }), true);
});
