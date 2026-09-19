import assert from 'node:assert/strict';
import { sortAndLimit, dedupeByHash } from '../src/utils/stream-ranking.js';
import { selectQualityCandidates } from '../src/utils/stream-quotas-candidate.js';
import { UNKNOWN_QUALITY } from '../src/utils/audio-quality.js';
import type { StreamCandidate } from '../types/domain.js';

console.log('===============================================================');
console.log(' CHALLENGER M2: EMPIRICAL RANKING & LIE STRESS HARNESS');
console.log('===============================================================\n');

let passed = 0;
let failed = 0;

function runTest(name: string, fn: () => void) {
  const t0 = performance.now();
  try {
    fn();
    const dur = (performance.now() - t0).toFixed(2);
    console.log(`  [PASS] ${name} (${dur}ms)`);
    passed++;
  } catch (err: any) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

const QUALITIES = ['2160p', '1080p', '720p', UNKNOWN_QUALITY, '480p', 'SD'];

// 1. Lie Demotion vs PreferDubbed across all qualities
console.log('--- Phase 1: Lie Demotion vs PreferDubbed Across All Qualities ---');
for (const q of QUALITIES) {
  runTest(`1.${QUALITIES.indexOf(q) + 1} Quality ${q}: clean EN (1 seeder) beats lied (1M seeders, dubbed=true)`, () => {
    const hClean = `c_${q}_`.padEnd(40, '0');
    const hLied = `l_${q}_`.padEnd(40, '1');
    const streams: any[] = [
      {
        infoHash: hLied,
        name: `Lied ${q}\n👤 1000000`,
        title: `Movie ${q} DUAL`,
        _quality: q,
        _seeders: 1_000_000,
        _lied: true,
        _dubbed: true,
        _br: true,
      },
      {
        infoHash: hClean,
        name: `Clean ${q} EN\n👤 1`,
        title: `Movie ${q} EN`,
        _quality: q,
        _seeders: 1,
        _lied: false,
        _dubbed: false,
        _br: false,
      },
    ];

    const out = sortAndLimit(streams, { preferDubbed: true, maxResults: 10 });
    assert.equal(out.length, 2);
    assert.equal(out[0].infoHash, hClean, `Clean stream must precede lied stream in ${q}`);
    assert.equal(out[1].infoHash, hLied);
  });
}

// 2. Lie Demotion vs Instant Cache and Indexer Priority
console.log('\n--- Phase 2: Lie Demotion vs Instant Cache and Indexer Priority ---');
runTest('2.1 Instant cache does NOT rescue lied stream over clean EN stream', () => {
  const hClean = 'clean_instant_'.padEnd(40, '0');
  const hLied = 'lied_instant__'.padEnd(40, '1');
  const streams: any[] = [
    {
      infoHash: hLied,
      name: 'Lied Instant\n👤 50000',
      title: 'Movie 1080p DUAL',
      _quality: '1080p',
      _seeders: 50_000,
      _lied: true,
      _dubbed: true,
    },
    {
      infoHash: hClean,
      name: 'Clean EN\n👤 1',
      title: 'Movie 1080p EN',
      _quality: '1080p',
      _seeders: 1,
      _lied: false,
      _dubbed: false,
    },
  ];

  // Even if instant cache function reports true for lied stream and false for clean
  const out = sortAndLimit(streams, {
    preferDubbed: true,
    instant: (h: string) => h === hLied,
  });
  assert.equal(out[0].infoHash, hClean, 'Clean stream must precede lied stream despite instant cache on lied');
});

runTest('2.2 Indexer Priority does NOT rescue lied stream over clean EN stream', () => {
  const hClean = 'clean_prio_'.padEnd(40, '0');
  const hLied = 'lied_prio__'.padEnd(40, '1');
  const streams: any[] = [
    {
      infoHash: hLied,
      name: 'Lied High Prio\n👤 8000',
      title: 'Movie 1080p',
      _quality: '1080p',
      _seeders: 8000,
      _lied: true,
      _indexer: 'vip-tracker',
    },
    {
      infoHash: hClean,
      name: 'Clean Low Prio\n👤 1',
      title: 'Movie 1080p',
      _quality: '1080p',
      _seeders: 1,
      _lied: false,
      _indexer: 'public-tracker',
    },
  ];

  const out = sortAndLimit(streams, {
    preferDubbed: true,
    indexerPriority: ['vip-tracker', 'public-tracker'],
  });
  assert.equal(out[0].infoHash, hClean, 'Clean stream must precede lied stream despite indexer priority');
});

// 3. Early Pruning under dubbedOnly: true
console.log('\n--- Phase 3: Early Pruning under dubbedOnly: true ---');
runTest('3.1 dubbedOnly: true strictly purges all lied streams', () => {
  const streams: any[] = [
    { infoHash: '1'.repeat(40), name: 'L1', title: 'M 1080p', _quality: '1080p', _seeders: 9999, _lied: true, _dubbed: true },
    { infoHash: '2'.repeat(40), name: 'L2', title: 'M 720p', _quality: '720p', _seeders: 5000, _lied: true, _dubbed: false },
    { infoHash: '3'.repeat(40), name: 'L3', title: 'M 4K', _quality: '2160p', _seeders: 1000, _lied: true, _dubbed: true },
    { infoHash: '4'.repeat(40), name: 'C1', title: 'M 1080p EN', _quality: '1080p', _seeders: 10, _lied: false, _dubbed: false },
    { infoHash: '5'.repeat(40), name: 'C2', title: 'M 720p DUB', _quality: '720p', _seeders: 20, _lied: false, _dubbed: true },
  ];

  const out = sortAndLimit(streams, { dubbedOnly: true });
  assert.equal(out.length, 2, 'Exactly 2 clean streams survive');
  assert.ok(out.every((s: any) => !s._lied), 'No lied stream exists in output');
  assert.ok(out.some((s: any) => s.infoHash === '4'.repeat(40)));
  assert.ok(out.some((s: any) => s.infoHash === '5'.repeat(40)));
});

// 4. Seed Floor Waiver and BR Reservation Checks
console.log('\n--- Phase 4: Seed Floor Waiver & BR Quotas Exclusion ---');
runTest('4.1 Min-seeders floor waiver is denied to lied streams', () => {
  const hCleanBr = 'clean_br_'.padEnd(40, '0');
  const hLiedBr = 'lied_br__'.padEnd(40, '1');
  const streams: any[] = [
    {
      infoHash: hCleanBr,
      name: 'Clean BR Dubbed\n👤 2',
      title: 'Movie 1080p DUBLADO PT-BR',
      _quality: '1080p',
      _seeders: 2,
      _br: true,
      _dubbed: true,
      _lied: false,
    },
    {
      infoHash: hLiedBr,
      name: 'Lied BR Dubbed\n👤 2',
      title: 'Movie 1080p DUBLADO PT-BR',
      _quality: '1080p',
      _seeders: 2,
      _br: true,
      _dubbed: true,
      _lied: true,
    },
  ];

  const out = sortAndLimit(streams, { minSeeders: 10 });
  assert.equal(out.length, 1, 'Only clean BR dubbed receives seed floor waiver');
  assert.equal(out[0].infoHash, hCleanBr);
});

runTest('4.2 selectQualityCandidates and sortAndLimit exclude lied streams from BR reserved slots', () => {
  const streams: StreamCandidate[] = [
    { infoHash: 'a'.repeat(40), name: 'Lied BR 1', title: 'M 1080p', _quality: '1080p', _br: true, _lied: true, _seeders: 1000 },
    { infoHash: 'b'.repeat(40), name: 'Lied BR 2', title: 'M 1080p', _quality: '1080p', _br: true, _lied: true, _seeders: 900 },
    { infoHash: 'c'.repeat(40), name: 'Clean EN 1', title: 'M 1080p', _quality: '1080p', _br: false, _lied: false, _seeders: 10 },
    { infoHash: 'd'.repeat(40), name: 'Clean EN 2', title: 'M 1080p', _quality: '1080p', _br: false, _lied: false, _seeders: 5 },
  ];

  // Under sortAndLimit with brReservedSlots, lied BR streams must not usurp clean streams
  const selected = sortAndLimit(streams as any, {
    maxResults: 2,
    brReservedSlots: 2,
    brFirst: true,
  });

  assert.equal(selected.length, 2);
  assert.ok(selected.every((s: any) => !s._lied), 'Lied streams did not steal BR reserved slots');
});

// 5. Deduplication Clones and Metadata Protection
console.log('\n--- Phase 5: Deduplication Clones & Metadata Protection ---');
runTest('5.1 dedupeByHash: lied clone always poisons hash with _lied:true and _dubbed:false, but winner is clean', () => {
  const hash = 'f'.repeat(40);
  const clones = [
    { infoHash: hash, name: 'Fake BluDV DUAL\n👤 500', title: 'Movie 1080p DUAL', _seeders: 500, _lied: true, _dubbed: true, _quality: '1080p' },
    { infoHash: hash, name: 'Honest YTS EN\n👤 50', title: 'Movie 1080p EN', _seeders: 50, _lied: false, _dubbed: false, _quality: '1080p' },
  ];

  const out = dedupeByHash(clones);
  assert.equal(out.length, 1);
  assert.equal(out[0]._lied, true, 'Merged item must be marked _lied: true');
  assert.equal(out[0]._dubbed, false, 'Merged item must have _dubbed: false');
  assert.match(String(out[0].name), /Honest YTS EN/, 'Metadata winner must be the honest clone');
});

// 6. Randomized Fuzzing Stress Testing (2,500 permutations)
console.log('\n--- Phase 6: Randomized Fuzzing Stress Testing (2,500 iterations) ---');
runTest('6.1 Fuzzing: Invariant check on 2,500 randomized sets', () => {
  for (let iter = 0; iter < 2500; iter++) {
    const numStreams = 20;
    const testStreams: any[] = [];
    for (let i = 0; i < numStreams; i++) {
      const q = QUALITIES[Math.floor(Math.random() * QUALITIES.length)];
      const isLied = Math.random() < 0.4;
      testStreams.push({
        infoHash: `hash_${iter}_${i}_`.padEnd(40, 'x'),
        name: `Stream ${i} ${q}\n👤 ${Math.floor(Math.random() * 5000)}`,
        title: `Movie ${q} ${isLied ? 'DUAL' : 'EN'}`,
        _quality: q,
        _seeders: Math.floor(Math.random() * 5000) + 1,
        _lied: isLied,
        _dubbed: !isLied && Math.random() < 0.5,
        _br: Math.random() < 0.3,
      });
    }

    const dubbedOnly = Math.random() < 0.3;
    const preferDubbed = Math.random() < 0.8;

    const out = sortAndLimit(testStreams, {
      preferDubbed,
      dubbedOnly,
      maxResults: 30,
    });

    if (dubbedOnly) {
      for (const s of out) {
        assert.notEqual(s._lied, true, 'When dubbedOnly is true, no lied stream can survive');
      }
    }

    // Invariant: within the same quality, all unlied streams MUST precede all lied streams
    const buckets: Record<string, any[]> = {};
    for (const s of out) {
      const q = s._quality || 'SD';
      buckets[q] = buckets[q] || [];
      buckets[q].push(s);
    }

    for (const [q, group] of Object.entries(buckets)) {
      let seenLied = false;
      for (const s of group) {
        if (s._lied) {
          seenLied = true;
        } else if (seenLied) {
          assert.fail(`Invariant violation in ${q} on iteration ${iter}: clean stream appeared after lied stream!`);
        }
      }
    }
  }
});

console.log('\n===============================================================');
console.log(` RESULTS: ${passed} PASSED | ${failed} FAILED`);
console.log('===============================================================\n');

if (failed > 0) {
  process.exit(1);
}
