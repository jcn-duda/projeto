import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickFile,
  NoVideoError,
  isEpisodePickError,
} from '../src/debrid/common.js';

const f = (path: string, size = 1_000_000) => ({ path, size });

test('pickFile distingue listagem vazia de torrent sem vídeo', () => {
  // Listagem COM arquivos e nenhum vídeo é prova determinística de magnet
  // quebrado: lança NoVideoError para o /resolve gravar bad no banco.
  assert.throws(() => pickFile([{ path: 'readme.txt', size: 100 }], {}), NoVideoError);
  // Listagem VAZIA é transferência fria ("ainda baixando"): null, prova nenhuma.
  assert.equal(pickFile([], {}), null);
});

// Vídeo único com nome técnico: o caso True Detective S03E02. O pack anunciava
// a temporada 3 mas continha só "S03E07" — o fallback antigo tocava o episódio
// 7 em silêncio. Agora o nome do arquivo é conferido contra o pedido.
test('pickFile: vídeo único com OUTRO episódio lança EpisodePickError com evidência', () => {
  assert.throws(
    () => pickFile([f('True.Detective.S03E07.1080p.WEB.mkv', 2 * 1024 ** 3)], { season: 3, episode: 2 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err), 'erro tipado');
      assert.ok(Array.isArray(err.evidence?.declaredEpisodes), 'evidência presente');
      assert.ok(err.evidence.declaredEpisodes.includes(7), 'o arquivo declara o episódio 7');
      assert.equal(err.evidence.wantedEpisode, 2);
      assert.equal(err.evidence.wantedSeason, 3);
      return true;
    },
  );
});

test('pickFile: vídeo único de OUTRA temporada (sem episódio) também lança', () => {
  assert.throws(
    () => pickFile([f('Show.S02.1080p.mkv', 2 * 1024 ** 3)], { season: 3, episode: 2 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence.declaredSeasons.includes(2), 'declara a temporada 2');
      assert.equal(err.evidence.declaredEpisodes.length, 0, 'sem episódio declarado');
      return true;
    },
  );
});

test('pickFile: episódio certo em temporada errada lança (dimensões independentes)', () => {
  // O arquivo casa o episódio 5 pedido, mas declara a temporada 2 — a
  // checagem de temporada não pode depender de "não haver episódio declarado",
  // senão este caso tocava o episódio certo da temporada errada.
  assert.throws(
    () => pickFile([f('Show.S02E05.1080p.mkv', 2 * 1024 ** 3)], { season: 3, episode: 5 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence.declaredSeasons.includes(2), 'declara a temporada 2');
      assert.ok(err.evidence.declaredEpisodes.includes(5), 'declara o episódio 5 (que casa)');
      return true;
    },
  );
});

test('pickFile: vídeo único com o episódio certo resolve normalmente', () => {
  const file = pickFile([f('Show.S03E02.mkv', 2 * 1024 ** 3)], { season: 3, episode: 2 });
  assert.equal(file!.path, 'Show.S03E02.mkv');
});

test('pickFile: nomes sem declaração de s/e continuam passando (compatibilidade)', () => {
  // Torrent de episódio sem nome técnico, filme sem s/e e token de resolução
  // (1920x1080 não pode virar S20/E108 no parse) — nenhum pode condenar.
  assert.equal(
    pickFile([f('episodio-sem-nome.mkv', 1)], { season: 1, episode: 5 })!.path,
    'episodio-sem-nome.mkv',
  );
  assert.equal(
    pickFile([f('Filme.2019.1080p.BluRay.x264.mkv', 1)], { season: 1, episode: 5 })!.path,
    'Filme.2019.1080p.BluRay.x264.mkv',
  );
  assert.equal(
    pickFile([f('Show.1920x1080.WEB.mkv', 1)], { season: 1, episode: 5 })!.path,
    'Show.1920x1080.WEB.mkv',
  );
  // Nome de série inteira cobre qualquer episódio.
  assert.equal(
    pickFile([f('Show Todas as Temporadas 1080p.mkv', 1)], { season: 1, episode: 5 })!.path,
    'Show Todas as Temporadas 1080p.mkv',
  );
});

test('pickFile: tag de áudio colada em dígito não vira temporada', () => {
  // O padrão de temporada do parseTitleSeasonEpisode (`s(\d)`) não exige
  // fronteira à esquerda, então "DTS5.1"/"Atmos5.1" eram lidos como S05 e
  // condenavam episódio legítimo sem marcador no nome — o arquivo não declara
  // temporada nenhuma, e recusar aqui é 404 em play bom.
  for (const path of [
    'Nome.do.Episodio.DTS5.1.mkv',
    'Nome.do.Episodio.Atmos5.1.mkv',
    'O.Distante.Brilho.DTS5.1.x264.mkv',
  ]) {
    assert.equal(pickFile([f(path, 1)], { season: 3, episode: 2 })!.path, path, path);
  }
  // A limpeza não pode cegar a checagem: "S03"/"S02" com separador antes
  // continuam sendo temporada de verdade, com ou sem a tag de áudio ao lado.
  assert.equal(
    pickFile([f('Show.S03.1080p.DTS5.1.mkv', 1)], { season: 3, episode: 2 })!.path,
    'Show.S03.1080p.DTS5.1.mkv',
  );
  assert.throws(
    () => pickFile([f('Show.S02.1080p.DTS5.1.mkv', 1)], { season: 3, episode: 2 }),
    (err) => isEpisodePickError(err),
  );
});

test('pickFile: layout de canais de áudio não vira episódio nu', () => {
  // Caso medido no True Detective: "…S03E07…DDP5.1.H.264-NTb.mkv" casava o
  // EPISÓDIO 1 pelo "1" nu de "DDP5.1", e como "S03" satisfazia a temporada
  // isso virava escolha FORTE — o play do E01 recebia o E07 antes de qualquer
  // checagem. Vale para o episódio 1 de qualquer série com áudio 5.1/7.1.
  const e07 = 'True.Detective.S03E07.The.Final.Country.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.mkv';
  for (const episode of [1, 2, 5]) {
    assert.throws(
      () => pickFile([f(e07, 3 * 1024 ** 3)], { season: 3, episode }),
      (err) => isEpisodePickError(err),
      `E07 não pode servir o episódio ${episode}`,
    );
  }
  assert.equal(pickFile([f(e07, 1)], { season: 3, episode: 7 })!.path, e07, 'o episódio dele continua tocando');
  for (const path of ['Show.S02E09.1080p.TrueHD.7.1.Atmos.mkv', 'Show.S02E09.1080p.AAC2.0.mkv']) {
    assert.throws(
      () => pickFile([f(path, 1)], { season: 2, episode: 1 }),
      (err) => isEpisodePickError(err),
      path,
    );
  }

  // O episódio 1 de verdade continua casando, nas três formas que o achavam
  // antes — inclusive as que dependem do número nu ("S03.01", "S5.1").
  const ok: [string[], number, number, string][] = [
    [['True.Detective.S03E01.1080p.AMZN.WEB-DL.DDP5.1.mkv'], 3, 1, 'True.Detective.S03E01.1080p.AMZN.WEB-DL.DDP5.1.mkv'],
    [['Show/Temporada 3/Episodio 01 DDP5.1.mkv'], 3, 1, 'Show/Temporada 3/Episodio 01 DDP5.1.mkv'],
    [['Show.S03.01.DDP5.1.mkv', 'Show.S03.02.DDP5.1.mkv'], 3, 1, 'Show.S03.01.DDP5.1.mkv'],
    [['Show.S5.1.mkv', 'Show.S5.2.mkv'], 5, 1, 'Show.S5.1.mkv'],
    [['S01E05.1080p.DDP5.1.mkv', 'S01E01.1080p.DDP5.1.mkv'], 1, 1, 'S01E01.1080p.DDP5.1.mkv'],
  ];
  for (const [paths, season, episode, esperado] of ok) {
    const file = pickFile(paths.map((p, i) => f(p, i + 1)), { season, episode });
    assert.equal(file!.path, esperado, paths.join(' + '));
  }
});

test('pickFile: propaganda do site não conta como vídeo do pack', () => {
  // Caso medido (hash 4014bd0d, TorBox): episódio SOLTO anunciado como "3ª
  // Temporada", com o vídeo de propaganda do site junto. O .mp4 contava na
  // contagem, `videos.length > 1` disparava o throw AMBÍGUO, e a prova de
  // episódio errado que existia no nome do conteúdo nunca era lida — a fonte
  // não tocava e também nunca saía da lista.
  const pack = [
    f('COMANDOTORRENTS.COM.mp4', 5 * 1024 ** 2),
    f('True.Detective.S03E03.720p.WEB-DL.DUAL.WWW.COMANDOTORRENTS.COM.mkv', 2 * 1024 ** 3),
  ];
  for (const episode of [1, 2]) {
    assert.throws(
      () => pickFile(pack, { season: 3, episode }),
      (err: any) => isEpisodePickError(err) && Boolean(err.evidence) && err.evidence.declaredEpisodes.includes(3),
      `E${episode} recusado COM prova de que o conteúdo é o E03`,
    );
  }
  assert.equal(
    pickFile(pack, { season: 3, episode: 3 })!.path,
    'True.Detective.S03E03.720p.WEB-DL.DUAL.WWW.COMANDOTORRENTS.COM.mkv',
    'o episódio dele continua tocando',
  );

  // O domínio NO MEIO do nome é conteúdo, não propaganda — a âncora do padrão
  // é o que separa os dois.
  assert.equal(
    pickFile([f('True.Detective.S03E01.WWW.COMANDOTORRENTS.COM.mkv', 1)], { season: 3, episode: 1 })!.path,
    'True.Detective.S03E01.WWW.COMANDOTORRENTS.COM.mkv',
  );

  // Torrent que SÓ tem propaganda segue pelo caminho antigo: virar NoVideoError
  // aqui condenaria o hash no banco de magnets por 24h.
  assert.equal(
    pickFile([f('WWW.BLUDV.TV.mp4', 5 * 1024 ** 2)], { season: 3, episode: 1 })!.path,
    'WWW.BLUDV.TV.mp4',
  );
});

// Bug real medido no addon (2026-08-24): tocando House of the Dragon S01E01
// pela fonte dublada do comandotorrents, o player abria
// "1XBET.COM_promo_SHREK_dinheiro_livre.mp4" — legenda certa, vídeo de
// propaganda. Duas falhas somadas, e cada uma sozinha já bastava:
//
// 1. `isSiteAd` só reconhecia o nome que é SÓ o domínio ("www.BLUDV.com.mp4");
//    com a propaganda depois do TLD ("1XBET.COM_promo_...") o arquivo passava
//    como vídeo comum.
// 2. A PASTA do torrent carrega o SxxEyy, então os três arquivos casavam o
//    episódio pelo caminho e o desempate era `strong[0]` — a ORDEM do torrent,
//    que não diz nada sobre conteúdo. A propaganda vinha primeiro.
const HOTD_DIR = 'House.of.the.Dragon.S01E01.1080p.FULL.WEB-DL.DUAL.5.1';
const HOTD_PACK = [
  f(`${HOTD_DIR}/1XBET.COM_promo_SHREK_dinheiro_livre.mp4`, 22_983_105),
  f(`${HOTD_DIR}/House.of.the.Dragon.S01E01.1080p.WEB-DL.DUAL.5.1.mp4`, 65_685_451),
  f(`${HOTD_DIR}/House.of.the.Dragon.S01E01.1080p.WEB-DL.DUAL.mkv`, 4_605_702_076),
];

test('pickFile: propaganda com texto depois do domínio não vence o episódio (1XBET × House of the Dragon)', () => {
  assert.equal(
    pickFile(HOTD_PACK, { season: 1, episode: 1 })!.path,
    `${HOTD_DIR}/House.of.the.Dragon.S01E01.1080p.WEB-DL.DUAL.mkv`,
  );
});

test('pickFile: pasta com SxxEyy não deixa a ORDEM do torrent decidir o empate', () => {
  // Sem nenhum nome de arquivo trazendo o marcador, o caminho inteiro volta a
  // valer (a pasta é a única pista) — e aí o tamanho desempata, não a ordem.
  const soPasta = [
    f('Serie.S02E05.1080p/1XBET.COM_promo.mp4', 20_000_000),
    f('Serie.S02E05.1080p/video.mkv', 3_000_000_000),
  ];
  assert.equal(pickFile(soPasta, { season: 2, episode: 5 })!.path, 'Serie.S02E05.1080p/video.mkv');
});

test('pickFile: pack de temporada continua entregando o episódio PEDIDO, não o maior', () => {
  // A guarda de tamanho só desempata entre arquivos do MESMO episódio; num pack
  // com um episódio por arquivo, cada pedido tem um só candidato.
  const temporada = [f('Serie.S01.COMPLETA/Serie.S01E01.mkv', 1e9), f('Serie.S01.COMPLETA/Serie.S01E02.mkv', 9e9), f('Serie.S01.COMPLETA/Serie.S01E03.mkv', 2e9)];
  assert.equal(pickFile(temporada, { season: 1, episode: 1 })!.path, 'Serie.S01.COMPLETA/Serie.S01E01.mkv');
  assert.equal(pickFile(temporada, { season: 1, episode: 2 })!.path, 'Serie.S01.COMPLETA/Serie.S01E02.mkv');
});

test('pickFile: token que por acaso é TLD não transforma arquivo legítimo em propaganda', () => {
  // O separador exigido depois do TLD é `_`/`-`/espaço, nunca ponto: com ponto,
  // "Filme.se.algo..." seria classificado como propaganda e sairia do pool.
  const legitimo = [f('Filme.se.algo.S01E01.mkv', 1_500_000_000)];
  assert.equal(pickFile(legitimo, { season: 1, episode: 1 })!.path, 'Filme.se.algo.S01E01.mkv');
});

test('pickFile: pack multi-arquivo com temporada errada unânime lança EpisodePickError com evidência de temporada', () => {
  // Caso True Detective c1ee2879: 8 episódios T01Exx servidos para S03E01
  const pack = [
    f('True Detective 1 Temporada 720p/True Detective - T01E01 - A Longa e Luminosa Escuridao.mkv'),
    f('True Detective 1 Temporada 720p/True Detective - T01E02 - Vendo Coisas.mkv'),
    f('True Detective 1 Temporada 720p/True Detective - T01E03 - O Quarto Trancado.mkv'),
    f('True Detective 1 Temporada 720p/True Detective - T01E04 - Quem Vai La.mkv'),
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err), 'deve ser EpisodePickError');
      assert.ok(err.evidence, 'deve ter evidence');
      assert.deepEqual(err.evidence.declaredSeasons, [1]);
      assert.deepEqual(err.evidence.declaredEpisodes, []);
      assert.equal(err.evidence.wantedSeason, 3);
      assert.equal(err.evidence.wantedEpisode, 1);
      assert.ok(err.evidence.sample.includes('T01E01'));
      assert.ok(err.context, 'context deve ser mantido');
      assert.equal(err.context.videoCount, 4);
      return true;
    },
  );
});

test('pickFile: pack multi-arquivo da temporada CERTA sem o episódio pedido continua sem evidence', () => {
  // Temporada certa, mas falta o episódio 5 (pack incompleto S03E01-E04)
  const pack = [
    f('True.Detective.S03E01.mkv'),
    f('True.Detective.S03E02.mkv'),
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 5 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.equal(err.evidence, undefined, 'não deve ter evidence quando temporada bate');
      assert.ok(err.context, 'deve manter context com videoCount e samples');
      return true;
    },
  );
});

test('pickFile: pack multi-temporada (S01 + S02) NÃO condena por unânime', () => {
  const pack = [
    f('Show.S01E01.mkv'),
    f('Show.S02E01.mkv'),
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.equal(err.evidence, undefined, 'não unânime: sem evidence');
      assert.ok(err.context);
      return true;
    },
  );
});

test('pickFile: arquivo mudo (sem temporada identificável) anula prova de temporada unânime', () => {
  const pack = [
    f('True.Detective.S01E01.mkv'),
    f('True.Detective.S01E02.mkv'),
    f('True.Detective.Special.mkv'), // mudo
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.equal(err.evidence, undefined, 'arquivo mudo impede certeza unânime');
      assert.ok(err.context);
      return true;
    },
  );
});

test('pickFile: tags de áudio (DTS5.1, Atmos5.1) em nomes não geram temporada espúria no unânime', () => {
  const pack = [
    f('Show.DTS5.1.mkv'),
    f('Show.Atmos7.1.mkv'),
  ];
  // Sem temporada real declarada -> declared.seasons.length === 0 -> mudo -> sem evidence
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.equal(err.evidence, undefined);
      return true;
    },
  );
});

test('pickFile: arquivos de extras são ignorados na unânime', () => {
  const pack = [
    f('True.Detective.S01E01.mkv'),
    f('True.Detective.S01E02.mkv'),
    f('True.Detective.Extra.Making.Of.mkv'), // extra é filtrado
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence, 'extra ignorado, restantes são unânimes S1');
      assert.deepEqual(err.evidence.declaredSeasons, [1]);
      return true;
    },
  );
});

test('pickFile: se todos os arquivos forem extras, pool de fallback é usado', () => {
  const pack = [
    f('Extra.Featurette.S01.mkv'),
    f('Behind.The.Scenes.S01.mkv'),
  ];
  assert.throws(
    () => pickFile(pack, { season: 3, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence, 'fallback usou todos os arquivos e achou S1 unânime');
      assert.deepEqual(err.evidence.declaredSeasons, [1]);
      return true;
    },
  );
});

test('pickFile: vinhetas e créditos de uploader (<15MB ou com padrão uploader) são ignorados na unânime', () => {
  // Caso real: pack S01 com vinheta "Lucas Firmo UPLOADER.mp4" (1.08 MB) sem temporada.
  // Não deve impedir a detecção unânime da temporada 1 para rejeitar busca de temporada 2.
  const pack = [
    f('True.Detective.T01E01.mkv', 1.5 * 1024 ** 3),
    f('True.Detective.T01E02.mkv', 1.5 * 1024 ** 3),
    f('Lucas Firmo UPLOADER.mp4', 1.08 * 1024 * 1024),
  ];
  assert.throws(
    () => pickFile(pack, { season: 2, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence, 'vinheta/uploader ignorada, episódios restantes são unânimes S1');
      assert.deepEqual(err.evidence.declaredSeasons, [1]);
      return true;
    },
  );
});

test('pickFile: vinheta com promo/trailer/isSiteAd ignorada mesmo se > 15MB quando houver outros vídeos', () => {
  const pack = [
    f('True.Detective.S01E01.mkv', 2 * 1024 ** 3),
    f('True.Detective.S01E02.mkv', 2 * 1024 ** 3),
    f('Promo.Special.Trailer.mp4', 30 * 1024 * 1024),
  ];
  assert.throws(
    () => pickFile(pack, { season: 2, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence, 'promo ignorada, episódios restantes são unânimes S1');
      assert.deepEqual(err.evidence.declaredSeasons, [1]);
      return true;
    },
  );
});


test('pickFile: disco de extras sem temporada vira prova de temporada ausente', () => {
  // Medido em prod: NerdFilmes listado como True Detective S4E1 era o disco de bônus.
  const disc = [
    f('A Conversation with Nic Pizzolatto and T Bone Burnett.mkv'),
    f('Episode 3, Scene #29.mkv'),
    f('Episode 5, Scene #10.mkv'),
    f('Making of.mkv'),
  ];
  assert.throws(
    () => pickFile(disc, { season: 4, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.ok(err.evidence, 'extras: evidence presente');
      assert.deepEqual(err.evidence.declaredSeasons, []);
      assert.deepEqual(err.evidence.declaredEpisodes, []);
      return true;
    },
  );
});

test('pickFile: pack mudo sem cara de extras continua sem evidence', () => {
  const pack = [f('Parte Um.mkv'), f('Parte Dois.mkv'), f('Parte Tres.mkv')];
  assert.throws(
    () => pickFile(pack, { season: 4, episode: 1 }),
    (err: any) => {
      assert.ok(isEpisodePickError(err));
      assert.equal(err.evidence, undefined);
      return true;
    },
  );
});
