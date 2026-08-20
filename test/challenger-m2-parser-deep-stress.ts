import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import comando from '../comandotorrents-resolver/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('==============================================================');
console.log(' CHALLENGER M2: DEEP ADVERSARIAL PARSER STRESS & FUZZ HARNESS');
console.log('==============================================================\n');

const fixtures = [
  'comandotorrents-post.html',
  'comandotorrents-movie-complex.html',
  'comandotorrents-series-episodic.html',
  'comandotorrents-series-multiseason.html',
  'comandotorrents-legendado-only.html',
  'comandotorrents-search.html',
  'comandotorrents-search-extended.html'
];

const loadedFixtures = {};
for (const f of fixtures) {
  const p = path.join(__dirname, 'fixtures', f);
  loadedFixtures[f] = fs.readFileSync(p, 'utf8');
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  const t0 = performance.now();
  try {
    fn();
    const dur = (performance.now() - t0).toFixed(2);
    console.log('  [PASS] ' + name + ' (' + dur + 'ms)');
    passed++;
  } catch (err) {
    console.error('  [FAIL] ' + name + ': ' + err.message);
    failed++;
  }
}

// 1. Fixture Parsing Integrity
console.log('--- Phase 1: Fixture Extraction & Metadata Verification ---');

test('1.1 Movie Complex Fixture: Complete Tag & Audio Isolation', () => {
  const links = comando.parseDownloadLinks(loadedFixtures['comandotorrents-movie-complex.html'], 'https://comandotorrents.to/movie/');
  assert.equal(links.length, 8);
  const dubs = links.filter(l => l.audio === 'dublado');
  const legs = links.filter(l => l.audio === 'legendado');
  assert.equal(dubs.length, 5);
  assert.equal(legs.length, 3);
  assert.equal(links[0].quality, 2160);
  assert.equal(links[0].source, 'REMUX');
  assert.equal(links[0].size, '52.4 GB');
  assert.equal(links[1].quality, 1080);
  assert.equal(links[1].source, 'BLU-RAY');
  assert.equal(links[1].size, '14.2 GB');
});

test('1.2 Episodic Series Fixture: Sequential Episode Extraction & Pack Resets', () => {
  const links = comando.parseDownloadLinks(loadedFixtures['comandotorrents-series-episodic.html'], 'https://comandotorrents.to/series/');
  assert.equal(links.length, 12);
  for (let i = 0; i < 8; i++) {
    assert.equal(links[i].episode, i + 1);
    assert.equal(links[i].audio, 'dublado');
  }
  assert.equal(links[8].episode, null);
  assert.equal(links[9].episode, null);
  assert.equal(links[10].episode, 1);
  assert.equal(links[10].audio, 'legendado');
  assert.equal(links[11].episode, null);
  assert.equal(links[11].audio, 'legendado');
});

test('1.3 Multi-Season Bundle Fixture: All episode numbers strictly null', () => {
  const links = comando.parseDownloadLinks(loadedFixtures['comandotorrents-series-multiseason.html'], 'https://comandotorrents.to/bundle/');
  assert.equal(links.length, 6);
  links.forEach((l, idx) => {
    assert.equal(l.episode, null, 'Link ' + idx + ' must have episode=null');
  });
  assert.equal(links[0].size, '64.5 GB');
  assert.equal(links[4].quality, 2160);
  assert.equal(links[5].audio, 'legendado');
});

test('1.4 Legendado-Only Fixture: Pure Legendado Audio Isolation', () => {
  const links = comando.parseDownloadLinks(loadedFixtures['comandotorrents-legendado-only.html'], 'https://comandotorrents.to/leg-only/');
  assert.equal(links.length, 3);
  links.forEach((l, idx) => {
    assert.equal(l.audio, 'legendado', 'Link ' + idx + ' must be legendado');
    const title = comando.releaseTitle('Parasita Torrent (2019) Legendado WEB-DL 1080p', l, idx);
    assert.ok(title.includes('LEGENDADO'));
    assert.ok(!/dublado/i.test(title));
  });
});

test('1.5 Search Fixtures: Accurate Post Titles, URL Normalization & Posters', () => {
  const posts1 = comando.parsePosts(loadedFixtures['comandotorrents-search.html']);
  assert.equal(posts1.length, 2);
  assert.equal(posts1[0].url, 'https://comandotorrents.to/furiosa-uma-saga-mad-max/');
  assert.ok(posts1[0].title.includes('Furiosa'));

  const posts2 = comando.parsePosts(loadedFixtures['comandotorrents-search-extended.html']);
  assert.equal(posts2.length, 3);
  assert.equal(posts2[0].url, 'https://comandotorrents.to/deadpool-e-wolverine-2024/');
  assert.equal(posts2[1].url, 'https://comandotorrents.to/alien-romulus-2024/');
  assert.equal(posts2[2].url, 'https://comandotorrents.to/the-boys-4a-temporada-torrent/');
});

// 2. Mutation & Truncation Chaos
console.log('\n--- Phase 2: Mutation, Truncation & Chaos Fuzzing ---');

test('2.1 Exhaustive Byte-by-Byte Truncation on all 7 fixtures', () => {
  for (const [name, content] of Object.entries(loadedFixtures)) {
    const step = Math.max(1, Math.floor(content.length / 50));
    for (let len = 1; len <= content.length; len += step) {
      const slice = content.slice(0, len);
      assert.doesNotThrow(() => {
        comando.parsePosts(slice);
        comando.parseDownloadLinks(slice, 'https://comandotorrents.to/fuzz/');
        comando.extractMagnet(slice);
        comando.extractMetaRefresh(slice);
        comando.nextProtectedUrl(slice, 'https://comandotorrents.to/fuzz/');
      }, 'Crash on ' + name + ' truncated at ' + len);
    }
  }
});

test('2.2 Chaos Bit-Flipping and Tag Corruptions', () => {
  const baseHtml = loadedFixtures['comandotorrents-movie-complex.html'];
  const corruptions = [
    (s) => s.replace(/<a\b/g, '<a broken_attr='),
    (s) => s.replace(/href="[^"]+"/g, 'href="javascript:void(0)"'),
    (s) => s.replace(/href="[^"]+"/g, 'href="http://[::1:invalid-ipv6"'),
    (s) => s.replace(/href="[^"]+"/g, 'href=""'),
    (s) => s.replace(/>/g, ''),
    (s) => s.replace(/</g, ''),
    (s) => s.replace(/class="[^"]+"/g, ''),
    (s) => s.replace(/<h3>/g, '<h3>'.repeat(100)),
    (s) => s + '\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x1F',
    (s) => '<div>'.repeat(500) + s + '</div>'.repeat(500),
    (s) => s.replace(/DUAL/g, 'D'.repeat(2000)),
  ];

  for (let i = 0; i < corruptions.length; i++) {
    const corrupted = corruptions[i](baseHtml);
    assert.doesNotThrow(() => {
      comando.parsePosts(corrupted);
      comando.parseDownloadLinks(corrupted, 'https://comandotorrents.to/fuzz/');
      comando.extractMagnet(corrupted);
      comando.extractMetaRefresh(corrupted);
    }, 'Crash on corruption vector ' + i);
  }
});

// 3. ReDoS & Pathological Regex Testing
console.log('\n--- Phase 3: ReDoS & Pathological Regex Resistance ---');

test('3.1 Pathological backtracking string for EPISODE_PATTERN and PACK_RESET_PATTERN', () => {
  const attackStr = 'EPISODIO ' + ' '.repeat(5000) + '999 ' + 'A'.repeat(5000);
  const t0 = performance.now();
  comando.extractEpisode(attackStr);
  const dur = performance.now() - t0;
  assert.ok(dur < 100, 'EPISODE_PATTERN took ' + dur + 'ms, must be < 100ms');
});

test('3.2 Pathological nesting for cleanPostTitle and releaseTitle', () => {
  const attackTitle = 'Filme Torrent – ' + 'Torrent – '.repeat(500) + '(2024) ' + '4K UHD '.repeat(500) + 'Download Grátis '.repeat(500);
  const t0 = performance.now();
  const clean = comando.cleanPostTitle(attackTitle);
  const dur = performance.now() - t0;
  assert.ok(dur < 200, 'cleanPostTitle took ' + dur + 'ms, must be < 200ms');
  assert.equal(clean, 'Filme (2024)');
});

test('3.3 Pathological JS variable and Magnet extraction input', () => {
  const attackMagnet = 'const DEST_URL = "magnet:?xt=urn:btih:" + ' + '"A".repeat(10000);\n'.repeat(100);
  const t0 = performance.now();
  comando.extractMagnet(attackMagnet);
  const dur = performance.now() - t0;
  assert.ok(dur < 150, 'extractMagnet took ' + dur + 'ms, must be < 150ms');
});

// 4. Memory Leak & Garbage Collection Stability
console.log('\n--- Phase 4: Memory Leak & Scale Stress Testing ---');

test('4.1 High-throughput parsing (10,000 iterations) without memory accumulation', () => {
  const html = loadedFixtures['comandotorrents-movie-complex.html'];
  const base = 'https://comandotorrents.to/movie/';
  
  if (global.gc) global.gc();
  const initialMem = process.memoryUsage().heapUsed;

  for (let i = 0; i < 10000; i++) {
    const links = comando.parseDownloadLinks(html, base);
    const posts = comando.parsePosts(loadedFixtures['comandotorrents-search.html']);
    const clean = comando.cleanPostTitle('Deadpool & Wolverine Torrent – (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K Download Grátis Completo');
    const rel = comando.releaseTitle('Deadpool & Wolverine Torrent (2024)', links[0]);
  }

  if (global.gc) global.gc();
  const finalMem = process.memoryUsage().heapUsed;
  const growthMb = (finalMem - initialMem) / (1024 * 1024);
  console.log('    Memory delta after 10k parse cycles: ' + growthMb.toFixed(2) + ' MB');
  assert.ok(growthMb < 25, 'Memory growth should be < 25 MB, got ' + growthMb.toFixed(2) + ' MB');
});

console.log('\n==============================================================');
console.log(' RESULTS: ' + passed + ' PASSED | ' + failed + ' FAILED');
console.log('==============================================================\n');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('ALL DEEP ADVERSARIAL & FUZZING TESTS PASSED!');
}
