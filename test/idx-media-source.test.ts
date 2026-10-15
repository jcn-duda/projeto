// mediaSource no índice: CAM do magnet sobrevive ao caminho idx → raw → stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, lookup } from '../src/utils/release-index.js';
import { idxReleasesToRaw } from '../src/providers/search-pool-coverage.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { sortAndLimit } from '../src/utils/stream-ranking.js';

test('índice grava mediaSource CAM do magnet e toStremioStream rotula sem URI', () => {
  const hash = 'c1'.repeat(20);
  record('tt9000400', {}, [{
    title: 'Resident Evil (2026) [1080p 2.60 GB]',
    infoHash: hash,
    magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent('Resident.Evil.2026.1080p.CAMRip.x264')}`,
    seeders: 5,
    indexer: 'comandotorrents',
    isBr: true,
  }]);
  const out = lookup('tt9000400');
  assert.equal(out[0]?.mediaSource, 'CAM');
  const raw = idxReleasesToRaw(out)[0];
  assert.equal(raw.mediaSource, 'CAM');
  assert.ok(!('magnet' in raw));
  const stream = toStremioStream(raw);
  assert.match(String(stream!.name), /CAM/);
  assert.equal(stream!._magnetDn, 'CAMRip');
  assert.equal(sortAndLimit([stream!], { excludeCam: true }).length, 0);
});

test('toStremioStream: mediaSource CAM sem magnet rotula e alimenta excludeCam', () => {
  const stream = toStremioStream({
    title: 'Resident Evil (2026) [1080p 2.60 GB]',
    infoHash: 'c2'.repeat(20),
    seeders: 10,
    mediaSource: 'CAM',
  });
  assert.match(String(stream!.name), /CAM/);
  assert.equal(stream!._magnetDn, 'CAMRip');
  assert.equal(sortAndLimit([stream!], { excludeCam: true }).length, 0);
});
