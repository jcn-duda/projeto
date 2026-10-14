import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import comando from '../comandotorrents-resolver/server.js';

const TEST_HASH = '0123456789abcdef0123456789abcdef01234567';
const BASE_MAGNET = `magnet:?xt=urn:btih:${TEST_HASH}&dn=Filme.Adversarial.2026`;

interface HttpRes {
  status: number;
  body: string;
}

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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await new Promise<HttpRes>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/resolve?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode as number, body }));
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
      globalThis.fetch = (async () => {
        throw new Error('fetch failed: socket hang up');
      }) as unknown as typeof globalThis.fetch;

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
        globalThis.fetch = (async () => ({
          ok: false,
          status: code,
          text: async () => 'Error Page',
        })) as unknown as typeof globalThis.fetch;

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
      globalThis.fetch = (async () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      }) as unknown as typeof globalThis.fetch;

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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const requestHttp = (path: string) =>
      new Promise<HttpRes>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode as number, body }));
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
  let originalFetch: any;

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

    globalThis.fetch = (async (url: any) => {
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
    }) as unknown as typeof globalThis.fetch;

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
    globalThis.fetch = (async (url: any) => {
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
    }) as unknown as typeof globalThis.fetch;

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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const hugeUrl = 'https://comandotorrents.to/' + 'a'.repeat(5000);
      const res = await new Promise<HttpRes>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/resolve?url=${encodeURIComponent(hugeUrl)}`, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode as number, body }));
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
