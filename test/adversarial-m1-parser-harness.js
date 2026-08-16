/**
 * Adversarial Empirical Stress Test Harness — Milestone 1 (Parser & Metadata Extraction)
 *
 * This test suite subjects the ComandoTorrents HTML parser and metadata extraction
 * engine to extreme, hostile, and edge-case inputs across 6 comprehensive suites:
 *
 * Suite 1: Malformed HTML, Syntax Chaos & ReDoS Resilience (deep nesting, truncation, bad protocols, 2MB payload)
 * Suite 2: SEO Spam, Complex Titles, Numbers & Entity Normalization (cleanPostTitle, releaseTitle)
 * Suite 3: Audio Section State Machine & Boundary Contamination (DUB/LEG/NACIONAL, synopsis isolation)
 * Suite 4: Episodic Series vs Season Pack Resets Under Chaos Placement (pack resets, episode syntax)
 * Suite 5: Exotic Resolutions, Sources & Brazilian Size Parsing (normalizeQuality, normalizeSource, parseSize, sentinels)
 * Suite 6: Obfuscated Magnet Payloads & JS Redirect Extraction (URL-encoded magnets, JS vars, meta-refresh)
 */

const assert = require('node:assert/strict');
const comando = require('../comandotorrents-resolver/server');

const results = {
  passed: 0,
  failed: 0,
  failures: [],
  timings: {},
};

function recordPass(suite, name, durationMs) {
  results.passed++;
  const key = `${suite} > ${name}`;
  results.timings[key] = durationMs;
  console.log(`  [PASS] ${key} (${durationMs.toFixed(2)}ms)`);
}

function recordFail(suite, name, err) {
  results.failed++;
  const key = `${suite} > ${name}`;
  results.failures.push({ suite, name, error: err.message, stack: err.stack });
  console.error(`  [FAIL] ${key}: ${err.message}`);
}

function runSync(suite, name, fn) {
  const t0 = performance.now();
  try {
    fn();
    recordPass(suite, name, performance.now() - t0);
  } catch (err) {
    recordFail(suite, name, err);
  }
}

async function runAsync(suite, name, fn) {
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
  console.log(' ADVERSARIAL PARSER & METADATA STRESS HARNESS (MILESTONE 1)');
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

    // parsePosts currently throws TypeError: Invalid URL instead of gracefully skipping broken post
    try {
      const posts = comando.parsePosts(malformedSearchHtml);
      assert.equal(posts.length, 1, 'Should skip invalid URL and return valid post');
    } catch (err) {
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
  // SUITE 4: Episodic Series vs Season Pack Resets Under Chaos Placement
  // ============================================================================
  console.log('\n--- Suite 4: Episodic Series vs Season Pack Resets ---');

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
