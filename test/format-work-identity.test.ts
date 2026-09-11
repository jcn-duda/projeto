// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// matchesEpisodeWorkIdentity — identidade de obra delimitada pelo marcador
// de episódio (T2): spin-offs rejeitados, obra principal aceita, formatos
// inverso/duplo e universos multilíngues.
import { test } from 'node:test';
import assert from 'node:assert';
import { matchesEpisodeWorkIdentity } from '../src/utils/format.js';

// -----------------------------------------------------------------------------
// T2 (Tarefa 3.2): Identidade de Obra em Episódio (matchesEpisodeWorkIdentity)
// -----------------------------------------------------------------------------
test('matchesEpisodeWorkIdentity: rejeição estrita de spin-offs e preservação da obra principal', () => {
  // 1. Spin-offs com tokens compartilhados rejeitados (< 70% de precisão)
  assert.equal(
    matchesEpisodeWorkIdentity(
      'Rick.and.Morty.The.Anime.S01E01.1080p.WEB-DL.x264',
      ['Rick and Morty', 'Rick & Morty'],
    ),
    false,
    'The Anime não é Rick and Morty principal',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'The.Walking.Dead.World.Beyond.S01E01.1080p.WEB-DL',
      ['The Walking Dead'],
    ),
    false,
    'World Beyond é spin-off separado',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'The.Walking.Dead.Daryl.Dixon.S01E01.1080p.AMZN.WEBRip',
      ['The Walking Dead'],
    ),
    false,
    'Daryl Dixon é spin-off separado',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'The.Walking.Dead.The.Ones.Who.Live.S01E01.1080p',
      ['The Walking Dead'],
    ),
    false,
    'The Ones Who Live é spin-off separado',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'Game.of.Thrones.House.of.the.Dragon.S01E01.1080p',
      ['Game of Thrones'],
    ),
    false,
    'House of the Dragon não herda busca de Game of Thrones',
  );

  // 2. Releases legítimas da obra principal aceitas
  assert.equal(
    matchesEpisodeWorkIdentity(
      'Rick.and.Morty.S01E01.1080p.WEBRip.x264-FLUX',
      ['Rick and Morty'],
    ),
    true,
    'Rick and Morty padrão aceito',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'The.Walking.Dead.S11E24.Rest.in.Peace.1080p.AMZN.WEB-DL',
      ['The Walking Dead'],
    ),
    true,
    'The Walking Dead com título de episódio após S11E24 aceito',
  );

  // 3. Formato inverso (marcador de episódio à esquerda, ex: RedeTorrent) aceito
  assert.equal(
    matchesEpisodeWorkIdentity(
      'S01E02 From 1080p WEBRip x264-EVOLVE',
      ['From'],
    ),
    true,
    'formato inverso com marcador à esquerda aceito',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      '1x04 Breaking Bad 720p HDTV',
      ['Breaking Bad'],
    ),
    true,
    'marcador 1x04 à esquerda aceito',
  );

  // 4. Formato duplo delimitado (marcador antes e depois do título) aceito
  assert.equal(
    matchesEpisodeWorkIdentity(
      'S02E01 A Casa do Dragão S02E01 1080p Dual Audio',
      ['House of the Dragon', 'A Casa do Dragão'],
    ),
    true,
    'formato duplo delimitado aceito',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'S01E01 Rick and Morty S01E01 720p Dublado',
      ['Rick and Morty'],
    ),
    true,
    'duplo marcador Rick and Morty aceito',
  );

  // 5. Releases sem marcador de episódio (pack de temporada, filme) não são condenadas
  assert.equal(
    matchesEpisodeWorkIdentity(
      'From 2022 Season 1 1080p BluRay x264',
      ['From'],
    ),
    true,
    'sem marcador de episódio específico retorna true',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'The Walking Dead Complete Series S01-S11 1080p',
      ['The Walking Dead'],
    ),
    true,
    'pack de temporadas completas retorna true',
  );

  // 6. Universo multilíngue (títulos em português e inglês)
  assert.equal(
    matchesEpisodeWorkIdentity(
      'O.Urso.S01E01.1080p.Dublado',
      ['The Bear', 'O Urso'],
    ),
    true,
    'nome pt-BR aceito no universo multilíngue',
  );

  assert.equal(
    matchesEpisodeWorkIdentity(
      'The.Bear.S01E01.1080p.WEB-DL',
      ['The Bear', 'O Urso'],
    ),
    true,
    'nome original aceito no universo multilíngue',
  );

  // 7. Entradas nulas ou array de nomes vazio
  assert.equal(matchesEpisodeWorkIdentity('Rick and Morty S01E01', null), true);
  assert.equal(matchesEpisodeWorkIdentity('Rick and Morty S01E01', []), true);
});

