const { test } = require('node:test');
const assert = require('node:assert');

// Dublado em tracker global: classificação por TÍTULO (não por indexer),
// detecção de pack multi-obra e o merge que preserva a origem BR quando a
// varredura pt-BR devolve o mesmo hash titulado em português.
const {
  looksPtBr,
  isMultiWorkCollection,
  toStremioStream,
  dedupeByHash,
  matchesBrTitle,
} = require('../src/utils/format');

const HASH_A = 'a'.repeat(40);

test('looksPtBr reconhece marcas de dublado pt-BR no título', () => {
  // O caso motivador: pack dublado titulado em português em tracker global.
  assert.equal(
    looksPtBr('Jornada Nas Estrelas (Todos os filmes 1979-2016) Dublado Portugues Brasil'),
    true,
  );
  assert.equal(looksPtBr('Star Trek The Motion Picture 1979 DUBLADO'), true);
  assert.equal(looksPtBr('Filme Nacional 2020'), true);
  // Dual sozinho NÃO basta: em tracker global pode ser EN + qualquer idioma.
  assert.equal(looksPtBr('Star Trek 1979 DUAL AUDIO'), false);
  // Dual com PT explícito ao lado conta.
  assert.equal(looksPtBr('Star Trek 1979 DUAL AUDIO PT-BR'), true);
  // Legendado não é dublado.
  assert.equal(looksPtBr('Star Trek 1979 LEGENDADO'), false);
  // Título sem marca nenhuma de áudio.
  assert.equal(looksPtBr('Star Trek The Motion Picture 1979 1080p BluRay x264'), false);
});

test('isMultiWorkCollection só pega faixa de anos + palavra de empacotamento', () => {
  assert.equal(
    isMultiWorkCollection('Jornada Nas Estrelas (Todos os filmes 1979-2016) Dublado Portugues Brasil'),
    true,
  );
  assert.equal(isMultiWorkCollection('Coleção Star Trek 1979 - 2016 1080p'), true);
  assert.equal(isMultiWorkCollection('Pacote Filmes 1990 ate 2010'), true);
  // Ano único não é faixa: filme normal passa.
  assert.equal(isMultiWorkCollection('Star Trek 1979 1080p BluRay'), false);
  // Palavras de pack sem faixa de anos (temporada completa) não são coleção
  // multi-obra: o debrid escolhe o episódio pelo s/e.
  assert.equal(isMultiWorkCollection('Star Trek Todas as Temporadas'), false);
  assert.equal(isMultiWorkCollection(''), false);
});

test('toStremioStream marca BR pelo título mesmo vindo de indexer global', () => {
  const stream = toStremioStream({
    title: 'Jornada Nas Estrelas (Todos os filmes 1979-2016) Dublado Portugues Brasil',
    magnet: `magnet:?xt=urn:btih:${HASH_A}`,
    seeders: 5,
    size: 40 * 1024 ** 3,
    tracker: 'kickasstorrents',
    indexer: 'kickasstorrents',
    isBr: false,
  });
  assert.equal(stream._br, true);
  assert.equal(stream._dubbed, true);

  // Sem marca no título, indexer global continua sem BR.
  const plain = toStremioStream({
    title: 'Star Trek The Motion Picture 1979 1080p BluRay x264',
    magnet: `magnet:?xt=urn:btih:${HASH_A}`,
    seeders: 5,
    size: 8 * 1024 ** 3,
    indexer: 'thepiratebay',
    isBr: false,
  });
  assert.equal(plain._br, false);
  assert.equal(plain._dubbed, false);

  // Flag do provider BR segue valendo mesmo sem marca no título
  // (comandotorrents/nerdfilmes não citam "DUBLADO").
  const brProvider = toStremioStream({
    title: 'Jornada nas Estrelas (2009)',
    magnet: `magnet:?xt=urn:btih:${HASH_A}`,
    seeders: 1,
    size: 1025,
    indexer: 'comandotorrents',
    isBr: true,
  });
  assert.equal(brProvider._br, true);
});

test('matchesBrTitle aceita o pack multi-obra titulado em português', () => {
  // O título do pack carrega "filmes", "portugues", "brasil" e a faixa de
  // anos — nenhum deles pode contar contra a precisão nem derrubar a regra
  // de prefixo.
  const title = 'Jornada Nas Estrelas (Todos os filmes 1979-2016) Dublado Portugues Brasil';
  const names = ['Jornada nas Estrelas', 'Star Trek'];
  assert.equal(
    matchesBrTitle(title, names[0], 1979, { isSeries: false, allNames: names }),
    true,
  );
  // Obra diferente continua morrendo mesmo com palavra parecida.
  assert.equal(
    matchesBrTitle('Star Wars Todos os filmes 1977-2019 Dublado', names[0], 1979, {
      isSeries: false,
      allNames: names,
    }),
    false,
  );
});

test('dedupeByHash: empate de seeders fica com a listagem dublada', () => {
  const en = {
    infoHash: HASH_A, _seeders: 5, _br: false, _dubbed: false,
    _indexer: 'thepiratebay', _tracker: 'thepiratebay', _quality: '1080p',
    _size: 8 * 1024 ** 3, name: 'Star Trek EN',
  };
  const pt = {
    infoHash: HASH_A, _seeders: 5, _br: true, _dubbed: true,
    _indexer: 'kickasstorrents', _tracker: 'kickasstorrents', _quality: 'sem resolução',
    _size: 40 * 1024 ** 3, name: 'Jornada Nas Estrelas PT',
  };
  // Independente da ordem de chegada.
  for (const order of [[en, pt], [pt, en]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._br, true);
    assert.equal(merged._dubbed, true);
  }
  // Seeders continuam sendo a evidência principal: mais seeds vence mesmo sem dublado.
  const [winner] = dedupeByHash([{ ...pt, _seeders: 2 }, { ...en, _seeders: 9 }]);
  assert.equal(winner._br, false);
});

test('isMultiWorkCollection: palavra forte dispensa faixa de anos', () => {
  assert.equal(isMultiWorkCollection('De Volta Para o Futuro Trilogia - [BluRay 720p Dublado]'), true);
  assert.equal(isMultiWorkCollection('Coleção Velozes e Furiosos bluray 1080p dublado'), true);
  assert.equal(isMultiWorkCollection('Colecao Harry Potter Dublado'), true);
  assert.equal(isMultiWorkCollection('TRILOGIA MATRIX DUBLADO PT-BR avi'), true);
  // Palavras fracas continuam exigindo faixa de anos.
  assert.equal(isMultiWorkCollection('Star Trek Todas as Temporadas'), false);
  assert.equal(isMultiWorkCollection('Star Trek 1979 1080p BluRay'), false);
});

test('isMultiWorkCollection: saga NÃO é palavra forte — "A Saga Crepúsculo" é filme único', () => {
  assert.equal(isMultiWorkCollection('A Saga Crepusculo Amanhecer Parte 1 RMVB Dublado'), false);
  assert.equal(isMultiWorkCollection('Saga Crepusculo Dublado 1080p'), false);
  // Mas saga com faixa de anos continua pegando (regra fraca).
  assert.equal(isMultiWorkCollection('Saga Crepusculo 2008-2012 Dublado'), true);
});

test('_multiWork sobrevive ao dedupeByHash: OR entre winner e loser', () => {
  const pack = {
    infoHash: HASH_A, _seeders: 3, _br: true, _dubbed: true,
    _indexer: 'kickasstorrents', _tracker: 'kickasstorrents', _quality: '1080p',
    _size: 40 * 1024 ** 3, name: 'Trilogia Dublado', _multiWork: true,
  };
  const global = {
    infoHash: HASH_A, _seeders: 5, _br: false, _dubbed: false,
    _indexer: 'thepiratebay', _tracker: 'thepiratebay', _quality: '1080p',
    _size: 40 * 1024 ** 3, name: 'Trilogy EN', _multiWork: false,
  };
  // Hash idêntico = mesmo conteúdo: se QUALQUER listagem marcou como pack, o
  // merge preserva a marca. O perdedor BR com título de coleção não pode
  // perder o estrito para o vencedor EN sem marca.
  const [merged1] = dedupeByHash([pack, global]);
  assert.equal(merged1._multiWork, true);
  // Nenhum marcado: continua false.
  const [merged2] = dedupeByHash([{ ...pack, _multiWork: false }, { ...global, _multiWork: false }]);
  assert.equal(merged2._multiWork, false);
});

test('toStremioStream marca _multiWork em pack detectado', () => {
  const stream = toStremioStream({
    title: 'De Volta Para o Futuro Trilogia - [BluRay 720p Dublado]',
    magnet: `magnet:?xt=urn:btih:${HASH_A}`,
    seeders: 5,
    size: 40 * 1024 ** 3,
    indexer: 'thepiratebay',
    isBr: false,
  });
  assert.equal(stream._multiWork, true);
  assert.equal(stream._br, true);

  // Filme único não marca.
  const plain = toStremioStream({
    title: 'Star Trek The Motion Picture 1979 1080p BluRay x264',
    magnet: `magnet:?xt=urn:btih:${HASH_A}`,
    seeders: 5,
    size: 8 * 1024 ** 3,
    indexer: 'thepiratebay',
    isBr: false,
  });
  assert.equal(plain._multiWork, false);
});
