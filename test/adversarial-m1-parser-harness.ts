/**
 * Adversarial Empirical Stress Test Harness — Milestone 1 (Parser & Metadata Extraction) — Part 1
 *
 * This test suite subjects the ComandoTorrents HTML parser and metadata extraction
 * engine to extreme, hostile, and edge-case inputs across suites 1 to 3:
 *
 * Suite 1: Malformed HTML, Syntax Chaos & ReDoS Resilience (deep nesting, truncation, bad protocols, 2MB payload)
 * Suite 2: SEO Spam, Complex Titles, Numbers & Entity Normalization (cleanPostTitle, releaseTitle)
 * Suite 3: Audio Section State Machine & Boundary Contamination (DUB/LEG/NACIONAL, synopsis isolation)
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

async function runAsync(suite: any, name: any, fn: any) {
  const t0 = performance.now();
  try {
    await fn();
    recordPass(suite, name, performance.now() - t0);
  } catch (err) {
    recordFail(suite, name, err);
  }
}

async function main() {
  console.log('================================================================');
  console.log(' ADVERSARIAL PARSER & METADATA STRESS HARNESS PART 1 (MILESTONE 1)');
  console.log('================================================================\n');

  const BASE_URL = 'https://comandotorrents.to/filme-adversarial-2024/';

  // ============================================================================
  // SUITE 1: Malformed HTML, Syntax Chaos & ReDoS Resilience
  // ============================================================================
  console.log('--- Suite 1: Malformed HTML, Syntax Chaos & ReDoS Resilience ---');

  runSync('Suite 1: Malformed HTML', '1.1 Deeply nested unclosed divs and tables without crashing', () => {
    let deepHtml = '<article class="blog-view"><h2 class="entry-title"><a href="https://comandotorrents.to/deep-post/">Deep Post</a></h2>';
    for (let i = 0; i < 150; i++) {
      deepHtml += `<div><table><tr><td><span><section id="nest-${i}">`;
    }
    deepHtml += '<h3>VERSÃO DUAL ÁUDIO</h3><p>1080p (2.5 GB)</p><a href="https://systemads1.com/go/deep1">Download 1080p</a>';

    const posts = comando.parsePosts(deepHtml);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].title, 'Deep Post');

    const links = comando.parseDownloadLinks(deepHtml, BASE_URL);
    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://systemads1.com/go/deep1');
    assert.equal(links[0].audio, 'dublado');
    assert.equal(links[0].quality, 1080);
    assert.equal(links[0].size, '2.5 GB');
  });

  runSync('Suite 1: Malformed HTML', '1.2 Truncated HTML at various step boundaries', () => {
    const rawPostHtml = `
      <article class="blog-view">
        <h2 class="entry-title"><a href="https://comandotorrents.to/trunc-post/" title="Trunc Post 2024">Trunc Post</a></h2>
        <div class="content">
          <h3>VERSÃO DUAL ÁUDIO</h3>
          <a href="https://videosad.net/go/t1">Download 1080p (2.0 GB)</a>
          <h3>VERSÃO LEGENDADA</h3>
          <a href="https://canalfutebol.com/go/t2">Download 720p (900 MB)</a>
        </div>
      </article>
    `;

    for (let len = 10; len < rawPostHtml.length; len += 25) {
      const truncated = rawPostHtml.slice(0, len);
      assert.doesNotThrow(() => {
        comando.parsePosts(truncated);
        comando.parseDownloadLinks(truncated, BASE_URL);
      }, `Should not throw when truncated at length ${len}`);
    }
  });

  runSync('Suite 1: Malformed HTML', '1.3 Hostile href pseudoprotocols and malformed URIs', () => {
    const hostileHtml = `
      <a href="javascript:alert('xss')">JS Link</a>
      <a href="javascript:void(0);">Void Link</a>
      <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data URI</a>
      <a href="mailto:admin@comandotorrents.to">Mailto</a>
      <a href="tel:+551199999999">Tel</a>
      <a href="ftp://files.comandotorrents.to/torrent.torrent">FTP</a>
      <a href="http://[::1:bad-ipv6/fail">Bad IPv6</a>
      <a href="https://evil.com/fake">Evil Host</a>
      <a href="">Empty Href</a>
      <a href="   ">Spaces Href</a>
      <a name="anchor-tag">No Href At All</a>
      <h3>VERSÃO DUAL ÁUDIO</h3>
      <a href="https://systemads1.com/go/legit">Legit Button 1080p (2.4 GB)</a>
    `;

    const links = comando.parseDownloadLinks(hostileHtml, BASE_URL);
    assert.equal(links.length, 1, 'Only the legitimate protector link should be parsed');
    assert.equal(links[0].url, 'https://systemads1.com/go/legit');
    assert.equal(links[0].quality, 1080);
    assert.equal(links[0].audio, 'dublado');
    assert.equal(links[0].size, '2.4 GB');
  });

  runSync('Suite 1: Malformed HTML', '1.4 Unhandled exception on malformed article URL in search results', () => {
    const malformedSearchHtml = `
      <article class="blog-view">
        <h2 class="entry-title"><a href="http://[::1:invalid-uri">Broken Post</a></h2>
      </article>
      <article class="blog-view">
        <h2 class="entry-title"><a href="https://comandotorrents.to/valid-post/">Valid Post</a></h2>
      </article>
    `;

    try {
      const posts = comando.parsePosts(malformedSearchHtml);
      assert.equal(posts.length, 1, 'Should skip invalid URL and return valid post');
    } catch (err: any) {
      throw new Error(`parsePosts crashed on malformed URL: ${err.message}`);
    }
  });

  runSync('Suite 1: Malformed HTML', '1.5 ReDoS & performance stress on 2MB HTML payload with 2500 items', () => {
    let bigHtml = '<article class="blog-view"><h2 class="entry-title"><a href="/post/">Stress Post</a></h2>';
    for (let i = 0; i < 2500; i++) {
      bigHtml += `<div class="junk-${i}"><p>Some SEO junk text about filmes e series torrent download gratis ${i}</p>`;
      bigHtml += `<a href="https://ignored-domain-${i}.com/junk">Ignored Link ${i}</a></div>`;
    }
    bigHtml += '<h3>VERSÃO DUAL ÁUDIO 4K</h3><a href="https://systemads1.com/go/final">Opção 4K (45.0 GB)</a></article>';

    const t0 = performance.now();
    const links = comando.parseDownloadLinks(bigHtml, BASE_URL);
    const elapsed = performance.now() - t0;

    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://systemads1.com/go/final');
    assert.equal(links[0].quality, 2160);
    assert.equal(links[0].size, '45.0 GB');
    assert.ok(elapsed < 1000, `Parsing 2MB payload took ${elapsed}ms, should be < 1000ms`);
  });

  // ============================================================================
  // SUITE 2: SEO Spam, Complex Titles, Numbers & Entity Normalization
  // ============================================================================
  console.log('\n--- Suite 2: SEO Spam, Complex Titles & Number Normalization ---');

  const titleTestCases = [
    {
      input: 'Deadpool & Wolverine Torrent – (2024) Dual Áudio 5.1 / Dublado WEB-DL 1080p / 4K Download Grátis Completo',
      expectedClean: 'Deadpool & Wolverine (2024)',
    },
    {
      input: 'Blade Runner 2049 Torrent (2017) BluRay 1080p / 4K UHD 2160p Dual Áudio 7.1',
      expectedClean: 'Blade Runner 2049 (2017)',
    },
    {
      input: '1917 Torrent – (2019) 1080p / 4K IMAX Dual Áudio 5.1 / Dublado BluRay',
      expectedClean: '1917 (2019)',
    },
    {
      input: '2001: Uma Odisséia no Espaço Torrent (1968) 4K Ultra HD 2160p Remux Dublado',
      expectedClean: '2001: Uma Odisséia no Espaço (1968)',
    },
    {
      input: '10.000 A.C. Torrent (2008) BluRay 720p / 1080p Dual Áudio Baixar Grátis',
      expectedClean: '10.000 A.C. (2008)',
    },
    {
      input: 'Se7en: Os Sete Crimes Capitais Torrent (1995) Remastered 1080p Dual Áudio',
      expectedClean: 'Se7en: Os Sete Crimes Capitais (1995)',
    },
    {
      input: '12 Homens e Uma Sentença Torrent (1957) 1080p Legendado Online',
      expectedClean: '12 Homens e Uma Sentença (1957)',
    },
    {
      input: 'Missão: Impossível – Efeito Fallout Torrent (2018) IMAX 1080p / 4K Dual Áudio',
      expectedClean: 'Missão: Impossível – Efeito Fallout (2018)',
    },
    {
      input: 'WALL-E Torrent (2008) 1080p 3D Dual Áudio 5.1 Download',
      expectedClean: 'WALL-E (2008)',
    },
    {
      input: 'Coringa: Delírio a Dois Torrent (2024) WEB-DL 1080p / 2160p 4K Dual Áudio',
      expectedClean: 'Coringa: Delírio a Dois (2024)',
    },
    {
      input: 'X-Men &#8211; Dias de um Futuro Esquecido Torrent (2014) 1080p Dublado',
      expectedClean: 'X-Men – Dias de um Futuro Esquecido (2014)',
    },
    {
      input: 'O Poderoso Chefão: Parte II Torrent (1974) 4K UHD Remux Dublado Completo',
      expectedClean: 'O Poderoso Chefão: Parte II (1974)',
    },
  ];

  for (const tc of titleTestCases) {
    runSync('Suite 2: Title Cleaning', `cleanPostTitle: "${tc.expectedClean}"`, () => {
      const clean = comando.cleanPostTitle(tc.input);
      assert.equal(clean, tc.expectedClean);
    });
  }

  runSync('Suite 2: Title Formatting', '2.1 releaseTitle: strips hanging ampersand/punctuation artifacts', () => {
    const postTitle = 'Alien: Romulus Torrent (2024) BluRay 1080p & 4K Dublado Download';
    const link = { quality: 2160, source: 'BLU-RAY', audio: 'dublado', size: '18.4 GB', episode: null };
    const formatted = comando.releaseTitle(postTitle, link);
    assert.equal(formatted, 'Alien: Romulus (2024) [2160p BLU-RAY DUBLADO 18.4 GB]');
  });

  runSync('Suite 2: Title Formatting', '2.2 releaseTitle: handles episodic series with zero duplication of codec in title', () => {
    const postTitle = 'House of the Dragon 2ª Temporada Torrent (2024) WEB-DL 1080p Dual Áudio';
    const link = { quality: 1080, source: 'WEB-DL', audio: 'dublado', size: '1.8 GB', episode: 4 };
    const formatted = comando.releaseTitle(postTitle, link);
    assert.equal(formatted, 'House of the Dragon 2ª Temporada (2024) E04 [1080p WEB-DL DUBLADO 1.8 GB]');
  });

  // ============================================================================
  // SUITE 3: Audio Section State Machine & Boundary Contamination
  // ============================================================================
  console.log('\n--- Suite 3: Audio Section State Machine & Boundary Contamination ---');

  runSync('Suite 3: Audio State Machine', '3.1 Dual Áudio header with single Legendado button override', () => {
    const html = `
      <div class="downloads">
        <h3>VERSÃO DUAL ÁUDIO (MKV)</h3>
        <p>Opção 1080p</p>
        <a href="https://systemads1.com/go/d1">DOWNLOAD 1080p (2.5 GB)</a>
        <p>Opção 720p</p>
        <a href="https://systemads1.com/go/d2">DOWNLOAD 720p (1.2 GB)</a>
        <p>Opção Exclusiva Legendada</p>
        <a href="https://videosad.net/go/leg1">DOWNLOAD 1080p LEGENDADO (2.0 GB)</a>
      </div>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 3);
    assert.equal(links[0].audio, 'dublado');
    assert.equal(links[1].audio, 'dublado');
    assert.equal(links[2].audio, 'legendado', 'Button specifically tagged LEGENDADO must override section audio');
  });

  runSync('Suite 3: Audio State Machine', '3.2 Legendado header with single Dublado button override', () => {
    const html = `
      <div class="downloads">
        <h3>VERSÃO LEGENDADA (MP4)</h3>
        <a href="https://canalfutebol.com/go/l1">DOWNLOAD 1080p LEG (1.8 GB)</a>
        <a href="https://canalfutebol.com/go/l2">DOWNLOAD 720p LEG (950 MB)</a>
        <p>Bônus Especial Dublado</p>
        <a href="https://systemads.net/go/dub1">DOWNLOAD 1080p DUAL ÁUDIO (2.8 GB)</a>
      </div>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 3);
    assert.equal(links[0].audio, 'legendado');
    assert.equal(links[1].audio, 'legendado');
    assert.equal(links[2].audio, 'dublado', 'Button specifically tagged DUAL ÁUDIO must override section audio');
  });

  runSync('Suite 3: Audio State Machine', '3.3 Alternating sections DUB -> LEG -> NACIONAL -> LEG', () => {
    const html = `
      <h3>VERSÃO DUAL ÁUDIO</h3>
      <a href="https://systemads1.com/go/s1">Link 1 (1080p)</a>
      <h3>VERSÃO LEGENDADA</h3>
      <a href="https://videosad.net/go/s2">Link 2 (1080p)</a>
      <h3>ÁUDIO NACIONAL (BRASIL)</h3>
      <a href="https://canalfutebol.com/go/s3">Link 3 (1080p)</a>
      <h3>VERSÃO [LEG]</h3>
      <a href="https://systemads.net/go/s4">Link 4 (1080p)</a>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 4);
    assert.equal(links[0].audio, 'dublado');
    assert.equal(links[1].audio, 'legendado');
    assert.equal(links[2].audio, 'dublado', 'NACIONAL must be treated as dublado/português');
    assert.equal(links[3].audio, 'legendado');
  });

  runSync('Suite 3: Audio State Machine', '3.4 Subtitled post synopsis containing "dublado" text must not contaminate', () => {
    const html = `
      <article class="blog-view">
        <div class="sinopse">
          <p>Sinopse: O filme não possui versão dublada oficial até o momento. Todos os downloads abaixo são originais legendados.</p>
        </div>
        <div class="download-section">
          <h3>VERSÃO LEGENDADA</h3>
          <a href="https://systemads1.com/go/parasite1">Download 1080p (2.2 GB)</a>
          <a href="https://videosad.net/go/parasite2">Download 720p (1.1 GB)</a>
        </div>
      </article>
    `;

    const links = comando.parseDownloadLinks(html, BASE_URL);
    assert.equal(links.length, 2);
    assert.equal(links[0].audio, 'legendado');
    assert.equal(links[1].audio, 'legendado');
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
