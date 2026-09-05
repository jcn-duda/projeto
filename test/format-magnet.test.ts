// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// hash e magnet — extractInfoHash (40 hex e base32), bytesToSize,
// magnetYearContradicts (matriz de bordas ±2) e a guarda de ano do dn=
// integrada ao filterRelevantRaw (caso real "O Corvo").
import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractInfoHash,
  bytesToSize,
  magnetYearContradicts,
  filterRelevantRaw as relevantRaw,
} from '../src/utils/format.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('extractInfoHash aceita hash puro, magnet e base32', () => {
  assert.equal(extractInfoHash(HASH), HASH);
  assert.equal(extractInfoHash(HASH.toUpperCase()), HASH);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${HASH}&dn=x`), HASH);
  assert.equal(extractInfoHash(''), null);
  assert.equal(extractInfoHash(null), null);
  assert.equal(extractInfoHash('nao-eh-hash'), null);
});

// O cliente Stremio só monta magnet com btih de 40 hex: base32 repassado cru
// aparece na lista e não dá play. Caso real visto em release do TorrentDosFilmes.

test('extractInfoHash converte btih base32 para 40 hex', () => {
  const b32 = 'DKYNMQG3OTSHF7TUIUUGDNAKDNPQYFCQ';
  const hex = '1ab0d640db74e472fe74452861b40a1b5f0c1450';
  assert.equal(extractInfoHash(b32), hex);
  assert.equal(extractInfoHash(b32.toLowerCase()), hex);
  assert.equal(extractInfoHash(`magnet:?xt=urn:btih:${b32.toLowerCase()}&dn=x`), hex);
  // 0/1/8/9 não existem no alfabeto base32: não é hash, não vira stream.
  assert.equal(extractInfoHash('DKYNMQG3OTSHF7TUIUUGDNAKDNPQYF01'), null);
});

test('bytesToSize formata unidades e rejeita inválidos', () => {
  assert.equal(bytesToSize(500), '500 B');
  assert.equal(bytesToSize(1073741824), '1.00 GB');
  assert.equal(bytesToSize(0), null);
  assert.equal(bytesToSize('abc'), null);
});

// ---- Ano verdadeiro escondido no dn= do magnet (caso real "O Corvo") ----
// Medido no hdrtorrent em 21/08/2026: posts sem ano no título mapeado
// ("O Corvo The Crow e Dual") entregam magnets de TRÊS filmes — The Crow
// 1994, The Raven 2012 e The Crow 2024 — e os três se chamam "O Corvo" no
// Brasil. Só o dn= do magnet separa as obras.
const MAGNET_CORVO_1994 =
  'magnet:?xt=urn:btih:7L5BM54D772PVXWVTKP6DWNTUJAL6LQG&dn=SITEDETORRENTS.COM..MKV.O%20Corvo%201994%20BluRay%201080p%20x265%20DUAL%202.0';
const MAGNET_CROW_2024 =
  'magnet:?xt=urn:btih:HSAMGJ4JLDVRVWFLCDZHSSATTOR3R5VB&dn=HIDRATORRENTS.ORG..MP4.-LEGENDADO-..The%20Crow%20(2024)%20%5B720p%5D%20%5BWEBRip%5D%20%5BYTS.MX%5D';
const MAGNET_RAVEN_2012 =
  'magnet:?xt=urn:btih:4ae7cc5c2140d659f92d1fb40ce9655a6ae55db4&dn=O+Corvo+%282012%29+BluRay+720p+Dublado';

const corvoDual1994 = {
  title: 'O Corvo The Crow e Dual O CORVO  Dual  X265 BLURAY 1080P 1080p, BluRay',
  isBr: true,
  magnet: MAGNET_CORVO_1994,
};
const corvoSubbed2024 = {
  title: 'O Corvo The Crow e Dual O CORVO  Subbed 5.1  720P 1080p, 2160p, 720p, HD, WEB-DL',
  isBr: true,
  magnet: MAGNET_CROW_2024,
};
const corvoRaven2012 = {
  title: 'O Corvo Dublado BluRay 720p',
  isBr: true,
  magnet: MAGNET_RAVEN_2012,
};

test('filme: ano verdadeiro dentro do dn= separa remake do clássico', () => {
  const nomesCorvo = ['The Crow', 'O Corvo'];

  // Consulta pelo remake de 2024: só o magnet de 2024 sobrevive.
  assert.deepEqual(
    relevantRaw([corvoDual1994, corvoSubbed2024, corvoRaven2012], { names: nomesCorvo, year: '2024' }),
    [corvoSubbed2024],
  );

  // Consulta pelo clássico de 1994: só o de 1994.
  assert.deepEqual(
    relevantRaw([corvoDual1994, corvoSubbed2024, corvoRaven2012], { names: nomesCorvo, year: '1994' }),
    [corvoDual1994],
  );

  // Consulta pelo Poe de 2012 (The Raven é "O Corvo" em pt): os dois Crows
  // caem SÓ pela guarda do dn= — nenhum dos títulos traz ano para julgar.
  assert.deepEqual(
    relevantRaw([corvoDual1994, corvoSubbed2024, corvoRaven2012], { names: ['The Raven', 'O Corvo'], year: '2012' }),
    [corvoRaven2012],
  );
});

test('filme: resolução não é ano; anos múltiplos no dn= são ambíguos e ficam', () => {
  const item = {
    title: 'Filme Qualquer DUAL 1080p BluRay',
    isBr: true,
    magnet: 'magnet:?xt=urn:btih:aabbcc&dn=Filme.Qualquier.2024.1080p.BluRay.x264.1920x1080',
  };
  assert.deepEqual(relevantRaw([item], { names: ['Filme Qualquer'], year: '2024' }), [item]);

  const ambiguo = {
    title: 'Coisa Dual Completa',
    isBr: true,
    magnet: 'magnet:?xt=urn:btih:ddee&dn=Pack.Coisa.1994.e.2024.DUAL',
  };
  assert.deepEqual(relevantRaw([ambiguo], { names: ['Coisa'], year: '2024' }), [ambiguo]);
});

test('série não sofre a guarda de ano pelo dn= (ano do post é o da temporada)', () => {
  const serie = {
    title: 'Serie Tal S01E01',
    isBr: false,
    magnet: 'magnet:?xt=urn:btih:ff11&dn=Serie.Tal.1994.S01E01.720p',
  };
  assert.deepEqual(
    relevantRaw([serie], { names: ['Serie Tal'], year: '2011', isSeries: true, season: 1, episode: 1 }),
    [serie],
  );
});

// -----------------------------------------------------------------------------
// T1 (Tarefa 3.1): Guarda de Ano no Magnet (magnetYearContradicts)
// -----------------------------------------------------------------------------
test('magnetYearContradicts: matriz completa de bordas e tolerância ±2 anos', () => {
  const mkItem = (dn: string) => ({
    magnet: `magnet:?xt=urn:btih:${HASH}&dn=${encodeURIComponent(dn)}`,
    title: 'Post sem ano no titulo',
  });

  // 1. Diferença 0: ano idêntico -> aceito (false)
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2024.1080p.WEB-DL'), 2024), false);
  assert.equal(magnetYearContradicts(mkItem('Movie.Title.1994.BluRay'), 1994), false);

  // 2. Diferença 1 e 2: dentro da margem de ±2 anos -> aceito (false)
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2023.1080p'), 2024), false, 'diff -1 aceito');
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2025.1080p'), 2024), false, 'diff +1 aceito');
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2022.1080p'), 2024), false, 'diff -2 aceito');
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2026.1080p'), 2024), false, 'diff +2 aceito');

  // 3. Diferença 3+: fora da margem de ±2 anos -> contradiz / rejeitado (true)
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2021.1080p'), 2024), true, 'diff -3 rejeitado');
  assert.equal(magnetYearContradicts(mkItem('The.Crow.2027.1080p'), 2024), true, 'diff +3 rejeitado');
  assert.equal(magnetYearContradicts(mkItem('O.Corvo.1994.Dual.Audio.1080p'), 2024), true, '1994 vs 2024 rejeitado');
  assert.equal(magnetYearContradicts(mkItem('O.Corvo.2012.Dublado.720p'), 2024), true, '2012 vs 2024 rejeitado');

  // 4. Múltiplos anos no magnet: ambíguo (coletânea/franquia) -> aceito (false)
  assert.equal(
    magnetYearContradicts(mkItem('The.Crow.Collection.1994.2024.1080p.BluRay'), 2024),
    false,
    'dois anos declarados passa como ambíguo',
  );
  assert.equal(
    magnetYearContradicts(mkItem('Trilogia.Matrix.1999.2003.2021.1080p'), 1999),
    false,
    'tres anos declarados passa',
  );

  // 5. Resoluções com dimensões (1920x1080, 3840x2160, 1280x720) não são anos
  assert.equal(
    magnetYearContradicts(mkItem('The.Crow.2024.1920x1080.x264'), 2024),
    false,
    '1920x1080 limpo antes do match de ano',
  );
  assert.equal(
    magnetYearContradicts(mkItem('Filme.Sem.Ano.1920x1080.mkv'), 2024),
    false,
    '1920x1080 não vira ano 1920 isolado',
  );

  // 6. Decodificação de espaços com '+' e '%20'
  const itemPlus = { magnet: `magnet:?xt=urn:btih:${HASH}&dn=O+Corvo+1994+Dublado` };
  assert.equal(magnetYearContradicts(itemPlus, 2024), true, '+ vira espaço e 1994 é extraído');

  const itemPct = { magnet: `magnet:?xt=urn:btih:${HASH}&dn=O%20Corvo%201994%20Dual` };
  assert.equal(magnetYearContradicts(itemPct, 2024), true, '%20 decodifica e 1994 é isolado');

  // 7. Sequência % malformada (tolerante a erro de decodificação)
  const itemMalformed = { magnet: `magnet:?xt=urn:btih:${HASH}&dn=O%ZZCorvo+1994` };
  assert.equal(magnetYearContradicts(itemMalformed, 2024), true, 'continua com texto após erro de decodificação');

  const itemMalformedOk = { magnet: `magnet:?xt=urn:btih:${HASH}&dn=O%ZZCorvo+2024` };
  assert.equal(magnetYearContradicts(itemMalformedOk, 2024), false, 'recupera 2024 mesmo com %ZZ');

  // 8. Suporte a propriedades alternativas MagnetUri e Guid
  assert.equal(
    magnetYearContradicts({ MagnetUri: `magnet:?xt=urn:btih:${HASH}&dn=Movie.1994` } as any, 2024),
    true,
    'MagnetUri suportado',
  );
  assert.equal(
    magnetYearContradicts({ Guid: `magnet:?xt=urn:btih:${HASH}&dn=Movie.1994` } as any, 2024),
    true,
    'Guid suportado',
  );

  // 9. Entradas nulas, vazias ou catálogo sem ano
  assert.equal(magnetYearContradicts(null, 2024), false);
  assert.equal(magnetYearContradicts(undefined, 2024), false);
  assert.equal(magnetYearContradicts({} as any, 2024), false);
  assert.equal(magnetYearContradicts(mkItem('Movie.2024'), 0), false);
  assert.equal(magnetYearContradicts({ magnet: 'magnet:?xt=urn:btih:xxx' }, 2024), false);

  // 10. URL de protetor de link NÃO é magnet: slug do post pode citar qualquer
  //     ano da franquia. Medido no nerdviatorrents: slug "exterminio-2025" mata
  //     o filme correto de 2002.
  const resolverUrl = {
    magnet: 'http://127.0.0.1:8702/resolve?url=https%3A%2F%2Fwww.nerdviatorrents.net%2Fexterminio-2025%2F&i=0&h=228c1b010e&n=1',
  };
  assert.equal(magnetYearContradicts(resolverUrl, 2002), false, 'URL de protetor não deve condenar');
  assert.equal(magnetYearContradicts(resolverUrl, 2025), false, 'URL de protetor não confirma ano nem quando casa');

  const migratedResolverUrl = {
    magnet: 'http://127.0.0.1:8702/resolve?url=https%3A%2F%2Fwww.filmesviatorrents.net%2Fexterminio-2025%2F&i=0&h=228c1b010e&n=1',
  };
  assert.equal(magnetYearContradicts(migratedResolverUrl, 2002), false, 'URL de protetor no novo domínio não deve condenar');
  assert.equal(magnetYearContradicts(migratedResolverUrl, 2025), false, 'URL de protetor no novo domínio não confirma ano nem quando casa');

  // 11. Magnet real COM dn= continua funcionando normalmente
  assert.equal(magnetYearContradicts(mkItem('Exterminio.2002.Dublado.1080p'), 2002), false, 'ano correto no dn= aceito');
  assert.equal(magnetYearContradicts(mkItem('Exterminio.2025.Dublado.1080p'), 2002), true, 'ano errado no dn= rejeitado');

  // 12. Magnet sem dn= não extrai ano (sem evidência)
  assert.equal(magnetYearContradicts({ magnet: `magnet:?xt=urn:btih:${HASH}` }, 2024), false, 'sem dn= não condena');
});

test('magnetYearContradicts integrado a filterRelevantRaw: filme aplica guarda, série/pack não', () => {
  const item1994 = {
    title: 'O Corvo Dual Audio 1080p',
    magnet: `magnet:?xt=urn:btih:${HASH}&dn=O.Corvo.1994.1080p`,
    isBr: true,
  };
  const item2024 = {
    title: 'O Corvo Dual Audio 1080p',
    magnet: `magnet:?xt=urn:btih:${OTHER}&dn=The.Crow.2024.1080p`,
    isBr: true,
  };

  // Filme com ano 2024 no catálogo: 1994 é cortado pela guarda de ano no magnet
  const movieResults = relevantRaw([item1994, item2024], {
    names: ['The Crow', 'O Corvo'],
    year: 2024,
    isSeries: false,
  });
  assert.equal(movieResults.length, 1);
  assert.equal(movieResults[0].magnet, item2024.magnet);

  // Série com season definida: guarda de ano de filme NÃO roda (anos de série são por temporada)
  const seriesPack = {
    title: 'Série Clássica S01 Dublado',
    magnet: `magnet:?xt=urn:btih:${HASH}&dn=Serie.Classica.S01.1994.1080p`,
    isBr: true,
  };
  const seriesResults = relevantRaw([seriesPack], {
    names: ['Série Clássica', 'Classic Series'],
    year: 2024,
    isSeries: true,
    season: 1,
  });
  assert.equal(seriesResults.length, 1, 'série não é barrada pela guarda de ano de filme');
});

