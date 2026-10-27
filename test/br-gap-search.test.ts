// Integração real do índice ao corte final: release do índice
// (`idxReleasesToRaw`) BR dublada com 0 seeders sobrevive ao piso no
// `sortAndLimit`, marcada para que o download siga exigindo swarm.
//
// O outro elo que morava aqui — `harvestOne` detectar a transição a BR dublado e
// invalidar a obra — saiu com o colhedor TS: a transição agora é do
// `adom-harvest` (Rust) e o canário é `cargo test -p adom-harvest`. O que sobra
// no Node é o índice TS, que este arquivo exercita.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import * as cache from '../src/utils/cache.js';
import * as releaseIndex from '../src/utils/release-index.js';
import { idxReleasesToRaw } from './helpers/pipeline-oracle/idx-raw.js';
import { sortAndLimit, toStremioStream } from './helpers/pipeline-oracle/format.js';
import type { RawItem } from '../types/domain.js';

test('índice → sortAndLimit: release BR dublada com 0 seeders sobrevive ao piso', async () => {
  const OBRA = 'tt9000213';
  try {
    releaseIndex.record(OBRA, {}, [
      {
        title: 'Test Title 2024 1080p DUBLADO',
        infoHash: '33'.repeat(20),
        seeders: 0,
        isBr: true,
        indexer: 'redetorrent',
      },
      { title: 'Test Title 2024 1080p WEB-DL', infoHash: '44'.repeat(20), seeders: 88, indexer: 'thepiratebay' },
    ], {});

    const raw = idxReleasesToRaw(releaseIndex.lookup(OBRA, {}));
    const streams = raw.map((it) => toStremioStream(it as RawItem)).filter(Boolean) as any[];
    const br = streams.find((s: any) => s._br === true);
    assert.equal(br != null, true, 'release BR nasce do índice');
    assert.equal(br._dubClaim, true, 'e declara dublado (claim)');
    assert.equal(br._dubbed, false, 'sem fileEvidence ainda');

    const out = sortAndLimit(streams, { minSeeders: 1, maxResults: 20 });
    const waivered = out.find((s: any) => s.infoHash === br.infoHash);
    assert.equal(waivered != null, true, '0 seeders não mata a BR com claim vinda do índice');
    assert.equal(waivered._seedFloorWaived, true, 'viaja marcada para que o download siga exigendo piso');
  } finally {
    cache.clear();
  }
});
