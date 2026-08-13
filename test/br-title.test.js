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
  assert.equal(matchesBrTitle('Fallout 4 (PC) [2015] – Download Torrent', 'Fallout', null), true);
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
