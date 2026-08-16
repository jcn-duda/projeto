const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const comando = require('../comandotorrents-resolver/server');

const TEST_HASH = '0123456789abcdef0123456789abcdef01234567';
const BASE_MAGNET = `magnet:?xt=urn:btih:${TEST_HASH}&dn=Filme.Adversarial.2026`;

describe('Suite 1: Deep Multi-Hop Redirect Chains (1, 5, 6, 7+ hops)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('1.1: Direct 1-hop HTTP 302 to 200 magnet page resolves successfully', async () => {
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u === 'https://systemads1.com/step1') {
        return {
          status: 302,
          headers: new Map([['location', 'https://videosad.net/step2']]),
        };
      }
      if (u === 'https://videosad.net/step2') {
        return {
          ok: true,
          status: 200,
          text: async () => `<script>var DEST_URL = "${BASE_MAGNET}";</script>`,
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const res = await comando.fetchFollowingAllowed('https://systemads1.com/step1', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });

  test('1.2: 5-hop redirect chain resolves successfully', async () => {
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      const match = u.match(/step(\d+)/);
      if (!match) throw new Error(`Unexpected URL: ${u}`);
      const step = Number(match[1]);

      if (step < 5) {
        return {
          status: 302,
          headers: new Map([['location', `https://systemads1.com/step${step + 1}`]]),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `<script>const DOWNLOAD_URL = '${BASE_MAGNET}';</script>`,
      };
    };

    const res = await comando.fetchFollowingAllowed('https://systemads1.com/step0', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });

  test('1.3: 6-hop redirect chain (exact MAX_HOPS boundary) resolves successfully', async () => {
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      const match = u.match(/step(\d+)/);
      if (!match) throw new Error(`Unexpected URL: ${u}`);
      const step = Number(match[1]);

      if (step < 6) {
        return {
          status: 302,
          headers: new Map([['location', `https://videosad.net/step${step + 1}`]]),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => `<script>var LINK_FINAL = "${BASE_MAGNET}";</script>`,
      };
    };

    const res = await comando.fetchFollowingAllowed('https://videosad.net/step0', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });

  test('1.4: 7-hop redirect chain exceeds MAX_HOPS and safely throws too_many_redirects', async () => {
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      const match = u.match(/step(\d+)/);
      if (!match) throw new Error(`Unexpected URL: ${u}`);
      const step = Number(match[1]);

      return {
        status: 302,
        headers: new Map([['location', `https://systemads1.com/step${step + 1}`]]),
      };
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/step0', 'https://comandotorrents.to/post'),
      /too_many_redirects/,
    );
  });

  test('1.5: 20-hop redirect chain terminates promptly with too_many_redirects without infinite loop', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount += 1;
      const u = typeof url === 'string' ? url : url.href;
      return {
        status: 302,
        headers: new Map([['location', `${u}_next`]]),
      };
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://canalfutebol.com/chain0', 'https://comandotorrents.to/post'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('1.6: Mixed multi-hop redirect chain across HTTP 302, meta refresh, and JS variables', async () => {
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;

      if (u.includes('hop0')) {
        return {
          status: 302,
          headers: new Map([['location', 'https://systemads1.com/hop1']]),
        };
      }
      if (u.includes('hop1')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<html><head><meta http-equiv="refresh" content="0; url=https://videosad.net/hop2"></head></html>',
        };
      }
      if (u.includes('hop2')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<script>var NEXT_URL = "https://canalfutebol.com/hop3";</script>',
        };
      }
      if (u.includes('hop3')) {
        return {
          ok: true,
          status: 200,
          text: async () => '<div class="content"><p>Download: <a href="https://systemads1.com/hop4">Clique aqui</a></p></div>',
        };
      }
      if (u.includes('hop4')) {
        return {
          ok: true,
          status: 200,
          text: async () => `<script>window.location.replace("${BASE_MAGNET}");</script>`,
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const res = await comando.fetchFollowingAllowed('https://systemads1.com/hop0', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });
});

describe('Suite 2: Circular Redirect Loops & Self-Referential Redirects', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('2.1: 2-hop circular HTTP 302 redirect loop (A -> B -> A) terminates with too_many_redirects', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount += 1;
      const u = typeof url === 'string' ? url : url.href;
      if (u === 'https://systemads1.com/loopA') {
        return {
          status: 302,
          headers: new Map([['location', 'https://videosad.net/loopB']]),
        };
      }
      if (u === 'https://videosad.net/loopB') {
        return {
          status: 302,
          headers: new Map([['location', 'https://systemads1.com/loopA']]),
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/loopA', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('2.2: 3-hop circular redirect loop (A -> B -> C -> A) terminates with too_many_redirects', async () => {
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount += 1;
      const u = typeof url === 'string' ? url : url.href;
      if (u === 'https://systemads1.com/circA') {
        return { status: 302, headers: new Map([['location', 'https://videosad.net/circB']]) };
      }
      if (u === 'https://videosad.net/circB') {
        return { status: 302, headers: new Map([['location', 'https://canalfutebol.com/circC']]) };
      }
      if (u === 'https://canalfutebol.com/circC') {
        return { status: 302, headers: new Map([['location', 'https://systemads1.com/circA']]) };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/circA', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('2.3: Immediate self-referential HTTP 302 redirect (A -> A) terminates safely', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        status: 302,
        headers: new Map([['location', 'https://systemads1.com/self']]),
      };
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/self', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('2.4: HTML meta refresh self-loop (page points to itself) stops cleanly with no_magnet or loop exit', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<html><head><meta http-equiv="refresh" content="0; url=https://systemads1.com/self-meta"></head></html>',
      };
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/self-meta', 'https://comandotorrents.to/'),
      /(?:no_magnet|too_many_redirects)/,
    );
    assert.ok(callCount <= 7);
  });

  test('2.5: JS variable pointing to self URL stops cleanly with no_magnet', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<script>var NEXT_URL = "https://systemads1.com/self-js";</script>',
      };
    };

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/self-js', 'https://comandotorrents.to/'),
      /no_magnet/,
    );
    assert.equal(callCount, 1);
  });
});

describe('Suite 3: Meta Refresh Tags Parsing Variations', () => {
  test('3.1: Standard meta refresh tag extraction', () => {
    const html = '<meta http-equiv="refresh" content="0; url=https://videosad.net/target">';
    assert.equal(comando.extractMetaRefresh(html), 'https://videosad.net/target');
  });

  test('3.2: Inverted attributes (content before http-equiv)', () => {
    const html = '<meta content="0; url=https://videosad.net/target" http-equiv="refresh">';
    assert.equal(comando.extractMetaRefresh(html), 'https://videosad.net/target');
  });

  test('3.3: Case-insensitivity and url spacing without inner quotes', () => {
    const html = '<META HTTP-EQUIV="refresh" CONTENT="0; URL=https://videosad.net/target">';
    assert.equal(comando.extractMetaRefresh(html), 'https://videosad.net/target');
  });

  test('3.4: Unquoted target URL in meta refresh content', () => {
    const html = '<meta http-equiv=refresh content="0;url=https://videosad.net/target">';
    assert.equal(comando.extractMetaRefresh(html), 'https://videosad.net/target');
  });

  test('3.5: Entity-encoded target URLs in meta refresh', () => {
    const html = '<meta http-equiv="refresh" content="0; url=https://videosad.net/go?id=123&amp;token=abc&amp;ref=site">';
    assert.equal(comando.extractMetaRefresh(html), 'https://videosad.net/go?id=123&token=abc&ref=site');
  });

  test('3.6: Direct magnet link inside unquoted/double-quoted meta refresh tag', () => {
    const directMagnet = `magnet:?xt=urn:btih:${TEST_HASH}&dn=Meta.Refresh.Movie`;
    const html = `<meta http-equiv="refresh" content="0; url=${directMagnet}">`;
    assert.equal(comando.extractMetaRefresh(html), directMagnet);
  });

  test('3.7: Non-refresh meta tags and refresh tags without URL return null', () => {
    assert.equal(comando.extractMetaRefresh('<meta name="viewport" content="width=device-width, initial-scale=1">'), null);
    assert.equal(comando.extractMetaRefresh('<meta http-equiv="refresh" content="10">'), null);
    assert.equal(comando.extractMetaRefresh('<meta charset="UTF-8">'), null);
    assert.equal(comando.extractMetaRefresh(''), null);
    assert.equal(comando.extractMetaRefresh(null), null);
  });
});

describe('Suite 4: Obfuscated JavaScript Variables & Window Navigation', () => {
  test('4.1: All standard protector JS variable names with diverse quotes and formatting', () => {
    const varNames = [
      'DEST_URL', 'DOWNLOAD_URL', 'MAGNET_URL', 'LINK_DOWNLOAD',
      'URL_DOWNLOAD', 'DOWNLOAD', 'REDIRECT_URL', 'NEXT_URL',
      'LINK_FINAL', 'TARGET_URL', 'DESTINO', 'download_url',
      'download_link', 'magnet_link', 'target_url', 'dest',
      'target', 'link', 'url', 'magnet'
    ];

    for (const name of varNames) {
      const html1 = `<script>var ${name} = "${BASE_MAGNET}";</script>`;
      const html2 = `<script>const ${name} = '${BASE_MAGNET}';</script>`;
      const html3 = `<script>let ${name}="${BASE_MAGNET}";</script>`;
      const html4 = `<script>window.${name} = "${BASE_MAGNET}";</script>`;
      const html5 = `<script>var obj = { ${name}: "${BASE_MAGNET}" };</script>`;

      assert.equal(comando.extractMagnet(html1), BASE_MAGNET, `Falha em var: ${name}`);
      assert.equal(comando.extractMagnet(html2), BASE_MAGNET, `Falha em const: ${name}`);
      assert.equal(comando.extractMagnet(html3), BASE_MAGNET, `Falha em let: ${name}`);
      assert.equal(comando.extractMagnet(html4), BASE_MAGNET, `Falha em window: ${name}`);
      assert.equal(comando.extractMagnet(html5), BASE_MAGNET, `Falha em object: ${name}`);
    }
  });

  test('4.2: JavaScript window navigation and redirection patterns', () => {
    const navPatterns = [
      `<script>location.href = "${BASE_MAGNET}";</script>`,
      `<script>window.location.href = "${BASE_MAGNET}";</script>`,
      `<script>document.location.href = "${BASE_MAGNET}";</script>`,
      `<script>location.replace("${BASE_MAGNET}");</script>`,
      `<script>window.location.replace("${BASE_MAGNET}");</script>`,
      `<script>location.assign("${BASE_MAGNET}");</script>`,
      `<script>window.location.assign("${BASE_MAGNET}");</script>`,
      `<script>window.location = "${BASE_MAGNET}";</script>`,
      `<script>window.open("${BASE_MAGNET}");</script>`,
    ];

    for (const html of navPatterns) {
      assert.equal(comando.extractMagnet(html), BASE_MAGNET, `Falha em nav: ${html}`);
    }
  });

  test('4.3: Custom HTML data attributes', () => {
    const attrs = [
      `<button data-magnet="${BASE_MAGNET}">Download</button>`,
      `<a data-url="${BASE_MAGNET}">Link</a>`,
      `<div data-link="${BASE_MAGNET}"></div>`,
      `<span data-href="${BASE_MAGNET}"></span>`,
      `<p data-download="${BASE_MAGNET}"></p>`,
    ];

    for (const html of attrs) {
      assert.equal(comando.extractMagnet(html), BASE_MAGNET, `Falha em attr: ${html}`);
    }
  });

  test('4.4: Minified and semicolon-packed JavaScript payloads', () => {
    const minified = `
      <script>function go(){var a=1;var b=2;var DEST_URL="${BASE_MAGNET}";window.location.href=DEST_URL;}go();</script>
    `;
    assert.equal(comando.extractMagnet(minified), BASE_MAGNET);
  });
});

describe('Suite 5: URL-Encoded Magnets with Varied Parameter Orders', () => {
  const hash = 'abcdef0123456789abcdef0123456789abcdef01';

  test('5.1: URL-encoded magnet with xt first', () => {
    const encoded = `magnet%3A%3Fxt%3Durn%3Abtih%3A${hash}%26dn%3DMovie.Title%26tr%3Dudp%3A%2F%2Ftracker.co`;
    const expected = `magnet:?xt=urn:btih:${hash}&dn=Movie.Title&tr=udp://tracker.co`;

    assert.equal(comando.extractMagnet(`<script>var target = "${encoded}";</script>`), expected);
    assert.equal(comando.extractMagnet(`<a href="${encoded}">Download</a>`), expected);
  });

  test('5.2: URL-encoded magnet with dn first (inverted parameter order)', () => {
    const encoded = `magnet%3A%3Fdn%3DMovie.Title%26xt%3Durn%3Abtih%3A${hash}%26tr%3Dudp%3A%2F%2Ftracker.co`;
    const expected = `magnet:?dn=Movie.Title&xt=urn:btih:${hash}&tr=udp://tracker.co`;

    assert.equal(comando.extractMagnet(`<script>var LINK_FINAL = "${encoded}";</script>`), expected);
    assert.equal(comando.extractMagnet(`<button data-magnet="${encoded}">Download</button>`), expected);
  });

  test('5.3: URL-encoded magnet with tr first', () => {
    const encoded = `magnet%3A%3Ftr%3Dudp%3A%2F%2Ftracker.co%26dn%3DMovie%26xt%3Durn%3Abtih%3A${hash}`;
    const expected = `magnet:?tr=udp://tracker.co&dn=Movie&xt=urn:btih:${hash}`;

    assert.equal(comando.extractMagnet(`<script>location.replace("${encoded}");</script>`), expected);
    assert.equal(comando.extractMagnet(`<span data-url="${encoded}"></span>`), expected);
  });

  test('5.4: URL-encoded magnet raw text anywhere in body', () => {
    const encoded = `magnet%3A%3Fxt%3Durn%3Abtih%3A${hash}%26dn%3DTest`;
    const expected = `magnet:?xt=urn:btih:${hash}&dn=Test`;

    const html = `<div>Clique para baixar: ${encoded} agora mesmo!</div>`;
    assert.equal(comando.extractMagnet(html), expected);
  });
});

describe('Suite 6: SSRF Protection & Domain Allowlist Integrity', () => {
  test('6.1: assertAllowedUrl blocks Cloud metadata IP 169.254.169.254', () => {
    assert.throws(
      () => comando.assertAllowedUrl('http://169.254.169.254/latest/meta-data/'),
      /blocked_host/,
    );
  });

  test('6.2: assertAllowedUrl blocks loopback IPs and localhost', () => {
    assert.throws(() => comando.assertAllowedUrl('http://127.0.0.1:8701/secret'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('http://localhost:3000/admin'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('http://0.0.0.0/'), /blocked_host/);
  });

  test('6.3: assertAllowedUrl blocks IPv6 loopback addresses', () => {
    assert.throws(() => comando.assertAllowedUrl('http://[::1]/admin'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('http://[::ffff:127.0.0.1]/'), /blocked_host/);
  });

  test('6.4: assertAllowedUrl blocks arbitrary attacker domains', () => {
    assert.throws(() => comando.assertAllowedUrl('https://evil-attacker.com/exploit'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('https://phishing.org/login'), /blocked_host/);
  });

  test('6.5: assertAllowedUrl blocks subdomain spoofing and suffix tampering', () => {
    assert.throws(() => comando.assertAllowedUrl('https://systemads1.com.attacker.com/go'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('https://comandotorrents.to.evil.org/post'), /blocked_host/);
    assert.throws(() => comando.assertAllowedUrl('https://fakeprotector-videosad.net.ru/'), /blocked_host/);
  });

  test('6.6: assertAllowedUrl permits legit subdomains of allowed hosts', () => {
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://cdn.comandotorrents.to/file'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://sub.systemads1.com/step'));
    assert.doesNotThrow(() => comando.assertAllowedUrl('https://srv1.videosad.net/view'));
  });

  test('6.7: assertAllowedUrl blocks non-HTTP/HTTPS protocols', () => {
    assert.throws(() => comando.assertAllowedUrl('file:///etc/passwd'), /unsupported_protocol/);
    assert.throws(() => comando.assertAllowedUrl('gopher://127.0.0.1:6379/'), /unsupported_protocol/);
    assert.throws(() => comando.assertAllowedUrl('ftp://comandotorrents.to/file.zip'), /unsupported_protocol/);
    assert.throws(() => comando.assertAllowedUrl('javascript:alert(1)'), /unsupported_protocol/);
  });

  test('6.8: End-to-end HTTP GET /resolve SSRF rejection', async () => {
    const server = comando.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/resolve?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, body }));
        }).on('error', reject);
      });

      assert.equal(res.status, 502);
      assert.ok(res.body.includes('blocked_host'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Suite 7: Network Fault Resilience & Error Handling', () => {
  test('7.1: Abrupt fetch failure is caught cleanly without process crash', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new Error('fetch failed: socket hang up');
      };

      await assert.rejects(
        () => comando.fetchFollowingAllowed('https://systemads1.com/broken-socket', 'https://comandotorrents.to/'),
        /socket hang up/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('7.2: Upstream HTTP 500, 502, 404, 403 errors are captured cleanly', async () => {
    const errorCodes = [500, 502, 503, 404, 403, 401];
    const originalFetch = globalThis.fetch;

    try {
      for (const code of errorCodes) {
        globalThis.fetch = async () => ({
          ok: false,
          status: code,
          text: async () => 'Error Page',
        });

        await assert.rejects(
          () => comando.fetchFollowingAllowed('https://systemads1.com/error-page', 'https://comandotorrents.to/'),
          new RegExp(`http_${code}`),
          `Deveria rejeitar com http_${code}`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('7.3: Upstream timeout simulation aborts cleanly without unhandled rejection', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      };

      await assert.rejects(
        () => comando.fetchFollowingAllowed('https://systemads1.com/delayed-step', 'https://comandotorrents.to/'),
        /aborted/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('7.4: End-to-end HTTP server survives upstream errors and remains healthy for subsequent requests', async () => {
    const server = comando.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const requestHttp = (path) =>
      new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, body }));
        }).on('error', reject);
      });

    try {
      // 1. Send invalid / failing resolve request
      const resBad = await requestHttp('/resolve?url=https://evil.com/bad');
      assert.equal(resBad.status, 502);

      // 2. Send malformed resolve request (missing param)
      const resMissing = await requestHttp('/resolve');
      assert.equal(resMissing.status, 400);

      // 3. Send non-existent route
      const res404 = await requestHttp('/unknown-endpoint');
      assert.equal(res404.status, 404);

      // 4. Verify server is still completely healthy and responsive
      const resHealth = await requestHttp('/health');
      assert.equal(resHealth.status, 200);
      assert.equal(resHealth.body, 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Suite 8: Request Coalescing & Cache Bounding under Concurrency', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    comando.postCache.clear();
    comando.searchCache.clear();
    comando.magnetCache.clear();
    comando.inFlight.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('8.1: 50 concurrent resolveButton requests coalesce into exactly 1 underlying fetch', async () => {
    let postFetchCount = 0;
    let buttonFetchCount = 0;

    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u.includes('filme-concorrente')) {
        postFetchCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          text: async () => `
            <div class="entry-content">
              <h3>DUBLADO</h3>
              <p>1080p (2.0 GB)</p>
              <a href="https://systemads1.com/go/btn0">Download</a>
            </div>
          `,
        };
      }
      if (u.includes('btn0')) {
        buttonFetchCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          text: async () => `<script>var DEST_URL = "${BASE_MAGNET}";</script>`,
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const postUrl = 'https://comandotorrents.to/filme-concorrente/';
    const promises = Array.from({ length: 50 }, () => comando.resolveButton(postUrl, 0));
    const results = await Promise.all(promises);

    assert.equal(results.length, 50);
    for (const r of results) {
      assert.equal(r, BASE_MAGNET);
    }
    assert.equal(postFetchCount, 1, 'postFetch deve ser executado exatamente 1 vez');
    assert.equal(buttonFetchCount, 1, 'buttonFetch deve ser executado exatamente 1 vez');
    assert.equal(comando.inFlight.size, 0);
  });

  test('8.2: In-flight map cleans up rejected promises on fetch error, allowing immediate retry', async () => {
    let shouldFail = true;
    globalThis.fetch = async (url) => {
      const u = typeof url === 'string' ? url : url.href;
      if (shouldFail) {
        throw new Error('Network glitch');
      }
      return {
        ok: true,
        status: 200,
        text: async () => `
          <div class="entry-content">
            <a href="https://systemads1.com/go/btn0">Download</a>
          </div>
        `,
      };
    };

    const postUrl = 'https://comandotorrents.to/retry-test/';
    // First attempt fails
    await assert.rejects(() => comando.getPostLinks(postUrl), /Network glitch/);
    assert.equal(comando.inFlight.size, 0, 'inFlight map deve ser limpo após falha');

    // Retry attempt succeeds
    shouldFail = false;
    const res = await comando.getPostLinks(postUrl);
    assert.equal(res.links.length, 1);
    assert.equal(comando.inFlight.size, 0);
  });
});

describe('Suite 9: Unwrapping & Malformed Input Handling', () => {
  test('9.1: URL lengths exceeding 4096 bytes are rejected with 400 invalid_url', async () => {
    const server = comando.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const hugeUrl = 'https://comandotorrents.to/' + 'a'.repeat(5000);
      const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/resolve?url=${encodeURIComponent(hugeUrl)}`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, body }));
        }).on('error', reject);
      });

      assert.equal(res.status, 400);
      assert.equal(res.body, 'invalid_url');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('9.2: parseDownloadLinks gracefully skips malformed URIs without throwing', () => {
    const malformedHtml = `
      <div class="content">
        <a href="http://[invalid-url]/test">Broken</a>
        <a href="javascript:void(0)">JS</a>
        <a href="https://systemads1.com/valid">Valid</a>
      </div>
    `;

    const links = comando.parseDownloadLinks(malformedHtml, 'https://comandotorrents.to/post');
    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'https://systemads1.com/valid');
  });
});
