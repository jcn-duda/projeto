import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dublado em tracker global: classificação por TÍTULO (não por indexer),
// detecção de pack multi-obra e o merge que preserva a origem BR quando a
// varredura pt-BR devolve o mesmo hash titulado em português.
import { looksPtBr, isMultiWorkCollection, toStremioStream, dedupeByHash, matchesBrTitle } from '../src/utils/format.js';

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
  })!;
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
  })!;
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
  })!;
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

test('dedupeByHash: espelho global com DUAL herda BR/dublado do post BR do mesmo hash', () => {
  // A Rocha (tt0117500, 2026-09-14): a varredura pt-BR nos globais trouxe o
  // mesmo torrent do post da BLUDV com mais seeders, e o dublado sumia da lista.
  const post = toStremioStream({
    title: 'A Rocha (1996) [1080p DUAL 2.80 GB]', infoHash: HASH_A, seeders: 1,
    size: 2.8 * 1024 ** 3, tracker: 'BLUDV', indexer: 'bludv-cardigann', isBr: true,
  })!;
  const espelho = toStremioStream({
    title: 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES', infoHash: HASH_A, seeders: 50,
    size: 2.81 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
  })!;
  assert.equal(espelho._br, false, 'sozinho o espelho global não é BR');
  for (const order of [[post, espelho], [espelho, post]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._br, true, 'herda a origem BR do post');
    assert.equal(merged._dubbed, true, 'herda o dublado do post');
    assert.equal(merged._seeders, 50);
    assert.match(String(merged.title), /STARCKFILMES/, 'o título continua o do vencedor');
    assert.match(String(merged.name), /\bBR\b/, 'o nome ganha o chip BR');
  }

  // Sem DUAL no título global não há corroboração: a regra antiga vale.
  const semDual = toStremioStream({ title: 'The.Rock.1996.1080p.BluRay.x264-SPARKS', infoHash: HASH_A, seeders: 50, indexer: 'thepiratebay' })!;
  assert.equal(dedupeByHash([post, semDual])[0]._br, false);
  // DUAL com áudio estrangeiro declarado também não herda.
  const hindi = toStremioStream({ title: 'The.Rock.1996.1080p.BluRay.DUAL.Hindi.English.x264', infoHash: HASH_A, seeders: 50, indexer: 'thepiratebay' })!;
  assert.equal(dedupeByHash([post, hindi])[0]._br, false);
  // Post BR com prova de mentira não passa nada adiante.
  const [mentira] = dedupeByHash([{ ...post, _lied: true }, espelho]);
  assert.equal(mentira._dubbed, false);
});

test('dedupeByHash: perdedor BR sem dublado não transmite origem ao espelho global', () => {
  // Perdedor _br=true/_dubbed=false (post legendado de site BR): o DUAL do
  // vencedor global não prova áudio PT, então a vaga BR não pode ser herdada.
  const post = toStremioStream({
    title: 'A Rocha (1996) [1080p LEGENDADO 2.80 GB]', infoHash: HASH_A, seeders: 1,
    size: 2.8 * 1024 ** 3, tracker: 'BLUDV', indexer: 'bludv-cardigann', isBr: true,
  })!;
  const espelho = toStremioStream({
    title: 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES', infoHash: HASH_A, seeders: 50,
    size: 2.81 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
  })!;
  assert.equal(post._br, true);
  assert.equal(post._dubbed, false);
  for (const order of [[post, espelho], [espelho, post]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._br, false, 'sem dublado no perdedor não há herança');
    assert.equal(merged._dubbed, false);
  }
});

test('dedupeByHash: perdedor BR com DUAL + áudio estrangeiro declarado não herda', () => {
  // O post BR que declara DUAL + Hindi/French desmente o próprio áudio PT:
  // herdar origem/dublado dele entregaria vaga BR a release estrangeira.
  const post = toStremioStream({
    title: 'A Rocha (1996) [1080p DUAL Hindi English 2.80 GB]', infoHash: HASH_A, seeders: 1,
    size: 2.8 * 1024 ** 3, tracker: 'BLUDV', indexer: 'bludv-cardigann', isBr: true,
  })!;
  const espelho = toStremioStream({
    title: 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES', infoHash: HASH_A, seeders: 50,
    size: 2.81 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
  })!;
  for (const order of [[post, espelho], [espelho, post]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._br, false, 'áudio estrangeiro no post não autoriza herança');
    assert.equal(merged._dubbed, false);
  }
});

test('dedupeByHash: três clones do mesmo hash dão resultado idêntico em qualquer ordem', () => {
  const post = toStremioStream({
    title: 'A Rocha (1996) [1080p DUAL 2.80 GB]', infoHash: HASH_A, seeders: 1,
    size: 2.8 * 1024 ** 3, tracker: 'BLUDV', indexer: 'bludv-cardigann', isBr: true,
  })!;
  const espelho = toStremioStream({
    title: 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES', infoHash: HASH_A, seeders: 50,
    size: 2.81 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
  })!;
  // Gringo sem DUAL vence por seeders: sem corroboração, ninguém herda BR.
  const gringo = toStremioStream({
    title: 'The.Rock.1996.1080p.BluRay.x264-SPARKS', infoHash: HASH_A, seeders: 70,
    indexer: 'thepiratebay', isBr: false,
  })!;
  const expect = { _seeders: 70, _br: false, _dubbed: false };
  for (const order of [
    [post, espelho, gringo], [post, gringo, espelho], [espelho, post, gringo],
    [espelho, gringo, post], [gringo, post, espelho], [gringo, espelho, post],
  ]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._seeders, expect._seeders);
    assert.equal(merged._br, expect._br);
    assert.equal(merged._dubbed, expect._dubbed);
    assert.match(String(merged.title), /SPARKS/, 'o título continua o do vencedor por seeders');
  }
  // Duas variantes do mesmo caso com A Rocha real: o espelho DUAL vence e o
  // resultado também não depende da ordem de chegada.
  for (const order of [[post, espelho], [espelho, post]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._seeders, 50);
    assert.equal(merged._br, true);
    assert.equal(merged._dubbed, true);
  }
});

test('dedupeByHash: espelho global com DUAL + idioma estrangeiro amplo NÃO herda BR', () => {
  // Guarda ampla (namesForeignDubLanguage): LATINO/LAT/ESP/Eng-Spa/cirílico
  // negam a herança sem serem caminho destrutivo. Post BR limpo + espelho
  // estrangeiro com mais seeders não pode ocupar vaga BR.
  const post = toStremioStream({
    title: 'A Rocha (1996) [1080p DUAL 2.80 GB]', infoHash: HASH_A, seeders: 1,
    size: 2.8 * 1024 ** 3, tracker: 'BLUDV', indexer: 'bludv-cardigann', isBr: true,
  })!;
  const estranhos = [
    'A.Rocha.1996.1080p.BluRay.DUAL.LATINO',
    'A Rocha 1996 Dual Audio Latino Ingles',
    'A.Rocha.1996.DUAL.ESP.ENG',
    'A.Rocha.1996.1080p Dual Audio [Eng-Spa]',
    'A.Rocha.1996.1080p-Dual-Lat',
    'А.Роша.1996.1080p.BluRay.DUAL',
  ];
  for (const title of estranhos) {
    const espelho = toStremioStream({
      title, infoHash: HASH_A, seeders: 50,
      size: 2.81 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
    })!;
    for (const order of [[post, espelho], [espelho, post]]) {
      const [merged] = dedupeByHash(order);
      assert.equal(merged._br, false, `não herda BR: ${title}`);
      assert.equal(merged._dubbed, false, `não herda dublado: ${title}`);
    }
  }
});

test('dedupeByHash: post BR com Dual Áudio PT-BR ENG ainda empresta ao espelho STARCKFILMES', () => {
  // Isenção PT: ENG no perdedor é token estrangeiro na guarda ampla, mas
  // explicitPtAudio (PT-BR) absolve — senão o post BR honesto deixaria de
  // emprestar origem ao espelho global limpo.
  const post = toStremioStream({
    title: 'A Rocha (1996) Dual Áudio PT-BR ENG', infoHash: HASH_A, seeders: 1,
    size: 2.8 * 1024 ** 3, tracker: 'BLUDV', indexer: 'bludv-cardigann', isBr: true,
  })!;
  const espelho = toStremioStream({
    title: 'A.Rocha.1996.BluRay.1080p.x264.DUAL.2.0-STARCKFILMES', infoHash: HASH_A, seeders: 50,
    size: 2.81 * 1024 ** 3, tracker: 'kickasstorrents.to', indexer: 'kickasstorrents-to', isBr: false,
  })!;
  assert.equal(post._dubbed, true, 'PT-BR no post marca dublado');
  for (const order of [[post, espelho], [espelho, post]]) {
    const [merged] = dedupeByHash(order);
    assert.equal(merged._br, true, 'PT explícito absolve ENG no perdedor');
    assert.equal(merged._dubbed, true);
    assert.match(String(merged.title), /STARCKFILMES/);
  }
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

test('isMultiWorkCollection: palavras fortes em inglês dispensam faixa de anos', () => {
  assert.equal(isMultiWorkCollection('Back to the Future Trilogy [1985/1989/1990, USA, sci-fi]'), true);
  assert.equal(isMultiWorkCollection('The Matrix Quadrilogy 720p Dublado'), true);
  assert.equal(isMultiWorkCollection('Star Wars Anthology BluRay 1080p'), true);
  assert.equal(isMultiWorkCollection('James Bond Boxset 007 Dublado'), true);
  // "collection" é FRACA: exige faixa de anos.
  assert.equal(isMultiWorkCollection('Criterion Collection Seven Samurai'), false);
  assert.equal(isMultiWorkCollection('Criterion Collection Seven Samurai 1954-1965'), true);
  // "saga" continua fora.
  assert.equal(isMultiWorkCollection('The Fast Saga F9 2021 Dublado'), false);
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
  })!;
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
  })!;
  assert.equal(plain._multiWork, false);
});

test('isMultiWorkCollection aceita faixa de anos sem hífen', () => {
  // O MESMO pack aparece "1979-2016" no thepiratebay e "1979 2016" no 1337x.
  // Sem isso o mesmo hash era pack num tracker e filme comum no outro, e o
  // play caía no caminho permissivo justamente lá.
  assert.equal(isMultiWorkCollection('Jornada Nas Estrelas (Todos os filmes 1979 2016) Dublado'), true);
  assert.equal(isMultiWorkCollection('Jornada Nas Estrelas (Todos os filmes 1979-2016) Dublado'), true);
  assert.equal(isMultiWorkCollection('Coleção Filmes 1990, 2010'), true);
  assert.equal(isMultiWorkCollection('Pacote Filmes de 1990 a 2010'), true);
  // Um ano só continua não sendo faixa.
  assert.equal(isMultiWorkCollection('Star Trek 1979 1080p BluRay'), false);
  // Ano seguido de resolução não vira faixa.
  assert.equal(isMultiWorkCollection('Todos os filmes 2016 1080p'), false);
});
