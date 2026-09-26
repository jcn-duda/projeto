// Guardas do DUB genérico: idioma estrangeiro nomeado, bloco rutracker,
// cirílico e ENGLISH desmentem a promessa de dublagem PT — só de ranking,
// sem criar condenação destrutiva (assimetria preservada).
// Extraído de test/audio-cleanup-classifiers.test.ts (teto 400 linhas).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioBucket, audioFromTitle, looksPtBr, foreignVerdict,
  hasExplicitForeignAudio, hasPtAudioMark,
} from '../src/utils/audio-quality.js';
import config from '../src/config.js';
import { patch } from './helpers/stub.js';

// ---------------------------------------------------------------------------
// DUB HINDI (B): generic DUB/DUBBED não valida áudio PT quando há HINDI.
// ---------------------------------------------------------------------------

test('DUB/HINDI: HINDI.HQ.DUB e HINDI.DUBBED não são dublado pt-BR', () => {
  for (const t of ['HINDI.HQ.DUB', 'HINDI.DUBBED']) {
    assert.equal(audioFromTitle(t), '', `${t}: não vira Dublado`);
    assert.equal(looksPtBr(t), false, `${t}: looksPtBr false`);
    assert.equal(hasExplicitForeignAudio(t), true, `${t}: HINDI condena como estrangeiro`);
    assert.equal(foreignVerdict(t), 'condena', `${t}: condenado (sem PT)`);
  }
});

test('DUB/HINDI: PT-BR explícito ao lado vence (absolve), [DUB] genérico continua Dublado', () => {
  assert.equal(audioFromTitle('HINDI.HQ.DUB PT-BR'), 'Dublado', 'marca PT explícita vence o HINDI');
  assert.equal(foreignVerdict('HINDI.HQ.DUB PT-BR'), 'absolve', 'assimetria preservada: com PT, absolve');
  assert.equal(audioFromTitle('Coringa 2019 DUB PT-BR 1080p'), 'Dublado', 'DUB genérico sem HINDI = PT');
  assert.equal(foreignVerdict('[DUB] Some Movie 2024'), 'absolve', 'generic [DUB] sem idioma estrangeiro absolve');
  assert.equal(audioFromTitle('Some.Movie.2024.[DUB]'), 'Dublado', 'generic [DUB] = Dublado');
});

test('DUB/HINDI: marcador genérico CUSTOMIZADO em AUDIO_AUDIT_PT_MARKERS sofre a mesma guarda do HINDI', () => {
  // O fechamento é por construção: marcador que normaliza para 'dub'/'dubbed'
  // exato é genérico, venha do default ou do env do operador.
  const restore = patch(config.audioAudit, 'ptMarkers', [...config.audioAudit.ptMarkers, 'dub']);
  try {
    assert.equal(hasPtAudioMark('Show.2024.Dub.1080p.mkv'), true, 'dub genérico sem HINDI prova PT');
    assert.equal(hasPtAudioMark('Show.2024.Hindi.Dub.1080p.mkv'), false, 'HINDI desmente o marcador genérico custom');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// `<idioma> Dub` (generalização do caso HINDI). Medido em produção
// (powermovie.net, 2026-08-30, tt22084616): as três primeiras vagas de
// "Spider-Man: Brand New Day" eram `[Ukr Dub]` rotuladas DUB BR e ocupavam as
// TRÊS vagas reservadas de BR — o topo da lista entregava ucraniano.

test('DUB/idioma: [Ukr Dub] não é dublado pt-BR (caso medido em produção)', () => {
  const ukr = 'Spider-Man: Brand New Day 2026 1080p TELESYNC HEVC [Ukr Dub]';
  assert.notEqual(audioFromTitle(ukr), 'Dublado', 'dublagem ucraniana não é pt-BR');
  assert.equal(looksPtBr(ukr), false, 'não pode ocupar vaga reservada de BR');
  assert.equal(hasExplicitForeignAudio(ukr), true, 'UKR condena como estrangeiro');
});

test('DUB/idioma: a guarda generaliza além do HINDI', () => {
  // Mesma construção, idiomas diferentes: o predicado é sobre a FORMA
  // `<idioma> Dub`, não sobre uma lista caçada caso a caso.
  for (const t of ['Movie 2024 [Rus Dub]', 'Movie 2024 POLISH DUBBED', 'Movie 2024 [Turkish Dub]']) {
    assert.notEqual(audioFromTitle(t), 'Dublado', `${t}: idioma estrangeiro desmente o DUB genérico`);
    assert.equal(looksPtBr(t), false, `${t}: fora das vagas BR`);
  }
});

test('DUB/idioma: PT explícito ao lado do idioma estrangeiro continua vencendo', () => {
  // A assimetria do commit anterior vale para toda a lista, não só HINDI: a
  // guarda derruba a prova GENÉRICA, e a marca PT explícita corre fora dela.
  assert.equal(audioFromTitle('Movie 2024 [Ukr Dub] DUBLADO'), 'Dublado', 'DUBLADO explícito vence');
  assert.equal(foreignVerdict('Movie 2024 [Ukr Dub] PT-BR'), 'absolve', 'com PT explícito, absolve');
});

test('DUB/idioma: release BR sem idioma estrangeiro não regride', () => {
  // A lista não pode encolher o BR legítimo — o DUB genérico segue valendo.
  assert.equal(audioFromTitle('Coringa 2019 DUB 1080p'), 'Dublado', 'DUB genérico sozinho = PT');
  assert.equal(looksPtBr('Homem-Aranha: Um Novo Dia (2026) [1080p DUBLADO 4.32 GB]'), true);
});

test('DUB/idioma: guarda do path acompanha a do título', () => {
  // hasPtAudioMark usa o MESMO predicado; marcador genérico no path não pode
  // provar PT quando o arquivo nomeia idioma estrangeiro.
  const restore = patch(config.audioAudit, 'ptMarkers', ['dub', 'dublado']);
  try {
    assert.equal(hasPtAudioMark('Movie.2024.Ukr.Dub.1080p.mkv'), false, 'genérico sob idioma estrangeiro');
    assert.equal(hasPtAudioMark('Movie.2024.Dublado.1080p.mkv'), true, 'marcador explícito segue valendo');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// DUB/rutracker transliterado: formato ASCII do rutracker sem cirílico e sem
// nome de idioma — FOREIGN_DUB_LANG_RE / CYRILLIC_RE não pegam. Medido em
// produção (2026-09-21, tt0200550 Coyote Ugly, kickasstorrents.to): as 4
// primeiras vagas (reserva BR) eram `DUB BR · kickass` com "Dub" =
// Дублированный russo. Assimetria preservada: NÃO entra em
// hasExplicitForeignAudio (não condena/apaga).
// ---------------------------------------------------------------------------

test('DUB/rutracker: títulos reais do Coyote Ugly não são dublado pt-BR', () => {
  const titulos = [
    'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dub + (Zhivov)',
    'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, HDRip] (Full version / Unrated Extended Cut) Dub',
    'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dub + AVO (Zhivov) + Original',
    'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, HDRip] Dub',
  ];
  for (const t of titulos) {
    assert.notEqual(audioFromTitle(t), 'Dublado', `${t}: Dub russo não é pt-BR`);
    assert.equal(looksPtBr(t), false, `${t}: fora das vagas BR`);
    assert.equal(hasExplicitForeignAudio(t), false, `${t}: não condena (assimetria)`);
  }
});

test('DUB/rutracker: PT explícito ao lado do formato continua vencendo', () => {
  assert.equal(
    audioFromTitle('Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dub DUBLADO'),
    'Dublado',
    'DUBLADO explícito vence o formato rutracker',
  );
});

test('DUB/seleZen: grupo russo sem bloco nem cirílico não é dublado pt-BR', () => {
  // The Whisper Man (2026-09-24): as duas vagas BR da conta eram seleZen.
  const titulos = [
    'The.Whisper.Man.2026.DUB.NF.WEB-DLRip.x264.seleZen',
    'The.Whisper.Man.2026.DUB.NF.WEB-DLRip-AVC.x264.seleZen.mkv',
    'Disclosure Day.2026.DUB.BDRip.1080p.x264.seleZen',
  ];
  for (const t of titulos) {
    assert.notEqual(audioFromTitle(t), 'Dublado', `${t}: DUB russo não é pt-BR`);
    assert.equal(looksPtBr(t), false, `${t}: fora das vagas BR`);
    assert.equal(hasExplicitForeignAudio(t), false, `${t}: não condena (assimetria)`);
  }
  // Marca PT explícita continua vencendo, e o nome não casa dentro de palavra.
  assert.equal(audioFromTitle('Filme.2026.DUBLADO.1080p.seleZen'), 'Dublado');
  assert.equal(looksPtBr('Filme.2026.DUB.1080p.WEB-DL.Selezenovo'), true);
});

test('DUB/LAT: dublagem latina abreviada não é dublado pt-BR', () => {
  // Moana 2 (2026-09-24): "LAT.DUB" do Cinecalidad saía como 1080p DUB BR.
  for (const t of [
    'Moana.2.2024.1080p.WEBRip.LAT.DUB.PINUP.mp4',
    'The.Invite.2026.1080p.WEBRip.LAT.DUB.1XBET',
  ]) {
    assert.notEqual(audioFromTitle(t), 'Dublado', t);
    assert.equal(looksPtBr(t), false, t);
    assert.equal(hasExplicitForeignAudio(t), false, `${t}: não condena (assimetria)`);
  }
  assert.equal(audioFromTitle('Moana.2.2024.LAT.DUBLADO.1080p'), 'Dublado', 'PT explícito vence');
  assert.equal(looksPtBr('Filme.2024.1080p.DUB.PLATINUM'), true, 'LAT dentro de palavra não conta');
});

test('DUB/rutracker: Dual no formato cai em lixo (guarda ampla), não em dual', () => {
  const dual = 'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, BDRip] Dual';
  assert.equal(audioBucket(dual), 'lixo', 'Dual + bloco rutracker = lixo de triagem');
  assert.equal(hasExplicitForeignAudio(dual), false, 'não condena destrutivo');
});

test('DUB/rutracker: DUB genérico BR e colchete sem vírgula não regridem', () => {
  assert.equal(audioFromTitle('Filme 2020 1080p DUB'), 'Dublado');
  assert.equal(audioFromTitle('Filme (2020) [DUB]'), 'Dublado');
  assert.equal(audioFromTitle('Filme [2020] Dublado'), 'Dublado', 'ano entre colchetes sem vírgula = BR intacto');
  assert.equal(looksPtBr('Filme [2020] Dublado'), true);
});

test('DUB/rutracker: guarda do path acompanha a do título', () => {
  const restore = patch(config.audioAudit, 'ptMarkers', ['dub', 'dublado']);
  try {
    // O predicado lê o path cru: a assinatura `[AAAA, País…` precisa sobreviver
    // (ponto no lugar do espaço após a vírgula quebraria o casamento).
    assert.equal(
      hasPtAudioMark('Coyote.Ugly.[2000, USA, BDRip].Dub.1080p.mkv'),
      false,
      'genérico sob bloco rutracker',
    );
    assert.equal(
      hasPtAudioMark('Coyote.Ugly.[2000, USA, BDRip].Dublado.1080p.mkv'),
      true,
      'marcador explícito segue valendo',
    );
    assert.equal(hasPtAudioMark('Show.2024.Dub.1080p.mkv'), true, 'sem assinatura, genérico prova PT');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// DUB/rutracker FAIXA DE ANOS: o bloco transliterado do rutracker também admite
// `[AAAA-AAAA, País, …]` (hífen, en-dash ou em-dash, com ou sem espaços), que a
// versão de ano único deixava escapar. Medido no corpus do container
// (2026-09-22, cache.db, raw:v1 × idx:v10): dos 9.119 títulos únicos, SÓ
// `The Matrix: Trilogy [1999-2003, USA, …] [Open Matte] Dub` mudou de
// classificação (kickasstorrents-to, vaga reservada BR) e nenhum era de site
// BR — os BR escrevem `(2009-2013)` entre PARÊNTESES, sem vírgula + palavra.
// Assimetria preservada: NÃO entra em hasExplicitForeignAudio.
// ---------------------------------------------------------------------------

test('DUB/rutracker: faixa de anos no bloco derruba a prova genérica (caso medido 2026-09-22)', () => {
  const faixas = [
    'The Matrix: Trilogy [1999-2003, USA, sci-fi, action, adventure, WEBRip] [Open Matte] Dub',
    'The Matrix: Trilogy [2001 - 2003, USA, sci-fi, action, BDRip-AVC] Dub',
    'The Matrix: Trilogy [1979–1997, USA, Australia, sci-fi, action, DVD5] Dub',
    'The Matrix: Trilogy [1999—2003, USA, sci-fi, action, DVD5] Dub',
  ];
  for (const t of faixas) {
    assert.notEqual(audioFromTitle(t), 'Dublado', `${t}: faixa de anos + Dub russo não é pt-BR`);
    assert.equal(looksPtBr(t), false, `${t}: fora das vagas BR`);
    assert.equal(hasExplicitForeignAudio(t), false, `${t}: não condena (assimetria)`);
  }
});

test('DUB/rutracker: PT explícito ao lado da faixa de anos continua vencendo', () => {
  assert.equal(
    audioFromTitle('The Matrix: Trilogy [1999-2003, USA, sci-fi, WEBRip] Dub DUBLADO'),
    'Dublado',
    'DUBLADO explícito vence a faixa de anos',
  );
  assert.equal(
    foreignVerdict('The Matrix: Trilogy [1999-2003, USA, sci-fi, WEBRip] Dub PT-BR'),
    'absolve',
    'com PT explícito, absolve',
  );
});

test('DUB/rutracker: faixa entre parênteses ou sem vírgula+palavra NÃO regride (BR intacto)', () => {
  // O site BR publica o intervalo entre PARÊNTESES e sem o bloco de metadados:
  // nenhuma das duas formas casa a assinatura transliterada.
  assert.equal(audioFromTitle('Trilogia - Se Beber, Não Case! (2009-2013) BluRay Dublado 1080p'), 'Dublado');
  assert.equal(looksPtBr('Trilogia - Se Beber, Não Case! (2009-2013) BluRay Dublado 1080p'), true);
  assert.equal(audioFromTitle('Filme [2009-2013] Dublado'), 'Dublado', 'colchete sem vírgula+palavra = BR intacto');
  assert.equal(looksPtBr('Filme [2009-2013] Dublado'), true);
});

test('DUB/rutracker: guarda do path também cobre a faixa de anos', () => {
  const restore = patch(config.audioAudit, 'ptMarkers', ['dub', 'dublado']);
  try {
    assert.equal(
      hasPtAudioMark('The.Matrix.Trilogy.[1999-2003, USA, WEBRip].Dub.1080p.mkv'),
      false,
      'genérico sob bloco com faixa de anos',
    );
    assert.equal(
      hasPtAudioMark('The.Matrix.Trilogy.[1999 - 2003, USA, WEBRip].Dublado.1080p.mkv'),
      true,
      'marcador explícito segue valendo',
    );
    assert.equal(hasPtAudioMark('The.Matrix.Trilogy.1999-2003.Dub.1080p.mkv'), true, 'sem bloco, genérico prova PT');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// DUB/cirílico: o SCRIPT cirílico desmente a promessa GENÉRICA do DUB/DUBBED,
// como o nome de idioma desmente (HINDI acima). Medido pelo /stream-trace.json
// ao vivo (2026-09-01): 11 dos 50 títulos cirílicos do índice (826 únicos)
// estavam classificados Dublado/BR via [DUB] e disputavam vaga reservada
// anunciando pt-BR. A direção é SÓ de ranking: tira vaga reservada e a
// promessa `_dubbed`; NÃO cria condenação de limpeza (cirílico não entra em
// hasExplicitForeignAudio).
// ---------------------------------------------------------------------------

test('DUB/cirílico: [DUB] genérico em título cirílico não é dublado pt-BR (caso medido pelo trace)', () => {
  // 'Во все тяжкие / Breaking Bad / … [DUB] [Selena/Телеканал Че]' — Телеканал
  // Че é canal russo; [DUB] aqui é dublagem russa, não pt-BR.
  const russo = 'Во все тяжкие / Breaking Bad / … [BDRip 720p] [DUB] [Selena/Телеканал Че]';
  assert.equal(audioFromTitle(russo), '', 'DUB genérico sob cirílico não vira Dublado');
  assert.equal(looksPtBr(russo), false, 'não pode ocupar vaga reservada de BR');
  assert.equal(hasExplicitForeignAudio(russo), false, 'cirílico NÃO condena (não é prova de idioma)');
  assert.equal(foreignVerdict(russo), 'unknown', 'sem marca nenhuma: nunca apaga, fica para a auditoria');
});

test('DUB/cirílico: PT-BR explícito ao lado vence (release BR pode citar canal em cirílico)', () => {
  // Mesma semântica do bloco HINDI: a guarda derruba a prova GENÉRICA, a
  // marca PT explícita corre fora dela e vence.
  assert.equal(audioFromTitle('Во все тяжкие / Breaking Bad / … [BDRip 720p] [DUB] [Selena/Телеканал Че] PT-BR'), 'Dublado');
  assert.equal(looksPtBr('Во все тяжкие … [DUB] [Телеканал Че] DUBLADO'), true, 'DUBLADO explícito também vence');
  assert.equal(foreignVerdict('Во все тяжкие … [DUB] [Телеканал Че] PT-BR'), 'absolve', 'com PT explícito, absolve');
});

test('DUB/cirílico: cirílico sozinho não autoriza condenação de limpeza (assimetria preservada)', () => {
  // O cirílico não entrou em hasExplicitForeignAudio nem no foreignVerdict:
  // este conserto é só de ranking/promessa de dublagem.
  assert.equal(hasExplicitForeignAudio('Во все тяжкие 2008 BDRip 720p'), false);
  assert.equal(foreignVerdict('Во все тяжкие 2008 BDRip 720p'), 'unknown');
  // E o DUB genérico SEM cirílico continua valendo (nenhuma regressão do BR).
  assert.equal(audioFromTitle('Coringa 2019 DUB 1080p'), 'Dublado');
  assert.equal(looksPtBr('Homem-Aranha: Um Novo Dia (2026) [1080p DUBLADO 4.32 GB]'), true);
});

test('DUB/cirílico: guarda do path acompanha a do título', () => {
  // hasPtAudioMark aplica o MESMO critério do HINDI ao script cirílico:
  // marcador genérico custom no path não prova PT quando o arquivo está em
  // cirílico; marcador explícito segue valendo.
  const restore = patch(config.audioAudit, 'ptMarkers', ['dub', 'dublado']);
  try {
    assert.equal(hasPtAudioMark('Show.2024.Dub.Телеканал Че.1080p.mkv'), false, 'genérico sob script cirílico');
    assert.equal(hasPtAudioMark('Show.2024.Dublado.Телеканал Че.1080p.mkv'), true, 'marcador explícito segue valendo');
    assert.equal(hasPtAudioMark('Show.2024.Dub.1080p.mkv'), true, 'sem cirílico, o genérico prova PT como sempre');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// DUB/ENGLISH: "English Dubbed" é dublagem EM inglês, não pt-BR. Medido ao
// vivo (2026-09-02, tt0245429): o Spirited Away "English.Dubbed.1080p"
// ocupava o 2º lugar rotulado DUB BR. `ENG` de três letras é a exceção da
// regra de 3+ letras da guarda: `\bENG\b` não casa dentro de nome de grupo
// (-ENGiNE, x264-ENG0 não batem na fronteira) e "Eng Dub" é a grafia
// dominante em anime. Assimetria preservada: ENGLISH NÃO entra em
// hasExplicitForeignAudio — dublagem EN é legítima para quem quer EN, a
// guarda é só de ranking/promessa.
// ---------------------------------------------------------------------------

test('DUB/ENGLISH: English Dubbed e Eng Dub não são dublado pt-BR (caso medido)', () => {
  const spi = '[TorrentCounter.to].Spirited.Away.2001.English.Dubbed.1080p.BluRay.x264.[1.8GB].mp4';
  for (const t of [spi, 'Spirited.Away.2001.English.Dubbed.1080p', 'Some.Anime.English.Dub.1080p', 'Some.Anime.ENG.DUBBED.720p', 'Movie.2024.Eng.Dub.1080p']) {
    assert.notEqual(audioFromTitle(t), 'Dublado', `${t}: dublagem em inglês não é pt-BR`);
    assert.equal(looksPtBr(t), false, `${t}: fora das vagas BR`);
  }
  assert.equal(hasExplicitForeignAudio('Spirited.Away.2001.English.Dubbed.1080p'), false, 'EN não condena sozinho');
  assert.equal(foreignVerdict('Spirited.Away.2001.English.Dubbed.1080p.BluRay.x264'), 'unknown');
});

test('DUB/ENGLISH: PT explícito ao lado vence e o DUB genérico sem idioma segue valendo', () => {
  assert.equal(audioFromTitle('Spirited Away 2001 English Dub DUBLADO 1080p'), 'Dublado', 'DUBLADO explícito vence o English');
  assert.equal(foreignVerdict('Spirited.Away.2001.English.Dub.1080p.PT-BR'), 'absolve', 'com PT explícito, absolve');
  // Antagonista travado (format-audio-quality): DUBBED nu, sem idioma citado,
  // segue provando PT — a guarda só desmente quando o idioma aparece.
  assert.equal(audioFromTitle('Coringa 2019 DUB 1080p'), 'Dublado');
  assert.equal(audioFromTitle('Filme.2024.1080p.WEB-DL.DUBBED.mkv'), 'Dublado');
});

test('DUB/ENGLISH: grupo de cena EN + dublagem declarada dá unknown, nunca condena', () => {
  // Sem a guarda, "English Dub" absolvia via looksPtBr; sem a blindagem do
  // foreignVerdict sobraria strongEnSceneMark(YTS) e o veredito viraria
  // condena — elegível para sweepUndubbed/evicção, APAGANDO da conta. Nome de
  // grupo é indício de ORIGEM, não prova de idioma: contra uma dublagem
  // declarada ele não basta para destruir.
  assert.equal(foreignVerdict('Some.Anime.English.Dub.1080p.BluRay.x264-YTS'), 'unknown', 'dublagem declarada bloqueia o grupo');
  assert.equal(foreignVerdict('Some.Movie.2024.1080p.x264-RARBG'), 'condena', 'grupo SEM dublagem declarada segue condenando');
});
