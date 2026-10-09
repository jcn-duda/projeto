import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import comando from '../comandotorrents-resolver/server.js';

const TEST_HASH = '0123456789abcdef0123456789abcdef01234567';
const BASE_MAGNET = `magnet:?xt=urn:btih:${TEST_HASH}&dn=Filme.Adversarial.2026`;

describe('Suite 1: Deep Multi-Hop Redirect Chains (1, 5, 6, 7+ hops)', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('1.1: Direct 1-hop HTTP 302 to 200 magnet page resolves successfully', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      if (u === 'https://systemads1.com/step1') {
        return { status: 302, headers: new Map([['location', 'https://videosad.net/step2']]) };
      }
      if (u === 'https://videosad.net/step2') {
        return { ok: true, status: 200, text: async () => `<script>var DEST_URL = "${BASE_MAGNET}";</script>` };
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const res = await comando.fetchFollowingAllowed('https://systemads1.com/step1', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });

  test('1.2: 5-hop redirect chain resolves successfully', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      const match = u.match(/step(\d+)/);
      if (!match) throw new Error(`Unexpected URL: ${u}`);
      const step = Number(match[1]);

      if (step < 5) {
        return { status: 302, headers: new Map([['location', `https://systemads1.com/step${step + 1}`]]) };
      }
      return { ok: true, status: 200, text: async () => `<script>const DOWNLOAD_URL = '${BASE_MAGNET}';</script>` };
    }) as unknown as typeof globalThis.fetch;

    const res = await comando.fetchFollowingAllowed('https://systemads1.com/step0', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });

  test('1.3: 6-hop redirect chain (exact MAX_HOPS boundary) resolves successfully', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      const match = u.match(/step(\d+)/);
      if (!match) throw new Error(`Unexpected URL: ${u}`);
      const step = Number(match[1]);

      if (step < 6) {
        return { status: 302, headers: new Map([['location', `https://videosad.net/step${step + 1}`]]) };
      }
      return { ok: true, status: 200, text: async () => `<script>var LINK_FINAL = "${BASE_MAGNET}";</script>` };
    }) as unknown as typeof globalThis.fetch;

    const res = await comando.fetchFollowingAllowed('https://videosad.net/step0', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });

  test('1.4: 7-hop redirect chain exceeds MAX_HOPS and safely throws too_many_redirects', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;
      const match = u.match(/step(\d+)/);
      if (!match) throw new Error(`Unexpected URL: ${u}`);
      const step = Number(match[1]);

      return { status: 302, headers: new Map([['location', `https://systemads1.com/step${step + 1}`]]) };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/step0', 'https://comandotorrents.to/post'),
      /too_many_redirects/,
    );
  });

  test('1.5: 20-hop redirect chain terminates promptly with too_many_redirects without infinite loop', async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: any) => {
      callCount += 1;
      const u = typeof url === 'string' ? url : url.href;
      return { status: 302, headers: new Map([['location', `${u}_next`]]) };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://canalfutebol.com/chain0', 'https://comandotorrents.to/post'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('1.6: Mixed multi-hop redirect chain across HTTP 302, meta refresh, and JS variables', async () => {
    globalThis.fetch = (async (url: any) => {
      const u = typeof url === 'string' ? url : url.href;

      if (u.includes('hop0')) {
        return { status: 302, headers: new Map([['location', 'https://systemads1.com/hop1']]) };
      }
      if (u.includes('hop1')) {
        return { ok: true, status: 200, text: async () => '<html><head><meta http-equiv="refresh" content="0; url=https://videosad.net/hop2"></head></html>' };
      }
      if (u.includes('hop2')) {
        return { ok: true, status: 200, text: async () => '<script>var NEXT_URL = "https://canalfutebol.com/hop3";</script>' };
      }
      if (u.includes('hop3')) {
        return { ok: true, status: 200, text: async () => '<div class="content"><p>Download: <a href="https://systemads1.com/hop4">Clique aqui</a></p></div>' };
      }
      if (u.includes('hop4')) {
        return { ok: true, status: 200, text: async () => `<script>window.location.replace("${BASE_MAGNET}");</script>` };
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    const res = await comando.fetchFollowingAllowed('https://systemads1.com/hop0', 'https://comandotorrents.to/post');
    assert.equal(res, BASE_MAGNET);
  });
});

describe('Suite 2: Circular Redirect Loops & Self-Referential Redirects', () => {
  let originalFetch: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('2.1: 2-hop circular HTTP 302 redirect loop (A -> B -> A) terminates with too_many_redirects', async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: any) => {
      callCount += 1;
      const u = typeof url === 'string' ? url : url.href;
      if (u === 'https://systemads1.com/loopA') {
        return { status: 302, headers: new Map([['location', 'https://videosad.net/loopB']]) };
      }
      if (u === 'https://videosad.net/loopB') {
        return { status: 302, headers: new Map([['location', 'https://systemads1.com/loopA']]) };
      }
      throw new Error(`Unexpected URL: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/loopA', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('2.2: 3-hop circular redirect loop (A -> B -> C -> A) terminates with too_many_redirects', async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: any) => {
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
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/circA', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('2.3: Immediate self-referential HTTP 302 redirect (A -> A) terminates safely', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return { status: 302, headers: new Map([['location', 'https://systemads1.com/self']]) };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/self', 'https://comandotorrents.to/'),
      /too_many_redirects/,
    );
    assert.equal(callCount, 7);
  });

  test('2.4: HTML meta refresh self-loop (page points to itself) stops cleanly with no_magnet or loop exit', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<html><head><meta http-equiv="refresh" content="0; url=https://systemads1.com/self-meta"></head></html>',
      };
    }) as unknown as typeof globalThis.fetch;

    await assert.rejects(
      () => comando.fetchFollowingAllowed('https://systemads1.com/self-meta', 'https://comandotorrents.to/'),
      /(?:no_magnet|too_many_redirects)/,
    );
    assert.ok(callCount <= 7);
  });

  test('2.5: JS variable pointing to self URL stops cleanly with no_magnet', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return {
        ok: true,
        status: 200,
        text: async () => '<script>var NEXT_URL = "https://systemads1.com/self-js";</script>',
      };
    }) as unknown as typeof globalThis.fetch;

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
      'target', 'link', 'url', 'magnet',
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
