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

// Dual + idioma estrangeiro NOMEADO deixou de ser ambíguo (balde `lixo`,
// veredito `condena`): o balde `dual` e a absolvição pelo marcador `dual`
// escondiam o item da triagem do painel. Os casos vizinhos (MULTI, Tamil,
// cirílico, guarda do path) estão em test/dual-foreign-language.test.ts.
const SERENITY_HINDI = 'Serenity.2023.1080p.WEBRip.x264 [Dual Audio] [Hindi DD 5.1] [HDRip-1337x][TorrentCounter].mkv';

test('Dual/HINDI: balde lixo e veredito condena, mas não é lie sem grupo de cena EN', () => {
  assert.equal(audioBucket(SERENITY_HINDI), 'lixo', 'Dual com idioma nomeado não é ambíguo');
  assert.equal(audioFromTitle(SERENITY_HINDI), 'Dual', 'o RÓTULO de áudio não muda — só balde e veredito');
  assert.equal(foreignVerdict(SERENITY_HINDI), 'condena', 'HINDI está na lista mínima');
  assert.equal(dubbedLieVerdict([SERENITY_HINDI], true).lie, false, 'sem grupo EN forte não prova mentira');
});

test('Fase 0: MULTI sozinho cai no balde dual, não no lixo', () => {
  // A fixture era `Filme.Nacional.2024.MULTI...`, que se contradizia: o teste
  // diz "MULTI SOZINHO" mas o nome carrega "Nacional" — o termo brasileiro de
  // áudio português, que está no PT_VOCAB. Nome neutro testa o que a frase
  // promete; o caso com palavra PT ao lado tem teste próprio logo abaixo.
  const multi = 'Movie.2024.MULTI.1080p.BluRay.x264';
  assert.equal(audioFromTitle(multi), 'Dual');
  assert.equal(audioBucket(multi), 'dual');
  // MULTI sem PT explícito não vira dublado para ranking (comportamento
  // de sempre: só conta com PT ao lado).
  assert.equal(looksPtBr(multi), false);
});

test('Dual + título em português é BR; Dual sozinho continua ambíguo', () => {
  // Regressão do caso medido em produção: release BR escrita "Dual Áudio" (em
  // vez de "Dublado") não era reconhecida como brasileira, não ganhava vaga
  // reservada e sumia da lista na disputa de cota — enquanto a irmã 720p, que
  // escreve "Dublado", aparecia. Nomes REAIS da conta do operador.
  const dubladoQueAparecia = 'Trilogia Se Beber Não Case (2009 - 2011 - 2013) Bluray 720p Dublado - WWW.BLUDV.COM';
  const dualQueSumia = 'Trilogia - Se Beber, Não Case! (2009-2013) 5.1 BluRay Dual Áudio 1080p By.Luan.Harper';
  assert.equal(looksPtBr(dubladoQueAparecia), true, 'o que já funcionava não pode regredir');
  assert.equal(looksPtBr(dualQueSumia), true, 'Dual + título PT é brasileiro');
  assert.equal(audioBucket(dualQueSumia), 'dub', 'sai do balde ambíguo');

  // Outros nomes reais da mesma conta: site BR nomeado e título em português.
  for (const t of [
    'Matrix (1999) BDRip 1080p Dual Audio - WWW.WOLVERDONFILMES.COM',
    'A Casa do Dragão S01E04 WEB-DL 1080p DUAL 5.1',
    'Guardiões da Galáxia - Vol. 3 2023 1080p BluRay DUAL 5.1',
    'Troia.Versão.Diretor.2004.BluRay.1080p.Dual.Audio.SF',
  ]) {
    assert.equal(looksPtBr(t), true, `${t}: BR de verdade`);
  }

  // O invariante do 8.12 NÃO se afrouxa: dual SEM sinal de português continua
  // ambíguo — nunca ocupa vaga reservada de BR só por ser dual.
  for (const t of [
    'Movie.2024.DUAL.1080p',
    'The.Matrix.1999.MULTI.1080p',
    'Zombieland.Double.Tap.2019.2160p.WEB-DL.DDP5.1.Atmos.H265-DreamHD',
  ]) {
    assert.equal(looksPtBr(t), false, `${t}: dual sem sinal PT segue ambíguo`);
    assert.equal(audioBucket(t), 'dual', `${t}: permanece no balde dual`);
  }
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

// ---------------------------------------------------------------------------
// BR_MARK: o alternador genérico `www.…org -` absolvia espelhos de cena EN.
// ---------------------------------------------------------------------------

test('BR_MARK: `www.uindex.org -` NÃO é sinal PT (espelho de cena EN)', () => {
  const release = 'www.UIndex.org - Some.Movie.2024.1080p.WEB-DL.Amzn';
  assert.equal(hasPtSigns(release), false, 'uindex não casa mais o BR_MARK genérico .org');
  assert.equal(audioFromTitle(release), '', 'não vira dublado');
  // Sem grupo EN → unknown, NUNCA absolve (o catálogo dá a palavra final).
  assert.equal(foreignVerdict(release), 'unknown');
  // Com grupo EN (sem PT) → condena; nunca absolve.
  assert.equal(foreignVerdict('www.UIndex.org - Some.Movie.2024.1080p.x264-RARBG'), 'condena');
  assert.equal(foreignVerdict('www.UIndex.org - Some.Show.S01.1080p-MeGusta'), 'condena');
});

test('BR_MARK: host BR NOMEADO continua sinal PT (`www.nerdfilmes.org -`)', () => {
  assert.equal(hasPtSigns('www.nerdfilmes.org - Filme Dublado 2024'), true);
  assert.equal(audioBucket('www.nerdfilmes.org - Filme Dublado 2024'), 'dub');
});

// ---------------------------------------------------------------------------
// 8.4 — Blindagem de ORIGEM BR na limpeza. Os 4 títulos são releases REAIS
// da conta (medido em produção, 2026-08-31): site BR, título em português,
// sem a palavra "dublado" — o balde `lixo` os condenava e a varredura
// destrutiva os apagaria. A blindagem é no caminho de LIMPEZA
// (audioBucket/foreignVerdict); hasPtSigns, que a busca consome, NÃO muda.
// ---------------------------------------------------------------------------

test('8.4: os 4 falsos positivos medidos saem da mira da limpeza', () => {
  const fixtures = [
    'X-Men - O Filme 1080p - The Pirate Filmes',
    'Troia - The Pirate Filmes',
    'Zumbilândia (2009) Bluray 1080p Filmes M.H.G',
    'zumbilandia (www.thepiratefilmes.com)',
  ];
  for (const t of fixtures) {
    // A busca fica intocada: o predicado que ela consome segue sem sinal para
    // estes títulos (sem ã/õ/ç, sem vocabulário, sem site na lista antiga).
    assert.equal(hasPtSigns(t), false, `${t}: hasPtSigns inalterado (busca não muda)`);
    // A limpeza protege: sai do balde `lixo` e o veredito absolve.
    assert.notEqual(audioBucket(t), 'lixo', `${t}: fora do balde lixo`);
    assert.equal(audioBucket(t), 'pt', t);
    assert.equal(foreignVerdict(t), 'absolve', `${t}: origem BR no nome protege`);
  }
});

test('8.4: estrangeiro genuíno continua condenável — blindagem não absolve cena EN', () => {
  // Contraprova do aceite: espelho de cena EN sem NENHUM sinal BR continua
  // condenável, e release genérica sem marca continua `unknown`/lixo.
  assert.equal(foreignVerdict('www.UIndex.org - Some.Movie.2024.1080p.x264-RARBG'), 'condena');
  assert.equal(audioBucket('Some.Movie.2024.1080p.WEB.x264'), 'lixo');
  assert.equal(foreignVerdict('Some.Movie.2024.1080p.WEB.x264'), 'unknown');
  // "Filme" sozinho, sem acento, sem vocabulário e sem site: hasPtSigns
  // permanece false e SOMENTE a blindagem nova tira o título da mira.
  assert.equal(hasPtSigns('Matrix.1999.filme.1080p.BluRay'), false);
  assert.equal(foreignVerdict('Matrix.1999.filme.1080p.BluRay'), 'absolve');
});
