// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// filtro relevante cru no caminho de FILME — alias degenerado (CJK),
// sequências da franquia, corpus real BR/TPB do Scary Movie, numeral e
// grafias de versão estendida.
import { test } from 'node:test';
import assert from 'node:assert';
import { filterRelevantRaw as relevantRaw } from '../src/utils/format.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);



// Caminho GLOBAL de filme: `matchesName` aprova QUALQUER sequência da franquia
// ("Scary Movie 2" cobre 2/2 tokens de "Scary Movie") e até outra obra que só
// cita as duas palavras da busca ("Titanic 2000 (Scary Sexy Disaster Movie)").
// O filtro BR estrito tem regra de sequência + prefixo + ano (`matchesBrTitle`);
// o global não tinha nenhuma — a sequência entrava na lista do filme certo e o
// usuário via o 2/3/4 antes do original.
test('filtro relevante cru: filme global descarta sequência e obra parecida', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const items = [
    { title: 'Scary Movie 2 (2001) 1080p BluRay' },
    { title: 'Scary Movie 3 (2003) 720p WEB-DL' },
    { title: 'Scary Movie 4 (2006) 1080p x264' },
    { title: 'Scary Movie II 720p HDRip' },
    { title: 'Scary Movie Part Two 1080p BluRay' },
    // Paródia de 1999 que só cita as palavras: começa em "Titanic", não no nome
    // procurado, e o ano denuncia outra obra — o global não conferia nenhum dos
    // dois e a deixava competir com o original de 2000.
    { title: 'Titanic 2000 (Scary Sexy Disaster Movie) 1999 DVDRip' },
  ];
  for (const item of items) {
    assert.deepEqual(relevantRaw([item], ctx), [], item.title);
  }
});

// A contraparte do descarte: o ORIGINAL com tags de indexer (YTS.MX, x264), o
// alias pt-BR e o pack de coleção sem número explícito continuam passando. Tag
// de release e palavra de empacotamento não podem virar "sequência" na regra
// nova.
test('filtro relevante cru: filme global mantém original, alias e coleção', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const items = [
    { title: 'Scary Movie (2000) 1080p YTS.MX' },
    { title: 'Scary Movie 2000 x264-RARBG' },
    { title: 'Todo Mundo em Pânico (2000) Dublado 720p' },
    { title: 'Todo Mundo em Pânico Coleção Completa BluRay 1080p Dublado' },
  ];
  for (const item of items) {
    assert.equal(relevantRaw([item], ctx).length, 1, item.title);
  }
});

test('filtro relevante cru: artigo inicial do release não desliga o filme global', () => {
  // A regra de prefixo nova compara o primeiro token RELEVANTE; crua, ela
  // reprova release que abre com artigo quando o alias não o carrega — "The
  // Hulk" contra a busca "Hulk" tem primeiro token 'the' x 'hulk'. Artigo é
  // ruído do release, não outra obra: "The"/"La" não podem condenar a release
  // certa nem quando o alias omite o artigo.
  const cases: Array<{ title: string; names: string[]; year: number }> = [
    { title: 'The Hulk (2003) 1080p BluRay', names: ['Hulk'], year: 2003 },
    { title: 'The Green Mile (1999) 1080p WEB-DL', names: ['Green Mile'], year: 1999 },
    { title: 'La Vie est Belle (1997) 720p DVDRip', names: ['Vie est Belle'], year: 1997 },
  ];
  for (const { title, names, year } of cases) {
    assert.equal(
      relevantRaw([{ title }], { names, year, isSeries: false }).length,
      1,
      title,
    );
  }
});

// Títulos reais do Jackett/ThePirateBay numa busca por "Scary Movie 2000": o
// REMUX, o YTS e as coleções da franquia (que CONTÊM o filme pesquisado) são
// relevantes; o "Scary Movie 2" é outra obra e a paródia de 1999 só cita as
// palavras. O contrato cru tem que separar os dois lados sem gastar rede.
test('filtro relevante cru: títulos reais do Jackett/TPB para Scary Movie 2000', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const keep = [
    'Scary Movie 2000 REPACK BluRay 1080p DTS-HD MA 5 1 AVC HYBRID REMUX-FraMeST',
    'Scary Movie (2000) 720p BRRip x264 -YTS',
    // Packs com "Collection"/"Complete" casam como prefixo via STOP_AT.
    'Scary Movie Collection 1-5 2000-2013 720p BluRay x264 Mkvking',
  ];
  const drop = [
    // 1-5 vira tokens "1","5"; extractSequenceMarkers lê "5" como sequência
    // antes de chegar à stop word "Collection" — falso positivo em "Scary Movie 5".
    'Scary Movie 1-5 Collection 2000-2013 1080p BluRay HEVC x265 5.1 BONE',
    'Scary Movie 2 2001 1080p BluRayRip Opus 5 1 x265-Lootera',
    'Titanic 2000 (Scary Sexy Disaster Movie) 1999 [DvdRip ENG]',
  ];
  for (const title of keep) {
    assert.equal(relevantRaw([{ title }], ctx).length, 1, title);
  }
  for (const title of drop) {
    assert.deepEqual(relevantRaw([{ title }], ctx), [], title);
  }
});

test('filtro relevante cru: artigo tolerado não abre obra diferente com ano', () => {
  // "The Suicide Squad (2021)" é OUTRO filme, não o de 2016: tolerar o artigo
  // inicial no prefixo não pode deixá-lo entrar — o ano tem que cortar.
  const item = { title: 'The Suicide Squad (2021) 1080p BluRay' };
  assert.deepEqual(
    relevantRaw([item], { names: ['Suicide Squad'], year: 2016, isSeries: false }),
    [],
  );
});

// Corpus real dos sites BR (scraper do Jackett) numa busca por "Scary Movie
// 2000": os packs de coleção, o filme certo e até o título com artigo solto
// ("A Todo Mundo em Pânico") são a obra procurada; o balde de 82 filmes, as
// sequências 2/4 e o "Missão: Impossível –" são outra coisa. A via BR passa
// pelo matchesBrTitle estrito, e o contrato cru tem que separar os dois lados.
test('filtro relevante cru: corpus real BR dublado do Scary Movie 2000', () => {
  const ctx = { names: ['Scary Movie', 'Todo Mundo em Pânico'], year: 2000, isSeries: false };
  const keep = [
    'Coleçao Todo Mundo Em Pânico – – Blu-Ray (2000-2013) [720p BLU-RAY DUBLADO 1.28 GB]',
    'Coleçao Todo Mundo Em Pânico – – Blu-Ray (2000-2013) [DUBLADO opção 2]',
    'Todo Mundo em Pânico: Coleção (2000 a 2013) [1080p LEGENDADO 6.19 GB]',
    'Todo Mundo em Pânico (2000) [1080p LEGENDADO 2.30 GB]',
    'A Todo Mundo em Pânico (2000) Dublado',
  ];
  const drop = [
    '82 Filmes em Bluray Dual Audio (2012-2013-2014-2015) [720p BLURAY DUBLADO 1 GB]',
    'Todo Mundo em Pânico 2 (2001) Dublado 1080p',
    'Todo Mundo em Pânico 4 (2006) Legendado',
    'Missão: Impossível – Todo Mundo em Pânico (2000)',
  ];
  for (const title of keep) {
    assert.equal(relevantRaw([{ title, isBr: true }], ctx).length, 1, title);
  }
  for (const title of drop) {
    assert.deepEqual(relevantRaw([{ title, isBr: true }], ctx), [], title);
  }
});

test('filtro relevante cru: filme pedido COM numeral continua casando', () => {
  // O nome procurado JÁ carrega a sequência ("Deadpool 2" contra release
  // "Deadpool 2"). A regra de sequência compara contra o que a busca pediu —
  // condenar número solto mataria qualquer filme cujo título tem sequência no
  // próprio nome.
  const ctx = { names: ['Deadpool 2'], year: 2018, isSeries: false };
  const item = { title: 'Deadpool 2 (2018) 1080p WEB-DL x264' };
  assert.deepEqual(relevantRaw([item], ctx), [item]);
});

test('filtro BR aceita a release arábica descoberta pelo título romano', () => {
  const context = {
    names: ['Jornada nas Estrelas II: A Ira de Khan', 'Star Trek II: The Wrath of Khan'],
    year: 1982,
    isSeries: false,
  };
  const items = relevantRaw([
    {
      title: 'Jornada nas Estrelas 2 A Ira de Khan 1982 DUBLADO 720p',
      isBr: true,
    },
  ], context);
  assert.equal(items.length, 1);
});

test('filtro de release aceita grafias de versão estendida e extendida', () => {
  const context = {
    names: ['Três Homens em Conflito', 'The Good, the Bad and the Ugly'],
    year: 1966,
    isSeries: false,
  };
  const items = relevantRaw([
    {
      title: 'Três Homens em Conflito Versão Extendida 1966 BluRay 1080p Dual Áudio',
      isBr: true,
    },
    {
      title: 'Três Homens em Conflito Extendida 1966 BluRay 720p Dublado',
      isBr: true,
    },
    {
      title: 'Três Homens em Conflito Versão Estendida 1966 1080p Dual',
      isBr: true,
    },
  ], context);
  assert.equal(items.length, 3);
});

