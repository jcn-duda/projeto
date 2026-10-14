// idxPoolCovered × pack de temporada: o pack não decide cobertura de
// EPISÓDIO — só release que nomeie o episódio pedido cobre a busca.
// Extraído de test/index-fast-path-reconcile.test.ts (teto 400 linhas).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { idxPoolCovered } from '../src/providers/index.js';

// --- Pack de temporada não decide cobertura de EPISÓDIO ----------------------
//
// Caso medido (True Detective S02E01): o índice tinha dois packs do NerdFilmes
// de 22,41 GB e 13,70 GB anunciados "[1080p DUBLADO]". Eles sustentavam a
// cobertura, a busca era servida do índice, o Jackett ia para o tail — e o
// dublado DO EPISÓDIO que a coleta ao vivo traria nunca aparecia. O pack promete
// a temporada, não a faixa de áudio daquele episódio; quem descobria a diferença
// era o usuário, no play.
const pack = (hash: string) => ({
  hash,
  title: 'True Detective 2ª Temporada (2015) [1080p DUBLADO 22.41 GB]',
  seeders: 40,
  quality: '1080p',
  isBr: true,
  dubbed: true,
});

const doEpisodio = (hash: string) => ({
  hash,
  title: 'True Detective 2ª Temporada – (2015) E01 [720p DUBLADO opção 2]',
  seeders: 1,
  quality: '720p',
  isBr: true,
  dubbed: true,
});

test('idxPoolCovered: só packs NÃO cobrem uma busca de episódio', () => {
  assert.equal(
    idxPoolCovered([pack('a1'.repeat(20))] as any, { season: 2, episode: 1 }),
    false,
    'pack não decide que o Jackett pode ficar de fora',
  );
});

test('idxPoolCovered: basta UMA release que nomeie o episódio', () => {
  assert.equal(
    idxPoolCovered([pack('a2'.repeat(20)), doEpisodio('b2'.repeat(20))] as any, { season: 2, episode: 1 }),
    true,
    'com release do episódio no índice, servir dele é honesto',
  );
});

test('idxPoolCovered: o episódio precisa ser o PEDIDO, não outro qualquer', () => {
  assert.equal(
    idxPoolCovered([doEpisodio('c3'.repeat(20))] as any, { season: 2, episode: 7 }),
    false,
    'E01 no índice não cobre E07',
  );
});

test('idxPoolCovered: filme e temporada inteira seguem cobertos por pack', () => {
  // Sem episódio pedido não há promessa fina a quebrar: o pack É a obra.
  assert.equal(idxPoolCovered([pack('d4'.repeat(20))] as any, {}), true, 'filme/obra continua coberto');
  assert.equal(
    idxPoolCovered([pack('e5'.repeat(20))] as any, { season: 2, episode: null }),
    true,
    'busca de temporada continua coberta',
  );
});
