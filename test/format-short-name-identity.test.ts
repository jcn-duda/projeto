// Identidade do nome de base curta (medido em 2026-09-28, tt1520211).
//
// A COBERTURA (`matchesName`) mede a base EFETIVA do nome — o conjunto
// deduplicado que sobrevive ao filtro de artigo/palavra curta. Quando essa base
// tem um ou dois tokens, o corte de 0,6 não discrimina: um token pede 1/1 e
// dois pedem 2/2, e o que falta é distinguir "a obra começa aqui" de "o nome
// está no meio do título de outra obra". Medido em "The Boys": "The Hardy Boys
// S01 1080p" e "Detective Conan Movie 22 The Detective Boys" entravam na
// lista, e "Trailer Park Boys" escapava do mesmo furo sempre que o índice
// publicasse o artigo no nome.
//
// Posição não é prova suficiente, e o arquivo trava os três limites: (1) só
// nega quando o token que antecede o nome é LATINO e não é rótulo/ruído/marca/
// uploader — outro script é título localizado e passa; (2) o `dn=` real do
// magnet é evidência alternativa CORRETA, como o ano e a temporada
// contraditórios; (3) nome sem token comparável (It, Up, Oz, alias CJK) não
// ganha passe livre: a cobertura segue sendo a decisão, e nome degenerado
// continua fail-closed. O caminho BR não muda: `matchesBrTitle` tem portão
// próprio.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  filterRelevantRaw as relevantRaw,
  filterInventoryRelevant,
  matchesName,
  matchesShortNameIdentity,
  shortNameIdentity,
  nameCoverageTokens,
} from '../src/utils/format.js';
import type { RawItem } from '../types/domain.js';

const BOYS = { names: ['The Boys'], year: 2019, isSeries: true };
const withDn = (title: string, dn: string) => ({
  title,
  magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=${dn}`,
});

// Todo shape de pedido: o furo era o MESMO nos três, e pack/série inteira é
// justamente onde nenhuma guarda antiga rodava.
const SHAPES: Array<[string, { season: number | null; episode: number | null }]> = [
  ['episódio S04E01', { season: 4, episode: 1 }],
  ['pacote de temporada', { season: 4, episode: null }],
  ['série inteira', { season: null, episode: null }],
];

const HOMONIMOS = [
  'Trailer.Park.Boys.S01.1080p.WEB-DL.x264',
  'Trailer Park Boys S01-S13 COMPLETE 1080p',
  'The.Hardy.Boys.S01.1080p.WEB-DL',
  // `dn` real nomeando OUTRA obra: prova alternativa não vale quando contradiz.
  'The.Hardy.Boys.S01.1080p.WEB-DL.The.Boys.S04E01.1080p.AMZN.WEB-DL',
  'Detective.Conan.Movie.22.The.Detective.Boys.1080p',
  'Detective Conan The Detective Boys S01 1080p',
  'HBO The Boys S04E01 1080p', // rede como prefixo, sem dn: não há prova de identidade
];

const LEGITIMOS = [
  'The.Boys.S04E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb',
  'The.Boys.S04.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb',
  'The.Boys.S01-S04.COMPLETE.1080p.WEB-DL',
  'The Boys Complete Series S01-S04 1080p',
  'The.Boys.2019.S04.1080p.AMZN.WEB-DL',
  'The Boys S04E01.Winning.Time.1080p',
  'The Boys Season 4 Complete 1080p',
];

test('homônimo de 2 tokens não entra em "The Boys" em nenhum shape de pedido', () => {
  for (const [shape, req] of SHAPES) {
    for (const title of HOMONIMOS) {
      const out = relevantRaw([{ title }], { ...BOYS, ...req });
      assert.equal(out.length, 0, `${shape}: ${title}`);
    }
  }
});

test('a release legítima de "The Boys" continua entrando em todos os shapes', () => {
  for (const [shape, req] of SHAPES) {
    for (const title of LEGITIMOS) {
      const out = relevantRaw([{ title }], { ...BOYS, ...req });
      assert.equal(out.length, 1, `${shape}: ${title}`);
    }
  }
});

test('homônimo é cortado com motivo de título, não de episódio', () => {
  // O release traz S01, que cobre a temporada pedida: o corte por episódio
  // deixaria passar, e o motivo no ledger prova que quem rejeitou foi o
  // portão de identidade — o mesmo que mata o item nos três shapes.
  const rejeitados: Array<{ item: RawItem; reason: string }> = [];
  const item = { title: 'The.Hardy.Boys.S01.1080p.WEB-DL' };
  const out = relevantRaw([item], { ...BOYS, season: 1, episode: 2 }, (i, reason) =>
    rejeitados.push({ item: i, reason }),
  );
  assert.equal(out.length, 0);
  assert.equal(rejeitados.length, 1);
  assert.equal(rejeitados[0].reason, 'title');
});

test('a cobertura sozinha não separava os homônimos (o furo medido)', () => {
  // Fica explícito o que a regra conserta: a COBERTURA aprova os casos em que
  // a base do nome tem 1–2 tokens, e a identidade é que nega.
  const check = shortNameIdentity('The Boys');
  for (const title of ['The.Hardy.Boys.S01.1080p.WEB-DL', 'Detective Conan The Detective Boys S01 1080p']) {
    assert.equal(matchesName(title, 'The Boys'), true, `cobertura: ${title}`);
    assert.equal(matchesShortNameIdentity(title, check), false, `identidade: ${title}`);
  }
  assert.equal(matchesName('Trailer.Park.Boys.S01.1080p', 'The Boys'), false, 'sem artigo, a cobertura já corta');
});

test('controle: homônimos vizinhos seguem rejeitados', () => {
  // Já vinham cortados pela cobertura (faltava o artigo); viram trava de
  // regressão para o portão novo não abrir brecha nos nomes parecidos.
  for (const title of [
    'Random Boys S01E01 1080p',
    'Terrace House Boys S01E01 1080p',
    'The Boys Presents Diabolical S01E01 1080p',
  ]) {
    assert.equal(relevantRaw([{ title }], { ...BOYS, season: 1, episode: 1 }).length, 0, title);
  }
});

test('controle: a mesma classe com outros nomes de base curta', () => {
  // Mesma estrutura, nomes diferentes: "Shes The Boss" e "Thirst Trap … The
  // Fallout" embutem o nome procurado como CAUDA de outra obra.
  const casos: Array<[string[], string]> = [
    [['The Boss'], 'Shes The Boss S01E01 1080p'],
    [['The Fallout'], 'Thirst Trap The Fallout S01E01 1080p'],
    // Base de UM token: a cobertura vira 1/1 e aceitaria qualquer título com a
    // palavra — a identidade volta a ser a única prova.
    [['Fallout'], 'Thirst Trap The Fallout S01E01 1080p'],
  ];
  for (const [names, title] of casos) {
    const out = relevantRaw([{ title }], { names, isSeries: true, season: 1, episode: 1 });
    assert.equal(out.length, 0, `${names} × ${title}`);
    assert.equal(relevantRaw([{ title }], { names, isSeries: true, season: 1 }).length, 0, `pack: ${names} × ${title}`);
  }
  // "Hawaii Five O" é cortada pela GUARDA DE PRECISÃO de sempre (três
  // significativos na cabeça contra uma palavra procurada), não pelo portão
  // novo — a posição casaria. Anotado para o caso não virar "regressão".
  assert.equal(matchesShortNameIdentity('Hawaii Five O S01E01 1080p WEB-DL x264', shortNameIdentity('Hawaii')), true);
});

test('controle: a obra que começa pelo nome continua entrando', () => {
  // O portão é a IDENTIDADE, não uma lista de obras proibidas: o mesmo padrão
  // "X…" que rejeita o homônimo aceita a obra procurada. Cada caso traz o
  // episódio que pede.
  const casos: Array<[string[], string, number]> = [
    [['Fallout'], 'Fallout.S01E01.1080p.AMZN.WEB-DL', 1],
    [['Bones'], 'Bones.S01E01.1080p.HDTV.X264', 1],
    [['The Bear'], 'S01E02.The.Bear.1080p.WEBRip.x264-EVOLVE', 2],
    [['The Office'], 'The.Office.US.S01E02.1080p.WEB-DL', 2],
    [['From'], 'S01E02.From.1080p.WEBRip.x264-EVOLVE', 2],
    [['Shogun'], 'Shogun.S01E01.1080p.AMZN.WEB-DL', 1],
    [['Gen V'], 'Gen.V.S01E01.1080p.AMZN.WEB-DL', 1],
  ];
  for (const [names, title, episode] of casos) {
    const out = relevantRaw([{ title }], { names, isSeries: true, season: 1, episode });
    assert.equal(out.length, 1, `${names} × ${title}`);
  }
});

test('o portão pula ruído, artigo, marcador e etiqueta de uploader antes do nome', () => {
  const casos: Array<[string, string]> = [
    ['AMZN.The.Boys.S04E01.1080p.WEB-DL', 'The Boys'],
    ['[TGx] The Boys S04E01 1080p', 'The Boys'],
    ['www.UIndex.org - The Boys S05E01 2160p AMZN WEB-DL DDP', 'The Boys'],
    ['S04E01.The.Boys.1080p.WEB-DL', 'The Boys'],
    ['TV.The.Boys.Season.4.1080p', 'The Boys'],
    ['The.Boys.1080p.WEB-DL.x264', 'The Boys'],
  ];
  for (const [title, name] of casos) {
    assert.equal(matchesShortNameIdentity(title, shortNameIdentity(name)), true, title);
  }
});

test('prefixo em outro script é título localizado, não outra obra', () => {
  // Halo e Attack on Titan: a release traz o título localizado antes do
  // inglês. A escrita em outro script NÃO prova outra obra, então o portão
  // cala e a cobertura decide. (Medido: o portão aceita o prefixo CJK mesmo
  // com o par SxxEyy; o corte eventual nesse formato vem da
  // `matchesEpisodeWorkIdentity` de sempre, que conta o token localizado como
  // conteúdo estranho — furo PRÉ-EXISTENTE, fora deste portão.)
  const aceitaNoPortao: Array<[string[], string]> = [
    [['Halo'], '光環特攻隊.Halo.S01E01.1080p.NF.WEB-DL.DDP5.1.x264-NTb'],
    [['Halo', '光环'], '光環特攻隊.Halo.S01E01.1080p.NF.WEB-DL'],
    [['Attack on Titan'], '進撃の巨人.Attack.on.Titan.S01E01.1080p'],
    [['The Boys'], '黑袍纠察队.The.Boys.S04E01.1080p.AMZN.WEB-DL'],
  ];
  for (const [names, title] of aceitaNoPortao) {
    assert.equal(matchesShortNameIdentity(title, shortNameIdentity(names[0])), true, `portão: ${names[0]} × ${title}`);
  }
  // E o filtro aceita o formato que a precisão de sempre já deixava passar
  // (sem o par SxxEyy no título), com o prefixo localizado na frente.
  const peloFiltro: Array<[string[], string]> = [
    [['Halo'], '光環特攻隊.Halo.S01.1080p.NF.WEB-DL'],
    [['Halo', '光环'], '光環特攻隊.Halo.S01.1080p.NF.WEB-DL'],
    [['Attack on Titan'], '進撃の巨人.Attack.on.Titan.S01.1080p'],
  ];
  for (const [names, title] of peloFiltro) {
    const out = relevantRaw([{ title }], { names, isSeries: true, season: 1 });
    assert.equal(out.length, 1, `${names} × ${title}`);
  }
});

test('dn real é evidência alternativa de identidade', () => {
  // Release cuja etiqueta do post não nomeia a obra (rede, grupo) e cujo
  // torrent real nomeia: o `dn` vale como prova, na mesma linhagem do ano e da
  // temporada contraditórios. Sem o `dn` (ou com `dn` de outra obra) o corte
  // continua — leitura fail-closed do item sem evidência de nome.
  const casos: Array<[string[], string, string, { season: number; episode: number | null }]> = [
    [['Game of Thrones'], 'HBO Game of Thrones S01E01 1080p WEB-DL', 'Game.of.Thrones.S01E01.1080p.WEB-DL', { season: 1, episode: 1 }],
    [['Game of Thrones'], 'HBO Game of Thrones S01 1080p WEB-DL', 'Game.of.Thrones.S01.1080p.WEB-DL', { season: 1, episode: null }],
    [['Wednesday'], 'Netflix Wednesday S01 1080p NF WEB-DL', 'Wednesday.S01.1080p.NF.WEB-DL.DDP5.1', { season: 1, episode: null }],
    [['The Boys'], 'SubsPlease The Boys S04 1080p', 'The.Boys.S04.1080p.AMZN.WEB-DL.DDP5.1', { season: 4, episode: null }],
    [['One Piece'], '[NanakoRaws] One Piece S01E1176 (BS8 TV 1080p HEVC AAC)', 'One.Piece.S01E1176.1080p', { season: 1, episode: 1176 }],
  ];
  for (const [names, title, dn, req] of casos) {
    const out = relevantRaw([withDn(title, dn)], { names, isSeries: true, ...req });
    assert.equal(out.length, 1, `${names} × ${title}`);
  }
  // Contraprova: `dn` de OUTRA obra não vale como prova, e sem `dn` também não —
  // o post que não nomeia a obra não ganha passe por omissão. (Nome de UM token
  // que nomeia: "Game of Thrones" inteiro no título já entra pela sequência.)
  const errado = withDn('HBO The Boys S04E01 1080p WEB-DL', 'Detective.Conan.Movie.22.The.Detective.Boys.1080p');
  assert.equal(relevantRaw([errado], { names: ['The Boys'], isSeries: true, season: 4, episode: 1 }).length, 0);
  assert.equal(
    relevantRaw([{ title: 'HBO The Boys S04E01 1080p WEB-DL' }], { names: ['The Boys'], isSeries: true, season: 4, episode: 1 }).length,
    0,
  );
  // Sequência inteira de 2+ tokens que nomeiam: a rede na frente não contradiz.
  assert.equal(
    relevantRaw([{ title: 'HBO Game of Thrones S01E01 1080p WEB-DL' }], {
      names: ['Game of Thrones'],
      isSeries: true,
      season: 1,
      episode: 1,
    }).length,
    1,
  );
});

test('marcador de episódio composto e longo não é prefixo de conteúdo', () => {
  // "S01E01E02" (intervalo publicado) e "E1176"/"S01E1176" (One Piece passou de
  // E999) são ESTRUTURA, e o acervo real escreve os dois — inclusive na frente
  // do nome. O EPISODE_TOKEN global (calibrado com e{1,3}) não os cobre, e
  // mexer nele mudaria a precisão e o parse; o padrão é do scan de identidade.
  const casos: Array<[string, string, { season: number; episode: number | null }]> = [
    ['S01E01E02.One.Piece.1080p', 'One Piece', { season: 1, episode: null }],
    ['S01E1176 One Piece 1080p HEVC', 'One Piece', { season: 1, episode: 1176 }],
    ['One.Piece.S01E1176.1080p.BS5.TV', 'One Piece', { season: 1, episode: 1176 }],
    ['S04E01.The.Boys.1080p.WEB-DL', 'The Boys', { season: 4, episode: 1 }],
  ];
  for (const [title, name, req] of casos) {
    assert.equal(matchesShortNameIdentity(title, shortNameIdentity(name)), true, `portão: ${title}`);
    const out = relevantRaw([{ title }], { names: [name], isSeries: true, ...req });
    assert.equal(out.length, 1, `filtro: ${title}`);
  }
});

test('"Game of Thrones": base efetiva de dois tokens, e o portão não atrapalha', () => {
  // O critério é a base EFETIVA (artigo e palavra de 1–2 letras saem quando
  // sobram dois tokens longos): aqui são `game` + `thrones` — o portão vale, e
  // os formatos legítimos de série, pack e derivado continuam como antes.
  assert.deepEqual(nameCoverageTokens('Game of Thrones'), ['game', 'thrones']);
  assert.deepEqual(shortNameIdentity('Game of Thrones'), { kind: 'prefix', want: 'game', run: ['game', 'thrones'] });
  const ctx = { names: ['Game of Thrones'], isSeries: true, season: 1, episode: 1 };
  for (const title of [
    'Game of Thrones S01E01 1080p WEB-DL x264',
    'Game.of.Thrones.S01.1080p.COMPLETE',
    'Game of Thrones Season 1 1080p BluRay x264',
    'S01E01.Game.of.Thrones.1080p.WEB-DL',
  ]) {
    assert.equal(relevantRaw([{ title }], ctx).length, 1, title);
  }
  // O derivado de 2019 é outra obra e continua cortado, pela guarda que já
  // existia (precisão) — não pelo portão novo, que casaria pela posição.
  assert.equal(
    matchesShortNameIdentity('Game of Thrones: The Last Watch S01E01 1080p', shortNameIdentity('Game of Thrones')),
    true,
  );
  assert.equal(relevantRaw([{ title: 'Game of Thrones: The Last Watch S01E01 1080p' }], ctx).length, 0);
});

test('nome sem token comparável: abstém sem virar passe livre', () => {
  // Base curta SEM token latino (palavra de 1–2 letras ou alias em outro
  // script): não há prova posicional possível, então o portão se cala e a
  // cobertura segue decidindo. O que NÃO pode acontecer é o estado virar
  // "identidade verificada" nem o filtro inteiro parar de cortar.
  for (const name of ['It', 'Up', 'Oz', '光环']) {
    assert.equal(shortNameIdentity(name).kind, 'no-token', name);
    assert.equal(matchesShortNameIdentity('Qualquer Coisa S01E01 1080p', shortNameIdentity(name)), true, name);
  }
  // A release legítima desses nomes continua entrando pela cobertura exata.
  const entra = relevantRaw(
    [
      { title: 'It.S01E01.1080p.WEB-DL' },
      { title: 'Up.S01E01.720p.HULU' },
      { title: 'Oz.S01E01.1080p.HBO' },
      { title: '光环.S01E01.1080p.NF.WEB-DL' },
    ],
    { names: ['It', 'Up', 'Oz', '光环'], isSeries: true, season: 1, episode: 1 },
  );
  assert.equal(entra.length, 4);
  // E um alias degenerado/localizado no MESMO conjunto não desarma o portão
  // do outro nome: o homônimo continua cortado.
  const homonimo = { title: 'The.Hardy.Boys.S01.1080p.WEB-DL' };
  assert.equal(relevantRaw([homonimo], { names: ['光环', 'The Boys'], isSeries: true, season: 1 }).length, 0);
  // Nome degenerado continua fail-closed pela cobertura (nada casa).
  assert.equal(matchesName('qualquer coisa', '??'), false);
  assert.equal(
    relevantRaw([{ title: 'Qualquer Coisa S01E01 1080p' }], { names: ['??'], isSeries: true, season: 1 }).length,
    0,
  );
});

test('estados da decisão: a régua é a base efetiva, não o nome cru', () => {
  assert.deepEqual(nameCoverageTokens('The Boys'), ['the', 'boys']);
  assert.deepEqual(nameCoverageTokens('Hawaii'), ['hawaii']);
  assert.deepEqual(nameCoverageTokens('Rick and Morty'), ['rick', 'and', 'morty']);
  assert.deepEqual(nameCoverageTokens('The Walking Dead: Dead City'), ['walking', 'dead', 'city']);
  assert.deepEqual(shortNameIdentity('The Boys'), { kind: 'prefix', want: 'boys', run: ['boys'] });
  assert.deepEqual(shortNameIdentity('Gen V'), { kind: 'prefix', want: 'gen', run: ['gen'] });
  assert.equal(shortNameIdentity('Rick and Morty').kind, 'skip', 'base de 3 tokens se abstém');
  assert.equal(shortNameIdentity('The Walking Dead: Dead City').kind, 'skip');
  assert.equal(shortNameIdentity('??').kind, 'skip', 'base vazia: matchesName nega antes');
  assert.equal(shortNameIdentity('').kind, 'skip');
});

test('nome longo não muda: a cobertura já discrimina e o portão se abstém', () => {
  assert.equal(
    matchesShortNameIdentity('The Walking Dead Dead City S01 480p', shortNameIdentity('The Walking Dead: Dead City')),
    true,
  );
  assert.equal(
    matchesShortNameIdentity('Rick And Morty The Anime S01E02 720p HEVC', shortNameIdentity('Rick and Morty')),
    true,
  );
  assert.equal(
    relevantRaw([{ title: 'The Walking Dead Dead City S01 480p' }], {
      names: ['The Walking Dead: Dead City'],
      isSeries: true,
      season: 1,
      episode: 1,
    }).length,
    1,
    'pack de temporada de nome longo continua entrando',
  );
});

test('o caminho BR não muda: o post estrito tem o seu próprio portão', () => {
  // Item BR com nome de base curta cujo portão novo diria não: entra do mesmo
  // jeito, porque `matchesBrTitle` decide antes (prefixo + precisão + ano).
  const br = { title: 'The Boys 4ª Temporada (2024) WEB-DL 1080p Dual Áudio', isBr: true };
  const nomes = ['The Boys', 'Os Caras de Pau'];
  assert.equal(relevantRaw([br], { names: nomes, year: 2019, isSeries: true, season: 4 }).length, 1);
  const brHomonomo = { title: 'The Hardy Boys 1ª Temporada (2020) WEB-DL 1080p Dual Áudio', isBr: true };
  assert.equal(relevantRaw([brHomonomo], { names: nomes, year: 2019, isSeries: true, season: 1 }).length, 0);
});

test('inventário da conta também é protegido (mesmo filtro, sem exceção)', () => {
  const itens: RawItem[] = [
    { title: 'The.Hardy.Boys.S01.1080p.WEB-DL' },
    { title: 'The.Boys.S01.1080p.AMZN.WEB-DL' },
  ];
  const out = filterInventoryRelevant(itens, { ...BOYS, season: 1 });
  assert.deepEqual(out.map((i: RawItem) => i.title), ['The.Boys.S01.1080p.AMZN.WEB-DL']);
});
