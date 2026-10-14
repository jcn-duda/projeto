/**
 * Adversarial Empirical Stress Test Harness — Milestone 1 (Parser & Metadata Extraction) — Part 2
 *
 * Suite 4: Episodic Series vs Season Pack Resets Under Chaos Placement (pack resets, episode syntax)
 * Suite 5: Exotic Resolutions, Sources & Brazilian Size Parsing (normalizeQuality, normalizeSource, parseSize, sentinels)
 * Suite 6: Obfuscated Magnet Payloads & JS Redirect Extraction (URL-encoded magnets, JS vars, meta-refresh)
 */

import assert from 'node:assert/strict';
import comando from '../comandotorrents-resolver/server.js';

const results = {
  passed: 0,
  failed: 0,
  failures: [] as { suite: string; name: string; error: string; stack: string | undefined }[],
  timings: {} as Record<string, number>,
};

function recordPass(suite: any, name: any, durationMs: any) {
  results.passed++;
  const key = `${suite} > ${name}`;
  results.timings[key] = durationMs;
  console.log(`  [PASS] ${key} (${durationMs.toFixed(2)}ms)`);
}

function recordFail(suite: any, name: any, err: any) {
  results.failed++;
  const key = `${suite} > ${name}`;
  results.failures.push({ suite, name, error: err.message, stack: err.stack });
  console.error(`  [FAIL] ${key}: ${err.message}`);
}

function runSync(suite: any, name: any, fn: any) {
  const t0 = performance.now();
  try {
    fn();
    recordPass(suite, name, performance.now() - t0);
  } catch (err) {
    recordFail(suite, name, err);
  }
}

async function main() {
  console.log('================================================================');
  console.log(' ADVERSARIAL PARSER & METADATA STRESS HARNESS PART 2 (MILESTONE 1)');
  console.log('================================================================\n');

  const BASE_URL = 'https://comandotorrents.to/filme-adversarial-2024/';

  // ============================================================================
  // SUITE 4: Episodic Series vs Season Pack Resets Under Chaos Placement
  // ============================================================================
  console.log('--- Suite 4: Episodic Series vs Season Pack Resets ---');

  runSync('Suite 4: Episode & Pack Resets', '4.1 Season pack placed at the beginning before episode 1', () => {
    const html = `
      <h3>VERSÃO DUAL ÁUDIO</h3>
      <p>Pacote Completo:</p>
      <a href="https://systemads1.com/go/pack-start">TEMPORADA COMPLETA 1080p (15.0 GB)</a>
      <p>Episódios Individuais:</p>
      <a href="https://systemads1.com/go/ep1">EPISÓDIO 01 1080p (1.5 GB)</a>
      <a href="https://systemads1.com/go/ep2">EPISÓDIO 02 1080p (1.5 GB)</a>
      <a href="https://systemads1.com/go/ep3">EPISÓDIO 03 1080p (1.5 GB)</a>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 4);
    assert.equal(links[0].episode, null, 'Pack at start must have episode=null');
    assert.equal(links[1].episode, 1);
    assert.equal(links[2].episode, 2);
    assert.equal(links[3].episode, 3);
  });

  runSync('Suite 4: Episode & Pack Resets', '4.2 Season pack placed in the middle between EP04 and EP05', () => {
    const html = `
      <h3>VERSÃO DUAL ÁUDIO</h3>
      <a href="https://systemads1.com/go/ep1">EPISÓDIO 01</a>
      <a href="https://systemads1.com/go/ep2">EPISÓDIO 02</a>
      <a href="https://systemads1.com/go/ep3">EPISÓDIO 03</a>
      <a href="https://systemads1.com/go/ep4">EPISÓDIO 04</a>
      <p>Pack Parcial:</p>
      <a href="https://systemads1.com/go/pack-mid">PACK COMPLETO EP 01 A 04 (6.0 GB)</a>
      <p>Continuação:</p>
      <a href="https://systemads1.com/go/ep5">EPISÓDIO 05</a>
      <a href="https://systemads1.com/go/ep6">EPISÓDIO 06</a>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 7);
    assert.equal(links[0].episode, 1);
    assert.equal(links[1].episode, 2);
    assert.equal(links[2].episode, 3);
    assert.equal(links[3].episode, 4);
    assert.equal(links[4].episode, null, 'Pack in middle must have episode=null');
    assert.equal(links[5].episode, 5);
    assert.equal(links[6].episode, 6);
  });

  runSync('Suite 4: Episode & Pack Resets', '4.3 Explicit episode button with "Completo" text must preserve episode number', () => {
    const html = `
      <a href="https://systemads1.com/go/ep10">EPISÓDIO 10 COMPLETO DUBLADO (1.2 GB)</a>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 1);
    assert.equal(links[0].episode, 10, 'Explicit episode button with "Completo" must preserve episode=10');
  });

  runSync('Suite 4: Episode & Pack Resets', '4.4 Section header mentioning "Temporada Completa" must not wipe subsequent episode 01', () => {
    const html = `
      <p>Abaixo os links para a Temporada Completa episódio por episódio:</p>
      <a href="https://systemads1.com/go/ep1">EPISÓDIO 01 (1.2 GB)</a>
      <a href="https://systemads1.com/go/ep2">EPISÓDIO 02 (1.2 GB)</a>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 2);
    assert.equal(links[0].episode, 1, 'Episode 1 button must keep episode=1 despite header text');
    assert.equal(links[1].episode, 2);
  });

  runSync('Suite 4: Episode & Pack Resets', '4.5 Diverse episode notation patterns (E01, EP.02, 1x03, Cap 04)', () => {
    const html = `
      <a href="https://systemads1.com/go/p1">E01 1080p</a>
      <a href="https://systemads1.com/go/p2">EP.02 1080p</a>
      <a href="https://systemads1.com/go/p3">1X03 1080p</a>
      <a href="https://systemads1.com/go/p4">CAPÍTULO 04 1080p</a>
      <a href="https://systemads1.com/go/p5">CAP 05 1080p</a>
      <a href="https://systemads1.com/go/p6">EPISODIO 06 1080p</a>
      <a href="https://systemads1.com/go/p7">TODAS AS TEMPORADAS (PACK)</a>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 7);
    assert.equal(links[0].episode, 1);
    assert.equal(links[1].episode, 2);
    assert.equal(links[2].episode, 3);
    assert.equal(links[3].episode, 4);
    assert.equal(links[4].episode, 5);
    assert.equal(links[5].episode, 6);
    assert.equal(links[6].episode, null);
  });

  // ============================================================================
  // SUITE 5: Exotic Resolutions, Sources & Brazilian Size Parsing
  // ============================================================================
  console.log('\n--- Suite 5: Exotic Resolutions, Codecs & Brazilian Size Parsing ---');

  const resolutionTestCases = [
    { text: 'Filme 4K UHD 2160p', expected: 2160 },
    { text: 'Filme 4K', expected: 2160 },
    { text: 'Filme UHD', expected: 2160 },
    { text: 'Filme 1080p FULL HD', expected: 1080 },
    { text: 'Filme FULL HD', expected: 1080 },
    { text: 'Filme 720p HD', expected: 720 },
    { text: 'Filme HD', expected: 720 },
    { text: 'Filme 576p DVD', expected: 576 },
    { text: 'Filme 480p SD', expected: 480 },
    { text: 'Filme SD', expected: 480 },
    { text: 'Filme HDTV', expected: null },
    { text: 'Filme Sem Info', expected: null },
  ];

  for (const tc of resolutionTestCases) {
    runSync('Suite 5: Quality Normalization', `normalizeQuality: "${tc.text}" -> ${tc.expected}`, () => {
      assert.equal(comando.normalizeQuality(tc.text), tc.expected);
    });
  }

  const sourceTestCases = [
    { text: 'Filme REMUX 4K', expected: 'REMUX' },
    { text: 'Filme BDREMUX', expected: 'REMUX' },
    { text: 'Filme BluRay 1080p', expected: 'BLU-RAY' },
    { text: 'Filme BLU-RAY', expected: 'BLU-RAY' },
    { text: 'Filme BDRip', expected: 'BLU-RAY' },
    { text: 'Filme WEB-DL 1080p', expected: 'WEB-DL' },
    { text: 'Filme WEBRip', expected: 'WEBRIP' },
    { text: 'Filme HDTV 720p', expected: 'HDTV' },
    { text: 'Filme CAMRip', expected: 'CAM' },
    { text: 'Filme CAM', expected: 'CAM' },
    { text: 'Filme Desconhecido', expected: null },
  ];

  for (const tc of sourceTestCases) {
    runSync('Suite 5: Source Normalization', `normalizeSource: "${tc.text}" -> ${tc.expected}`, () => {
      assert.equal(comando.normalizeSource(tc.text), tc.expected);
    });
  }

  const sizeTestCases = [
    { input: '52.4 GB', expectedBytes: Math.round(52.4 * 1024 ** 3) },
    { input: '2,45 GB', expectedBytes: Math.round(2.45 * 1024 ** 3) },
    { input: '2,8 gb', expectedBytes: Math.round(2.8 * 1024 ** 3) },
    { input: '950 MB', expectedBytes: 950 * 1024 ** 2 },
    { input: '950 mb', expectedBytes: 950 * 1024 ** 2 },
    { input: '0.8 TB', expectedBytes: Math.round(0.8 * 1024 ** 4) },
    { input: '1,5 Tb', expectedBytes: Math.round(1.5 * 1024 ** 4) },
    { input: '500 KB', expectedBytes: 500 * 1024 },
    { input: '500 kb', expectedBytes: 500 * 1024 },
    { input: '1 KB', expectedBytes: 1024 },
    { input: 'invalido', expectedBytes: null },
    { input: '', expectedBytes: null },
    { input: null, expectedBytes: null },
  ];

  for (const tc of sizeTestCases) {
    runSync('Suite 5: Size Parsing', `parseSize: "${tc.input}" -> ${tc.expectedBytes}`, () => {
      assert.equal(comando.parseSize(tc.input), tc.expectedBytes);
    });
  }

  runSync('Suite 5: Size Sentinel', 'searchPageHtml defaults null/empty size to "1 KB"', () => {
    const items = [
      {
        post: { url: 'https://comandotorrents.to/sem-tamanho/', title: 'Filme Sem Tamanho' },
        link: { quality: 1080, audio: 'dublado', size: null, source: 'WEB-DL', episode: null },
        index: 0,
      },
    ];
    const html = comando.searchPageHtml(items);
    assert.ok(html.includes('<div class="size">1 KB</div>'), 'Must contain sentinel 1 KB');
    assert.ok(html.includes('<div class="seeders">1</div>'));
  });

  // ============================================================================
  // SUITE 6: Obfuscated Magnet Payloads & JS Redirect Extraction
  // ============================================================================
  console.log('\n--- Suite 6: Obfuscated Magnet Payloads & JS Redirects ---');

  const HASH = '3b8291a804a8b79f67a216b801a613fbf506f8c9';
  const RAW_MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Adversarial+Movie+2024&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337`;

  runSync('Suite 6: Magnet Extraction', '6.1 Extract magnet from encoded URI with inverted parameters and unencoded ampersand', () => {
    const encodedInverted = `magnet%3A%3Fdn=Adversarial%2BMovie%2B2024&xt=urn%3Abtih%3A${HASH}&tr=udp%3A%2F%2Ftracker`;
    const html = `<div class="btn"><a href="/redirect?url=${encodedInverted}">Baixar</a></div>`;
    const extracted = comando.extractMagnet(html);
    assert.ok(extracted, 'Should extract URL-encoded magnet with inverted parameters');
    assert.ok(extracted.startsWith('magnet:?'));
    assert.ok(extracted.includes(HASH), `Extracted magnet "${extracted}" must contain infoHash ${HASH}`);
  });

  runSync('Suite 6: Magnet Extraction', '6.2 Extract magnet from exotic JS variables (DESTINO, LINK_FINAL, TARGET_URL)', () => {
    const vars = ['DEST_URL', 'DOWNLOAD_URL', 'MAGNET_URL', 'DESTINO', 'LINK_FINAL', 'TARGET_URL', 'LINK_DOWNLOAD'];
    for (const v of vars) {
      const html = `<script>const ${v} = "${RAW_MAGNET}";</script>`;
      assert.equal(comando.extractMagnet(html), RAW_MAGNET, `Failed for variable ${v}`);
    }
  });

  runSync('Suite 6: Magnet Extraction', '6.3 Extract magnet from JS navigation calls (window.location, replace, assign, open)', () => {
    const navs = [
      `window.location = "${RAW_MAGNET}";`,
      `document.location.href = '${RAW_MAGNET}';`,
      `location.replace("${RAW_MAGNET}");`,
      `location.assign('${RAW_MAGNET}');`,
      `window.open("${RAW_MAGNET}");`,
    ];
    for (const code of navs) {
      const html = `<script>${code}</script>`;
      assert.equal(comando.extractMagnet(html), RAW_MAGNET, `Failed for navigation pattern ${code}`);
    }
  });

  runSync('Suite 6: Magnet Extraction', '6.4 Meta-refresh with nested quotes, spaces, and magnet destination', () => {
    const html1 = `<meta http-equiv="refresh" content="0; url=${RAW_MAGNET}">`;
    const html2 = `<meta content="1;url='${RAW_MAGNET}'" http-equiv="refresh">`;
    const html3 = `<meta http-equiv='Refresh' content='0;   URL="${RAW_MAGNET}"   '>`;

    assert.equal(comando.extractMetaRefresh(html1), RAW_MAGNET, 'Simple double quotes');
    assert.equal(comando.extractMetaRefresh(html2), RAW_MAGNET, 'Single quotes inside double quotes');
    assert.equal(comando.extractMetaRefresh(html3), RAW_MAGNET, 'Double quotes inside single quotes');
  });

  // ============================================================================
  // Summary & Verdict Determination
  // ============================================================================
  console.log('\n================================================================');
  console.log(` RESULTS: ${results.passed} PASSED | ${results.failed} FAILED`);
  console.log('================================================================\n');

  if (results.failed > 0) {
    console.error(`VERDICT: REQUEST_CHANGES (${results.failed} test failures detected)`);
    console.error('\nFailure Details:');
    for (const f of results.failures) {
      console.error(` - [${f.suite}] ${f.name}`);
      console.error(`   Error: ${f.error}`);
    }
    process.exit(1);
  } else {
    console.log('VERDICT: APPROVE (100% pass across all adversarial test vectors)');
  }
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
