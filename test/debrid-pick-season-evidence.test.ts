// pickFile: prova de temporada unânime em pack multi-arquivo (extras, vinhetas,
// arquivo mudo, multi-temporada, disco de extras). Extraído de
// debrid-pick-episodes.test.ts pelo orçamento de 400 linhas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickFile,
  isEpisodePickError,
} from '../src/debrid/common.js';

const f = (path: string, size = 1_000_000) => ({ path, size });

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
