import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioBucket, dubbedLieVerdict, hasPtSigns, audioFromTitle, looksPtBr, foreignVerdict,
} from '../src/utils/audio-quality.js';

// Regressão dos consertos de classificador da Fase 0 (catálogo + limpador BR).
// Os casos vêm de medição real: 19 de 20 títulos BR sem acento caíam no balde
// de deleção, e `Coringa … AMZN … DUAL` era condenado como release EN — o que
// chamava unprotect no acervo BR retido no momento do play.

test('Fase 0: DUAL sozinho no path absolve o audit de mentira (plataforma não é idioma)', () => {
  // Padrão dominante do WEB-DL dublado BR: DUAL sem a palavra "audio".
  const coringa = 'Coringa.2019.1080p.AMZN.WEB-DL.DUAL.5.1.x264.mkv';
  assert.equal(dubbedLieVerdict([coringa], true).lie, false, coringa);
  // A marca PT vem do DUAL, não do AMZN: mesmo sem a plataforma no nome,
  // o marcador sozinho já preserva.
  const dualPuro = 'Filme.2019.1080p.WEB-DL.DUAL.5.1.x264.mkv';
  assert.equal(dubbedLieVerdict([dualPuro], true).lie, false, dualPuro);
});

test('Fase 0: release de cena EN sem marcador PT continua sendo lie', () => {
  // Os grupos removidos de enGroups (amzn/dsnp/smi) eram plataformas; grupos
  // de cena de verdade continuam provando EN.
  const lies = [
    'True.Detective.S02E01.1080p.WEBRip.x264.DD5.1-RARBG.mkv',
    'True.Detective.S02E01.HDTV.x264-KILLERS[ettv].mp4',
  ];
  for (const path of lies) assert.equal(dubbedLieVerdict([path], true).lie, true, path);
});

test('Fase 0: Dual Audio (Hindi) continua ambíguo — não é lie nem estrangeiro provado', () => {
  const serenity = 'Serenity.2023.1080p.WEBRip.x264 [Dual Audio] [Hindi DD 5.1] [HDRip-1337x][TorrentCounter].mkv';
  assert.equal(audioBucket(serenity), 'dual', 'dual sem PT ao lado é ambíguo');
  assert.equal(dubbedLieVerdict([serenity], true).lie, false, 'dual audio é marcador PT auditivo conhecido');
});

test('Fase 0: MULTI sozinho cai no balde dual, não no lixo', () => {
  const multi = 'Filme.Nacional.2024.MULTI.1080p.BluRay.x264';
  assert.equal(audioFromTitle(multi), 'Dual');
  assert.equal(audioBucket(multi), 'dual');
  // MULTI sem PT explícito não vira dublado para ranking (comportamento
  // de sempre: só conta com PT ao lado).
  assert.equal(looksPtBr(multi), false);
});

test('Fase 0: a preposição "de" conta para o sinal de português (2+ ocorrências)', () => {
  const titulo = 'Diario de uma Paixao de 2004 1080p';
  assert.equal(hasPtSigns(titulo), true, titulo);
  assert.notEqual(audioBucket(titulo), 'lixo', titulo);
});

test('Fase 0: um "de" solto não basta — título estrangeiro segue no lixo', () => {
  const titulo = 'Tale of De Shadows 2019 1080p';
  assert.equal(hasPtSigns(titulo), false, titulo);
  assert.equal(audioBucket(titulo), 'lixo');
});

// foreignVerdict: o predicado da Fase 4 — a assimetria do lado da deleção.

test('Fase 4: foreignVerdict absolve com um único marcador PT em qualquer lugar', () => {
  assert.equal(foreignVerdict('A Origem 2010 Dual Audio 1080p'), 'absolve');
  assert.equal(foreignVerdict('Filme.2019.1080p.x264-RARBG', ['Pasta/Filme Dublado 2019.mkv']), 'absolve');
  // Título sem sinal, mas o path real do arquivo tem.
  assert.equal(foreignVerdict('Interestelar.2014.1080p.BluRay.x264', ['Interestelar 2014 DUBLADO 1080p.mkv']), 'absolve');
});

test('Fase 4: foreignVerdict só condena com prova positiva e nenhum sinal PT', () => {
  assert.equal(foreignVerdict('Movie.2019.1080p.TrueFrench.BluRay.x264'), 'condena');
  assert.equal(foreignVerdict('Show.S01.1080p.WEB.x264', ['Show S01E01 1080p.mkv-GERMAN']), 'condena');
  assert.equal(foreignVerdict('True.Detective.S02E01.1080p.WEBRip.x264.DD5.1-RARBG.mkv'), 'condena');
});

test('Fase 4: foreignVerdict UNKNOWN nunca apaga — fica para a auditoria de arquivos', () => {
  // Os 19/20 títulos medidos: sem sinal PT no título e sem prova EN — o
  // balde lixo por ausência NÃO autoriza mais deleção nenhuma.
  for (const titulo of ['Vingadores Ultimato 2019 1080p', 'A Origem 2010', 'Tropa de Elite 2 2010', 'Coringa 2019 1080p']) {
    assert.equal(foreignVerdict(titulo), 'unknown', titulo);
  }
  assert.equal(foreignVerdict('Some.Movie.2024.1080p.WEB.x264'), 'unknown');
});

// Amostra dos 20 títulos medidos que motivaram o plano. Nem todos saem do
// balde fraco com só os consertos de título — o que NENHUM pode sofrer é
// condenação por prova estrangeira inexistente (o limpador da Fase 4 usa
// foreignVerdict, que exige prova positiva, e não audioBucket).
const TITULOS_BR_MEDIDOS = [
  'Vingadores Ultimato 2019 1080p',
  'Tropa de Elite 2 2010',
  'A Origem 2010',
  'Interestelar 2014 1080p BluRay',
  'Coringa 2019 1080p',
  'Parasita 2019 1080p',
  'Matrix 1999 Dual Audio 1080p',
];

test('Fase 0: nenhum título BR medido é condenado como lie com promessa de dublado', () => {
  for (const titulo of TITULOS_BR_MEDIDOS) {
    const veredito = dubbedLieVerdict([titulo], true);
    assert.equal(veredito.lie, false, titulo);
  }
});

test('Fase 0: título só resgata quem tem sinal PT; o resto fica fraco MAS nunca condenado', () => {
  // Classificação por título tem teto conhecido: sem acento, sem vocabulário
  // e com um "de" solto, o título não prova nada — é exatamente o que o
  // catálogo (Fase 1) e a auditoria por arquivos (Fase 3/4) resolvem com
  // prova. O que a Fase 0 garante é que a condenação por AUSÊNCIA de marcador
  // não existe mais no caminho de deleção.
  const fracos = TITULOS_BR_MEDIDOS.filter((t) => !hasPtSigns(t) && audioFromTitle(t) === '');
  assert.ok(fracos.length >= 3, 'a amostra deve manter casos fracos para o catálogo resolver');
  for (const titulo of fracos) {
    // Nunca viram "dub" por palpite (comportamento de sempre preservado)…
    assert.notEqual(audioBucket(titulo), 'dub', titulo);
    // …e a prova de estrangeiro por grupo de cena não existe neles.
    assert.equal(dubbedLieVerdict([titulo], true).lie, false, titulo);
  }
});
