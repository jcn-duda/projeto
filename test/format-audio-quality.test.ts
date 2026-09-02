// Rodada 2: checagem ligada; format.js é lógica pura, sem rede.
// Extraído de test/format.test.ts na divisão temática (teto 400 linhas):
// áudio e qualidade — classificação de rótulos, blob de tags do hdrtorrent,
// prova de áudio EN, balde de resolução desconhecida (qn) e tamanho
// fabricado pelo indexer.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  qualityFromTitle,
  stripQualityTagBlob,
  audioFromTitle,
  explicitPtAudio,
  editionFromTitle,
  matchesQualityFilter,
  toStremioStream,
  sortAndLimit,
  UNKNOWN_QUALITY,
  QUALITY_KEYS,
} from '../src/utils/format.js';
import type { RawItem, Stream } from '../types/domain.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

// O retorno de toStremioStream é `Stream | null` (null quando falta hash) e os
// campos de exibição são opcionais no tipo; todos os casos abaixo passam hash
// válido e os tocam, então o wrapper local só documenta o invariante — em vez
// de um cast no lugar em 40+ chamadas.
type TestStream = Stream & { infoHash: string; name: string; title: string; behaviorHints: { bingeGroup: string } };
const stremioStream = (item: RawItem): TestStream => toStremioStream(item) as TestStream;

test('qualityFromTitle casa os rótulos comuns', () => {
  assert.equal(qualityFromTitle('Movie 2160p UHD'), '2160p');
  assert.equal(qualityFromTitle('Movie 1080p'), '1080p');
  assert.equal(qualityFromTitle('Movie 720p'), '720p');
  assert.equal(qualityFromTitle('Movie 480p'), '480p');
  // Sem rótulo é 'não sei', não SD — ver o teste do balde próprio abaixo.
  assert.equal(qualityFromTitle('Movie sem rótulo'), UNKNOWN_QUALITY);
});

test('sourceFromTitle alimenta o bingeGroup via toStremioStream', () => {
  assert.equal(
    stremioStream({ title: 'Movie BluRay 1080p', infoHash: HASH }).behaviorHints.bingeGroup,
    'powerm-1080p-BluRay',
  );
  assert.equal(
    stremioStream({ title: 'Movie WEB-DL 720p', infoHash: HASH }).behaviorHints.bingeGroup,
    'powerm-720p-WEB-DL',
  );
  assert.equal(
    stremioStream({ title: 'Movie sem fonte', infoHash: HASH }).behaviorHints.bingeGroup,
    'powerm-na-any',
  );
});

test('matchesQualityFilter: vazio passa tudo; senão casa por rótulo', () => {
  assert.equal(matchesQualityFilter('qualquer coisa', []), true);
  assert.equal(matchesQualityFilter('Movie 1080p x264', ['1080p']), true);
  assert.equal(matchesQualityFilter('Movie 720p x264', ['1080p']), false);
});

test('audioFromTitle detecta dublado/dual/legendado e entra na linha', () => {
  assert.equal(audioFromTitle('Coringa Dublado 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Coringa DUB PT-BR 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Filme (2024) [DUB] 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Filme.2024.1080p.WEB-DL.DUBBED.mkv'), 'Dublado');
  assert.equal(audioFromTitle('Filme Dual Audio 720p'), 'Dual');
  assert.equal(audioFromTitle('Filme 1080p Audio Duplo'), 'Dual');
  assert.equal(audioFromTitle('Filme 1080p Multiaudio'), 'Dual');
  assert.equal(audioFromTitle('Auto da Compadecida 1080p Nacional'), 'Nacional');
  assert.equal(audioFromTitle('Serie Legendada 1080p'), 'Legendado');
  assert.equal(audioFromTitle('Filme 1080p LEG PT-BR'), 'Legendado');
  assert.equal(audioFromTitle('Filme 1080p [LEG]'), 'Legendado');
  assert.equal(audioFromTitle('Movie 1080p'), '');
  const s = stremioStream({ title: 'Coringa Dublado 1080p', infoHash: HASH, seeders: 1 });
  assert.ok(s.name.includes('1080p DUB'));
  assert.ok(s.title.includes('Dublado'));
  const sNac = stremioStream({ title: 'Filme Nacional 1080p', infoHash: HASH, isBr: true, seeders: 5 });
  assert.equal(sNac._dubbed, true);
  assert.ok(sNac.name.includes('1080p NAC BR'));
});

test('marca dublado só quando a origem global anuncia áudio PT explícito', () => {
  const globalDual = stremioStream({ title: 'Movie 2024 1080p DUAL', infoHash: HASH });
  const globalPt = stremioStream({ title: 'Movie 2024 1080p DUAL PT-BR', infoHash: OTHER });
  const globalDub = stremioStream({ title: 'Movie 2024 1080p Dublado', infoHash: 'c'.repeat(40) });
  const brDual = stremioStream({ title: 'Filme 2024 1080p DUAL', infoHash: 'd'.repeat(40), isBr: true });

  assert.equal(explicitPtAudio('Movie DUAL'), false);
  assert.equal(explicitPtAudio('Movie DUBLADO'), true);
  assert.equal(explicitPtAudio('Movie LEG PT-BR'), false);
  assert.equal(globalDual._dubbed, false);
  assert.match(globalDual.name, /DUAL/);
  assert.equal(globalPt._dubbed, true);
  assert.equal(globalDub._dubbed, true);
  assert.equal(brDual._dubbed, true);
});

// --- Causa A: blob de tags do hdrtorrent ---------------------------------
//
// Títulos REAIS capturados na investigação (Jackett, indexer hdrtorrent). O
// post anexa ao fim um blob de tags listando TODAS as qualidades, e o prefixo
// é sempre "... Dublada e Dual" mesmo no botão LEGENDADA. Sem cortar a cauda,
// o addon classificava tudo como 2160p/Dual — e o rótulo errado ocupava vaga
// BR, cota de 4K, prioridade de autofetch e o índice (que persiste semanas).

test('blob de tags no fim não engana qualityFromTitle nem audioFromTitle', () => {
  // Botão real: 1080P DUBLADO — o "Dual" do prefixo é convenção do site.
  assert.equal(
    qualityFromTitle('Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA DUBLADA Dual 1080P 1080p, 2160p, 720p, HD, WEB-DL'),
    '1080p',
  );
  // Botão LEGENDADA 720P: qualidade certa E áudio legendado apesar do prefixo.
  assert.equal(
    qualityFromTitle('Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA LEGENDADA 720P 1080p, 2160p, 720p, HD, WEB-DL'),
    '720p',
  );
  assert.equal(
    audioFromTitle('Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA LEGENDADA 720P 1080p, 2160p, 720p, HD, WEB-DL'),
    'Legendado',
  );
  // Botão LEGENDADA 2160P.
  assert.equal(
    qualityFromTitle('Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA LEGENDADA 2160P ULTRA HD 4K 1080p, 2160p, 720p, HD, WEB-DL'),
    '2160p',
  );
  assert.equal(
    audioFromTitle('Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA LEGENDADA 2160P ULTRA HD 4K 1080p, 2160p, 720p, HD, WEB-DL'),
    'Legendado',
  );
});

test('dublado real do hdrtorrent continua dublado apesar do blob', () => {
  // "COMPLETA DUBLADA Dual" fora da frase de convenção prova o áudio.
  assert.equal(
    audioFromTitle('Fallout 1ª Temporada Dublada e Dual 1ª TEMPORADA COMPLETA DUBLADA Dual 1080P 1080p, 2160p, 720p, HD, WEB-DL'),
    'Dual',
  );
});

// Prova pelo ARQUIVO com rótulo vazio (release EN sem marca PT) existe para
// derrubar a promessa de dublado do post. Ela NÃO pode apagar um rótulo que já
// concorda com ela: medido no Fallout S01, o 720p LEGENDADO do comandotorrents
// saía como "720p WEB-DL BR" — sem o LEG — enquanto o 4K e o 1080p legendados
// do MESMO post mantinham a marca. O `_dubbed` é false nos dois caminhos, então
// o que se perdia era só informação na tela.
test('prova de release EN não apaga o rótulo LEG de quem já é legendado', () => {
  const legendado = {
    title: 'Fallout 1ª Temporada (2024) [720p WEB-DL LEGENDADO 2.55 GB]',
    infoHash: 'b7efcb48193a4a9e11497d00930d754c0bf1c65b',
    seeders: 1,
    size: 2_550_000_000,
    indexer: 'comandotorrents',
    isBr: true,
  };
  const comProva = stremioStream({ ...legendado, provenAudio: '', provenName: '' } as any);
  const semProva = stremioStream({ ...legendado } as any);
  assert.match(comProva.name, /LEG/);
  assert.equal(comProva.name, semProva.name);
  assert.equal(comProva._dubbed, false);
  assert.equal(semProva._dubbed, false);
});

test('prova de release EN continua derrubando post que promete dublado', () => {
  // A contraparte: aqui o título CONTRADIZ a prova, e é para isso que ela serve.
  const promete = {
    title: 'Fallout 1ª Temporada (2024) [1080p WEB-DL DUBLADO 11.58 GB]',
    infoHash: 'c7efcb48193a4a9e11497d00930d754c0bf1c65b',
    seeders: 1,
    size: 11_580_000_000,
    indexer: 'comandotorrents',
    isBr: true,
  };
  const comProva = stremioStream({ ...promete, provenAudio: '', provenName: '' } as any);
  assert.equal(comProva._dubbed, false);
  assert.doesNotMatch(comProva.name, /DUB|DUAL|NAC/);
  // Sem prova o post vale, e prova POSITIVA troca o rótulo em vez de apagá-lo.
  assert.equal(stremioStream({ ...promete } as any)._dubbed, true);
  const provaDual = stremioStream({ ...promete, provenAudio: 'Dual' } as any);
  assert.equal(provaDual._dubbed, true);
  assert.match(provaDual.name, /DUAL/);
});

test('stripQualityTagBlob preserva título legítimo que termina em tag única', () => {
  // Tag única no fim NÃO é cortada: release legítima pode terminar em "1080p".
  assert.equal(stripQualityTagBlob('Coringa 2019 1080p'), 'Coringa 2019 1080p');
  assert.equal(qualityFromTitle('Coringa 2019 1080p'), '1080p');
  // Duas tags viram corte; uma não.
  assert.equal(stripQualityTagBlob('Nome 1080p WEB-DL'), 'Nome 1080p WEB-DL');
  // Cabeça do blob sem repetição no corpo sai com a cauda (é a enumeração).
  assert.equal(
    stripQualityTagBlob('Nome 1080p, 2160p, 720p, HD, WEB-DL'),
    'Nome',
  );
  // Cabeça que REPETE valor do corpo é o botão real e permanece.
  assert.equal(
    stripQualityTagBlob('Nome Dual 1080P 1080p, 2160p, 720p, HD, WEB-DL'),
    'Nome Dual 1080P',
  );
  // Tag fora do vocabulário interrompe o corte no meio, sem tocar o corpo.
  assert.equal(
    stripQualityTagBlob('Missão: Impossível – Efeito Fallout, análise, 1080p'),
    'Missão: Impossível – Efeito Fallout, análise, 1080p',
  );
});

test('anti-regressão: títulos limpos de comandotorrents/torrentdosfilmesv2 classificam igual', () => {
  // Formato medido nos dois indexers com resolver local: sem blob de tags.
  assert.equal(qualityFromTitle('Fallout 1ª Temporada Completa Dublado 1080p WEB-DL'), '1080p');
  assert.equal(audioFromTitle('Fallout 1ª Temporada Completa Dublado 1080p WEB-DL'), 'Dublado');
  assert.equal(qualityFromTitle('Série Nome 2ª Temporada Legendada 720p'), '720p');
  assert.equal(audioFromTitle('Série Nome 2ª Temporada Legendada 720p'), 'Legendado');
  // "Dual Áudio" legítimo continua Dual (fora da frase de convenção).
  assert.equal(audioFromTitle('Filme Nacional Dual Áudio 1080p'), 'Dual');
});

test('editionFromTitle reconhece os cortes que mudam o filme, em pt e en', () => {
  assert.equal(editionFromTitle('Filme 2007 Alternate Ending 2160p'), 'Alt.End');
  assert.equal(editionFromTitle("Filme 2007 Director's Cut 1080p"), 'DC');
  assert.equal(editionFromTitle('Filme 2007 Extended Edition 1080p'), 'Extended');
  assert.equal(editionFromTitle('Eu Sou a Lenda 2008 Versão de Cinema 1080p'), 'Cinema');
  assert.equal(editionFromTitle('Filme 1999 Remastered 4K'), 'Remaster');
  assert.equal(editionFromTitle('Filme 2019 IMAX 2160p'), 'IMAX');
  assert.equal(editionFromTitle('Filme 2019 Unrated 1080p'), 'Uncut');
  // "Alternate Version" não diz qual é a diferença, mas diz que não é o padrão.
  assert.equal(editionFromTitle('I Am Legend - Alternate Version (2007)'), 'Alt.Ver');
  assert.equal(editionFromTitle('Filme 2007 Versão Alternativa 1080p'), 'Alt.Ver');
  // Sem corte anunciado não inventa rótulo — a maioria das releases cai aqui e
  // é o que mantém a linha curta no caso comum.
  assert.equal(editionFromTitle('I Am Legend 2007 UHD BluRay 2160p HEVC'), '');
  assert.equal(editionFromTitle(''), '');
});

test('sentinela de 1 KB dos indexers BR conta como tamanho desconhecido', () => {
  const unknown = stremioStream({ title: 'Serie 1a Temporada', infoHash: HASH, size: 1024 });
  assert.ok(!unknown.title.includes('💾'), 'não exibe tamanho inventado');
  assert.equal(unknown._size, 0);
  // Acima do sentinela é tamanho de verdade e volta a aparecer.
  const real = stremioStream({ title: 'Serie 1a Temporada', infoHash: HASH, size: 2 * 1024 ** 3 });
  assert.ok(real.title.includes('💾 2.00 GB'));
  assert.equal(real._size, 2 * 1024 ** 3);
});

test('sem resolução no título não é SD e tem balde próprio', () => {
  // Fonte BR típica: nenhuma resolução no título.
  assert.equal(qualityFromTitle('Devoradores de Estrelas (2026) [opção 3]'), UNKNOWN_QUALITY);
  assert.equal(qualityFromTitle('A Casa do Dragão 1ª Temporada (2022) WEB-DL [DUBLADO]'), UNKNOWN_QUALITY);
  // SD exige marca explícita de baixa qualidade.
  assert.equal(qualityFromTitle('Filme 2019 DVDRip XviD'), 'SD');
  assert.equal(qualityFromTitle('Filme 2019 SDTV'), 'SD');
  assert.equal(qualityFromTitle('Filme 2026 576p WEBRip x265'), 'SD');
  assert.equal(qualityFromTitle('Filme 2019 CAM'), 'SD');
  // Resolução declarada continua ganhando.
  assert.equal(qualityFromTitle('Filme 2019 1080p WEB-DL'), '1080p');
  assert.ok(QUALITY_KEYS.includes(UNKNOWN_QUALITY));
});

test('zerar a cota de SD não esconde mais as fontes BR', () => {
  const br = stremioStream({ title: 'Devoradores de Estrelas (2026) [opção 3]', infoHash: HASH, seeders: 1, isBr: true });
  const sd = stremioStream({ title: 'Devoradores de Estrelas 2026 DVDRip', infoHash: OTHER, seeders: 9 });
  const out = sortAndLimit([br, sd], { qualityLimits: { SD: 0 }, maxResults: 10 });
  assert.equal(out.length, 1, 'só o DVDRip cai na cota zerada de SD');
  assert.match(out[0].title, /opção 3/);
  // E a cota nova corta o balde certo quando o usuário quiser.
  assert.equal(sortAndLimit([br, sd], { qualityLimits: { [UNKNOWN_QUALITY]: 0 }, maxResults: 10 }).length, 1);
});

test('resolução desconhecida não vira rótulo nem grupo de binge do SD', () => {
  const s = stremioStream({ title: 'Devoradores de Estrelas (2026) [opção 3] DUBLADO', infoHash: HASH, seeders: 1 });
  const details = s.name;
  assert.ok(!/sem resolução|SD/.test(details), `linha não anuncia resolução: ${details}`);
  assert.ok(details.startsWith('DUB'), details);
  assert.ok(!s.behaviorHints.bingeGroup.includes('SD'));
});

test('filtro de resolução preserva fonte sem resolução pelo balde próprio', () => {
  const br = stremioStream({
    title: 'Prometheus (2012) [opção 3] DUBLADO',
    infoHash: 'd'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const global4k = stremioStream({
    title: 'Prometheus 2012 2160p WEB-DL',
    infoHash: 'e'.repeat(40),
    seeders: 100,
  });
  const limits = { [UNKNOWN_QUALITY]: 100 };
  const out = sortAndLimit([br, global4k], {
    maxResults: 10,
    qualityFilter: ['2160p', '1080p', '720p'] as never[],
    qualityLimits: limits,
  });

  assert.deepEqual(new Set(out.map((item) => item.infoHash)), new Set([br.infoHash, global4k.infoHash]));
});

test('cota zero de sem resolução continua ocultando esse balde', () => {
  const br = stremioStream({
    title: 'Prometheus (2012) [opção 3] DUBLADO',
    infoHash: 'f'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const out = sortAndLimit([br], {
    maxResults: 10,
    qualityFilter: ['2160p', '1080p', '720p'] as never[],
    qualityLimits: { [UNKNOWN_QUALITY]: 0 },
  });

  assert.deepEqual(out, []);
});

test('filtro de qualidade usa a resolução declarada, não substring do título', () => {
  const br4k = stremioStream({
    title: 'Prometheus (2012) 4K UHD DUBLADO',
    infoHash: '1'.repeat(40),
    seeders: 1,
    isBr: true,
  });
  const out = sortAndLimit([br4k], {
    maxResults: 10,
    qualityFilter: ['2160p'] as never[],
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].infoHash, br4k.infoHash);
});

test('tamanho fabricado pelo indexer vira desconhecido, não valor exibido', () => {
  // 1,62 TB é o carimbo da definição Cardigann do redetorrent em 53 das 93
  // releases de uma busca real. Exibi-lo mente para o usuário e, com filtro de
  // tamanho ligado, apagaria a fonte dublada inteira.
  const absurdo = stremioStream({
    title: 'House of the Dragon S01E02 DUAL 1080p', infoHash: HASH, seeders: 1, size: 1784881034035,
  });
  assert.equal(absurdo._size, 0);
  assert.doesNotMatch(absurdo.title, /TB/);
  // Tamanho plausível continua intacto.
  const real = stremioStream({
    title: 'Filme 1080p', infoHash: OTHER, seeders: 5, size: 8 * 1024 ** 3,
  });
  assert.equal(real._size, 8 * 1024 ** 3);
  assert.match(real.title, /8(\.\d+)? GB/);
  // Filtro de tamanho não pode descartar quem tem tamanho desconhecido.
  const out = sortAndLimit([absurdo], { maxSizeGb: 20 });
  assert.equal(out.length, 1);
});

