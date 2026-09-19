// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// filtro relevante cru no caminho de SÉRIE — matchesBrTitle, T-format,
// homônimo parcial (Dead City), filme da mesma franquia (Demon Slayer),
// matchesGlobalSeriesNoMarker, guarda de ano e identidade de obra por
// episódio.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  matchesName,
  matchesBrTitle,
  matchesGlobalSeriesNoMarker,
  filterRelevantRaw as relevantRaw,
} from '../src/utils/format.js';
import type { RawItem } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('matchesBrTitle corta obra derivada que só começa com o nome', () => {
  // Especial animado e documentário: cobrem 2/2 do nome da série e entravam na
  // lista do S01E01. Só a precisão — quanto do título sobra fora da busca —
  // separa isso de um pack legítimo.
  const nomes = ['Game of Thrones'];
  const opts = { isSeries: true, allNames: nomes };
  assert.equal(
    matchesBrTitle('Game of Thrones: A Conquista e a Rebeliao Uma Historia Animada (2017)', 'Game of Thrones', '2011', opts),
    false,
  );
  assert.equal(
    matchesBrTitle('Game of Thrones A Ultima Vigilia Torrent (2019) Legendado WEB DL', 'Game of Thrones', '2011', opts),
    false,
  );
  assert.equal(
    matchesBrTitle('Game of Thrones 1a Temporada Dublado Torrent (2011) HDTV', 'Game of Thrones', '2011', opts),
    true,
  );

  // A release legítima carrega os DOIS nomes; medir contra um só condenaria o
  // outro como conteúdo estranho. Por isso a precisão exige a lista completa.
  const starWars = ['Star Wars', 'Guerra nas Estrelas'];
  assert.equal(
    matchesBrTitle('Colecao Guerra nas Estrelas [Star wars] BluRay 1080p Dublado', 'Guerra nas Estrelas', '1977', {
      allNames: starWars,
    }),
    true,
  );
  // Sem `allNames` a checagem de precisão não roda — quem chama não tem a
  // informação. O veículo aqui não pode ter número de sequência: "Fallout 4"
  // morreria na regra de sequência, que é outra checagem.
  assert.equal(
    matchesBrTitle('Fallout Torrent (2015) Legendado WEB DL', 'Fallout', null),
    true,
  );
});

// 6.4 — P1: sem o marcador T-format em EPISODE_TOKEN/episodeWorkTokens, o gate
// de precisão media o título INTEIRO ("… t01 e004 dub pt br") e a release
// dublada morria ANTES do matchesEpisode (risco 5.7). Título real do
// thepiratebay, nos dois ramos (isBr true e false).
const T_FORMAT_SERIE = 'Jornada Nas Estrelas T01 E004 1080p Dub PT-BR';
const tngContext = (episode: any) => ({
  names: ['Jornada Nas Estrelas', 'Star Trek'],
  year: 2024,
  isSeries: true,
  season: 1,
  episode,
});

test('T-format de série passa o filtro relevante no episódio pedido (BR e global)', () => {
  // isBr true: matchesBrTitle com allNames — sem o marcador T, "t01"/"dub"/
  // "pt"/"br" derrubariam a precisão abaixo do piso (0,70 de série).
  const br = relevantRaw([{ title: T_FORMAT_SERIE, isBr: true }], tngContext(4));
  assert.equal(br.length, 1, 'BR: E04 pedido mantém a release dublada');
  // isBr false: caminho global — identidade de obra + corte por episódio.
  const global = relevantRaw([{ title: T_FORMAT_SERIE, isBr: false }], tngContext(4));
  assert.equal(global.length, 1, 'global: E04 pedido mantém a release');
  // matchesBrTitle direto, na forma que o provider chama.
  assert.equal(
    matchesBrTitle(T_FORMAT_SERIE, 'Jornada Nas Estrelas', '2024', {
      isSeries: true,
      allNames: ['Jornada Nas Estrelas', 'Star Trek'],
    }),
    true,
  );
});

test('T-format de série é negado no episódio errado (E05)', () => {
  assert.deepEqual(relevantRaw([{ title: T_FORMAT_SERIE, isBr: true }], tngContext(5)), []);
  assert.deepEqual(relevantRaw([{ title: T_FORMAT_SERIE, isBr: false }], tngContext(5)), []);
});

test('filterRelevantRaw: série global não recebe filme homônimo parcial (Dead City × Shaun of the Dead)', () => {
  const shaun = (i: number) => ({
    title: [
      'Shaun of the Dead 2004 2160p 4K HDR10 BluRay x265',
      'Shaun of the Dead 2004 1080p BluRay x264',
      'Shaun of the Dead 2004 720p BrRip XviD',
      'Shaun of the Dead 2004 1080p WEB-DL DD5.1 H264',
      'Shaun of the Dead 2004 x264 AC3',
    ][i],
    magnet: `magnet:?xt=urn:btih:${String.fromCharCode(97 + i).repeat(40)}`,
  });
  const itens = [
    { title: 'The Walking Dead Dead City S01E01 1080p WEB-DL x264', magnet: `magnet:?xt=urn:btih:${HASH}` },
    // Pack da temporada: sem marcador de episódio, cobre pelo S01.
    { title: 'The Walking Dead Dead City S01 480p', magnet: `magnet:?xt=urn:btih:${OTHER}` },
    {
      title: 'The Walking Dead Dead City 1ª Temporada (2023) WEB-DL Dual Áudio',
      magnet: `magnet:?xt=urn:btih:c${'d'.repeat(39)}`,
      isBr: true,
    },
    ...[0, 1, 2, 3, 4].map(shaun),
  ];

  const out = relevantRaw(itens, {
    names: ['The Walking Dead: Dead City'],
    year: '2023–',
    isSeries: true,
    season: 1,
    episode: 1,
  });

  // Os cinco Shaun somem; a release por episódio, o pack S01 e a BR dublada
  // sobrevivem.
  assert.equal(out.filter((i: RawItem) => /Shaun/i.test(i.title || '')).length, 0, 'nenhum Shaun pode sobrar');
  assert.equal(out.length, 3, 'episódio + pack + BR dublada');
  // A guarda do matchesName dispara sozinha, sem depender do ano.
  assert.equal(matchesName('Shaun of the Dead 2004 2160p 4K HDR10 BluRay x265', 'The Walking Dead: Dead City'), false);
});

test('filterRelevantRaw: série global não recebe filme da MESMA franquia sem marcador (Demon Slayer × Infinity Castle)', () => {
  const itens = [
    {
      title: 'Demon Slayer: Kimetsu no Yaiba 1ª Temporada [1080p WEB DL DUBLADO]',
      magnet: `magnet:?xt=urn:btih:${HASH}`,
      isBr: true,
    },
    {
      title: 'Demon Slayer No Yaiba S01E01 VOSTFR 1080p WEB H 264 Tsundere Raws (CR) (Multi Subs, Kimetsu No Yaiba)',
      magnet: `magnet:?xt=urn:btih:${OTHER}`,
    },
    // Os dois vazadores: filme da franquia, sem SxxEyy, ano mais NOVO que o catálogo.
    {
      title: 'Demon Slayer Kimetsu No Yaiba Infinity Castle 2025 720p WEB JFF (Nyaasi)',
      magnet: `magnet:?xt=urn:btih:c${'d'.repeat(39)}`,
    },
    {
      title: '[Feibanyama] Demon Slayer Kimetsu No Yaiba Infinity Castle [BILIBILI WebRip 2160p Multi Audio Multi Sub]',
      magnet: `magnet:?xt=urn:btih:e${'f'.repeat(39)}`,
    },
    // Packs com "S01" espaçado do número do episódio (scene release de anime):
    // parseTitleSeasonEpisode reconhece a temporada mesmo sem SxxEyy num token
    // só, então não podem cair na guarda nova.
    {
      title: 'Kimetsu No Yaiba (Demon Slayer) S01 (2160p) (Bilibili)',
      magnet: `magnet:?xt=urn:btih:g${'h'.repeat(39)}`,
    },
    {
      title: '[Trix] Kimetsu No Yaiba S01 03 [Dual Audio] [Multi Subs] (BD 720p AV1) Demon Slayer VOSTFR',
      magnet: `magnet:?xt=urn:btih:i${'j'.repeat(39)}`,
    },
    {
      title: '[Trix] Kimetsu No Yaiba S01 05 [Dual Audio] [Multi Subs] (BD 1080p AV1) Demon Slayer VOSTFR (Batch)',
      magnet: `magnet:?xt=urn:btih:k${'l'.repeat(39)}`,
    },
  ];

  const out = relevantRaw(itens, {
    names: ['Demon Slayer: Kimetsu no Yaiba', 'Kimetsu no Yaiba'],
    year: 2019,
    isSeries: true,
    season: 1,
    episode: 1,
  });

  assert.equal(out.filter((i: RawItem) => /Infinity Castle/i.test(i.title || '')).length, 0, 'nenhum Infinity Castle pode sobrar');
  assert.equal(out.length, 5, 'BR dublada + S01E01 + 3 packs S01-espaçado');

  // Não-regressão: na busca de FILME (season/episode nulos), o mesmo título
  // do filme continua entrando — a guarda só roda com episódio pedido.
  const comoFilme = relevantRaw(
    [{ title: 'Demon Slayer Kimetsu No Yaiba Infinity Castle 2025 720p WEB JFF (Nyaasi)', magnet: `magnet:?xt=urn:btih:${HASH}` }],
    { names: ['Demon Slayer: Kimetsu no Yaiba Infinity Castle'], year: 2025, isSeries: false },
  );
  assert.equal(comoFilme.length, 1, 'o filme continua entrando na própria busca de filme');
});

test('matchesGlobalSeriesNoMarker: pack "S01 03" com grupo de release fora do universo continua passando', () => {
  const tokens = 'trix kimetsu no yaiba s01 03 dual audio multi subs bd 720p av1 demon slayer vostfr'.split(' ');
  const universe = 'demon slayer kimetsu no yaiba'.split(' ');
  assert.equal(
    matchesGlobalSeriesNoMarker('[Trix] Kimetsu No Yaiba S01 03 [Dual Audio] [Multi Subs] (BD 720p AV1) Demon Slayer VOSTFR', tokens, universe),
    true,
    'parseTitleSeasonEpisode acha a temporada em "S01 03" e a guarda nem mede precisão',
  );
});

test('matchesGlobalSeriesNoMarker: filme da franquia sem marcador nenhum é rejeitado pela precisão', () => {
  const tokens = 'demon slayer kimetsu no yaiba infinity castle 2025 720p web jff'.split(' ');
  const universe = 'demon slayer kimetsu no yaiba'.split(' ');
  assert.equal(matchesGlobalSeriesNoMarker('Demon Slayer Kimetsu No Yaiba Infinity Castle 2025 720p WEB JFF', tokens, universe), false);
});

test('série global: guarda de ano com a tolerância de temporada', () => {
  // A regra é a mesma que o caminho BR já aplicava via matchesTitleStructure:
  // só condena quando TODOS os anos do título são anteriores à estreia −2 —
  // o ano do post de série é o da temporada. Agora vale no caminho global.
  const itens = [
    { title: 'The Walking Dead S01 1080p BluRay', magnet: `magnet:?xt=urn:btih:${HASH}` }, // sem ano: passa
    { title: 'The Walking Dead 2011 S01 COMPLETE', magnet: `magnet:?xt=urn:btih:${OTHER}` }, // 2011 >= 2008: passa
    { title: 'The Walking Dead 2003 S01 DVDRip', magnet: `magnet:?xt=urn:btih:c${'d'.repeat(39)}` }, // tudo antes de 2008: corta
    { title: 'The Walking Dead 2005 2012 S01', magnet: `magnet:?xt=urn:btih:e${'f'.repeat(39)}` }, // um ano recente libera
    { title: 'The Walking Dead 1999 2005 S01', magnet: `magnet:?xt=urn:btih:g${'h'.repeat(39)}` }, // todos antigos: corta
  ];
  const out = relevantRaw(itens, {
    names: ['The Walking Dead'],
    year: '2010–',
    isSeries: true,
    season: 1,
    episode: 1,
  });
  assert.deepEqual(
    out.map((i: RawItem) => i.title),
    ['The Walking Dead S01 1080p BluRay', 'The Walking Dead 2011 S01 COMPLETE', 'The Walking Dead 2005 2012 S01'],
  );
});

test('filtro relevante cru: lixo não segura o fallback de pack', () => {
  const ctx = { names: ['Fallout'], year: 2024, isSeries: true, season: 1, episode: 1 };
  // Post "parecido" que o filtro estrito já derruba: zero relevante, pack dispara.
  assert.deepEqual(
    relevantRaw([{ title: 'Missão: Impossível – Efeito Fallout S01E01 1080p', isBr: true }], ctx),
    [],
  );
  // Spin-off do Rick and Morty: mesmo prefixo, mesmo ano, temporada certa.
  // O filtro compartilhado precisa rejeitá-la para liberar o fallback do pack.
  assert.deepEqual(
    relevantRaw(
      [{ title: 'Rick e Morty: O Anime 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', isBr: true }],
      { names: ['Rick and Morty', 'Rick e Morty'], year: 2024, isSeries: true, season: 1, episode: 1 },
    ),
    [],
  );
});

test('filtro relevante cru: release certa impede o fallback de pack', () => {
  const ctx = {
    names: ['House of the Dragon', 'A Casa do Dragão'],
    year: 2022,
    isSeries: true,
    season: 1,
    episode: 2,
  };
  const relevantes = [
    { title: 'House of the Dragon S01E02.The Rogue Prince  HMAX  DDP5.1.x264 NTb 1080p', isBr: true },
    { title: '1A TEMPORADA COMPLETA      House of the Dragon S01. HMAX  DDP5.1.Atmos x264 SMURF 1080p', isBr: true },
  ];
  assert.equal(relevantRaw(relevantes, ctx).length, 2);
});

test('filtro relevante cru rejeita spin-off global por episódio', () => {
  const ctx = {
    names: ['Rick and Morty', 'Rick e Morty'],
    year: 2013,
    isSeries: true,
    season: 1,
    episode: 2,
  };
  const items = [
    { title: 'Rick And Morty The Anime S01E02 720p HEVC' },
    { title: 'Rick and Morty S01E02.The Vat of Acid Episode 1080p WEB-DL' },
  ];
  assert.deepEqual(relevantRaw(items, ctx), [items[1]]);
});

test('identidade global preserva série curta e sufixo regional', () => {
  const cases: Array<[string, string[]]> = [
    ['S01E02.From.1080p.WEBRip.x264-EVOLVE', ['From']],
    ['S01E02.The.Bear.1080p.WEBRip.x264-EVOLVE', ['The Bear']],
    ['S01E02.Shogun.1080p.WEBRip.x264-GROUP', ['Shogun']],
    ['The Office US S01E02 1080p WEB-DL', ['The Office']],
  ];
  for (const [title, names] of cases) {
    assert.equal(relevantRaw([{ title }], {
      names, isSeries: true, season: 1, episode: 2,
    }).length, 1, title);
  }
});

test('filtro relevante cru: série não trata temporada como sequência de filme', () => {
  // "Round 6 2ª Temporada": em série o número antes do ruído é a TEMPORADA, não
  // a sequência da franquia. A regra nova de filme não pode vazar para série,
  // senão a 2ª temporada some da lista do S02E01.
  const item = { title: 'Round 6 2ª Temporada (2025) WEB-DL 1080p DUBLADO' };
  assert.deepEqual(
    relevantRaw([item], {
      names: ['Round 6', 'Squid Game', 'Round Six'],
      year: 2025,
      isSeries: true,
      season: 2,
      episode: 1,
    }),
    [item],
  );
});

