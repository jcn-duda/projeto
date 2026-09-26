// Roteamento do índice quando o dn= do magnet é mais específico que o título
// do post (pack "4ª Temporada" + dn S04E03 → chave do E03).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { record, lookup } from '../src/utils/release-index.js';
import * as metrics from '../src/utils/metrics.js';

const serieRel = (hash: string, title: string, extra: Record<string, unknown> = {}) => ({
  title,
  infoHash: hash,
  seeders: 9,
  size: 1024 ** 3,
  indexer: 'globaltracker',
  ...extra,
});

test('dn do magnet mais específico que o título pack roteia para o episódio do dn', () => {
  const hash = 'a1'.repeat(20);
  const title = 'True Detective - 4ª Temporada [1080p WEB-DL DUAL]';
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=True.Detective.S04E03.1080p.WEB-DL.DUAL`;
  const before = metrics.snapshot().counters['search.idx.routed'] || 0;
  record('tt9000110', { season: 4, episode: 1 }, [
    serieRel(hash, title, { magnet, isBr: true }),
  ]);
  // Título sozinho seria pack S4; dn S04E03 vence → chave do E03.
  assert.ok(cache.get(`${prefix('idx')}tt9000110:S4E3`), 'gravou na chave do E03 do dn');
  assert.ok(!cache.get(`${prefix('idx')}tt9000110:S4E1`), 'não ficou sob o episódio pedido');
  assert.ok(!cache.get(`${prefix('idx')}tt9000110:S4`), 'não caiu na temporada genérica do título');
  assert.deepEqual(
    lookup('tt9000110', { season: 4, episode: 3 }).map((r) => r.hash),
    [hash],
    'release alcançável no E03 — não sumiu',
  );
  assert.ok(
    (metrics.snapshot().counters['search.idx.routed'] || 0) > before,
    'destino ≠ pedido incrementa search.idx.routed',
  );
});

test('sem dn continua roteando só pelo título (pack genérico → temporada)', () => {
  const hash = 'b1'.repeat(20);
  record('tt9000111', { season: 4, episode: 1 }, [
    serieRel(hash, 'True Detective - 4ª Temporada [1080p WEB-DL DUAL]', { isBr: true }),
  ]);
  assert.ok(cache.get(`${prefix('idx')}tt9000111:S4`), 'pack sem dn → chave da temporada');
  assert.ok(!cache.get(`${prefix('idx')}tt9000111:S4E1`), 'não suja a chave do episódio pedido');
  assert.equal(lookup('tt9000111', { season: 4, episode: 1 }).length, 1, 'lookup do pedido ainda alcança o pack');
});
