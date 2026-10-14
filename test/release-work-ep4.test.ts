// Episódio de 4 dígitos no roteamento de obra (One Piece E1000+, 2026-09-28):
// o truncamento E1176→E117 fazia a rota/índice cobrirem o episódio ERRADO —
// a release era recuperável na busca do E117 e nunca na do E1176 real.
// Mesma régua do `routeWorkLocation`/`releaseWorkTargets` (release-work.ts).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { releaseFitsRequest, releaseWorkTargets, routeWorkLocation } from '../src/utils/release-work.js';

describe('roteamento com episódio de 4 dígitos', () => {
  test('dn com E1176 roteia para o episódio REAL, não para o truncado', () => {
    const dn = '[NanakoRaws] One Piece S01E1176 (BS8 TV 1080p HEVC AAC)';
    assert.deepEqual(routeWorkLocation({ season: 1, episode: 117 }, 'One Piece', dn), { season: 1, episode: 1176 });
    const targets = releaseWorkTargets('One Piece', { season: 1, episode: 1176 }, dn);
    assert.deepEqual(targets, [{ season: 1, episode: 1176 }]);
  });

  test('releaseFitsRequest NÃO nega o episódio de 4 dígitos', () => {
    assert.equal(releaseFitsRequest({ season: 1, episode: 1176 }, 'One Piece', 'One.Piece.S01E1176'), true);
    assert.equal(releaseFitsRequest({ season: 1, episode: 1175 }, 'One Piece', 'One.Piece.S01E1176'), false);
  });
});
