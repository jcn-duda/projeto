import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from '../src/config.js';
import * as brResolvers from '../src/br-resolvers.js';
// Cada teste constrói a PRÓPRIA instância: a sessão (cookie+token) e os caches
// vivem no closure do profile, então o singleton do shim vazaria estado entre
// os casos (uma sessão válida faria o teste de "home sem token" não falhar).
import { createResolver } from '../resolvers/profiles/apachetorrent.js';
import apachetorrentShim from '../apachetorrent-resolver/server.js';
const apachetorrent: any = apachetorrentShim;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixture = (name: any) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'apachetorrent', name), 'utf8');

const homeHtml = fixture('home.html');
const searchHtml = fixture('busca-coringa.html');
const postHtml = fixture('post-coringa-delirio.html');

const SITE = 'https://apachetorrents.com';

const fresh = () => createResolver({ siteUrl: SITE, extraProtectors: [] }) as any;

const response = (
  body: string,
  options: { status?: number; headers?: Record<string, string> } = {},
) => {
  const status = options.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(options.headers || {}),
    text: async () => body,
    url: '',
  };
};

// Dublê do site: o home (path "/") estabelece a sessão; index.php é a busca;
// qualquer outro path é o post. `handler` opcional sobrepõe um caso.
function stubFetch(handler?: (target: string) => unknown) {
  (globalThis.fetch as any) = async (url: any) => {
    const target = String(url);
    if (handler) {
      const custom = handler(target);
      if (custom) return custom;
    }
    if (target.includes('/index.php')) return response(searchHtml);
    if (new URL(target).pathname === '/') {
      return response(homeHtml, { headers: { 'set-cookie': 'PHPSESSID=sess1; path=/' } });
    }
    return response(postHtml);
  };
}

describe('apachetorrent: busca com sessão (fetch dublê)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('searchPosts busca com token + cookie e devolve magnet direto por post', async () => {
    const app = fresh();
    const calls: string[] = [];
    stubFetch((target) => {
      calls.push(target);
      return null;
    });
    const items: any[] = await app.searchPosts('Coringa');
    assert.ok(items.length >= 8, `esperava >= 8 releases, veio ${items.length}`);
    assert.ok(items.every((item) => item.link.url.startsWith('magnet:')));
    const buscas = calls.filter((c) => c.includes('/index.php'));
    assert.equal(buscas.length, 1);
    // O token veio do home e o honeypot vai VAZIO.
    assert.match(buscas[0], /[?&]token=97e7097dcaa4eed613be82c95985116c/);
    assert.match(buscas[0], /[?&]hp_bot_check=(&|$)/);
    // A home é buscada UMA vez (a sessão nasce ali).
    const homes = calls.filter((c) => new URL(c).pathname === '/');
    assert.equal(homes.length, 1);
  });

  test('token é reutilizado dentro da sessão: 2 buscas = 1 home', async () => {
    const app = fresh();
    let homeHits = 0;
    let searchHits = 0;
    stubFetch((target) => {
      if (target.includes('/index.php')) { searchHits += 1; return null; }
      if (new URL(target).pathname === '/') homeHits += 1;
      return null;
    });
    await app.searchPosts('Coringa');
    await app.searchPosts('Outra Busca');
    assert.equal(homeHits, 1, 'a sessão não é refeita a cada busca');
    assert.equal(searchHits, 2);
  });

  test('302 na busca renova a sessão e retenta UMA vez', async () => {
    const app = fresh();
    let homeHits = 0;
    let searchHits = 0;
    stubFetch((target) => {
      if (target.includes('/index.php')) {
        searchHits += 1;
        if (searchHits === 1) {
          return response('', { status: 302, headers: { location: `${SITE}/` } });
        }
        return null;
      }
      if (new URL(target).pathname === '/') {
        homeHits += 1;
        return response(homeHtml, { headers: { 'set-cookie': `PHPSESSID=sess${homeHits}; path=/` } });
      }
      return null;
    });
    const items: any[] = await app.searchPosts('Coringa');
    assert.ok(items.length >= 8);
    assert.equal(homeHits, 2, 'a sessão morta é renovada uma vez');
    assert.equal(searchHits, 2, 'a busca é retentada exatamente uma vez');
  });

  test('302 persistente vira session_rejected (não fica em laço)', async () => {
    const app = fresh();
    let homeHits = 0;
    let searchHits = 0;
    stubFetch((target) => {
      if (target.includes('/index.php')) {
        searchHits += 1;
        return response('', { status: 302, headers: { location: `${SITE}/` } });
      }
      if (new URL(target).pathname === '/') homeHits += 1;
      return null;
    });
    await assert.rejects(() => app.searchPosts('Coringa'), /session_rejected/);
    assert.equal(homeHits, 2, 'sessão persistente é renovada no máximo uma vez');
    assert.equal(searchHits, 2, 'busca persistente é retentada no máximo uma vez');
  });

  test('home sem token vira session_failed', async () => {
    const app = fresh();
    (globalThis.fetch as any) = async () => response('<html>sem form de busca</html>', {
      headers: { 'set-cookie': 'PHPSESSID=x' },
    });
    await assert.rejects(() => app.searchPosts('Coringa'), /session_failed/);
  });

  test('busca sem cards devolve lista vazia', async () => {
    const app = fresh();
    stubFetch((target) => (target.includes('/index.php') ? response('<div class="row"></div>') : null));
    const items: any[] = await app.searchPosts('Coringa');
    assert.equal(items.length, 0);
  });

  test('erro HTTP do site vira http_<status>', async () => {
    const app = fresh();
    stubFetch((target) => (target.includes('/index.php') ? response('', { status: 500 }) : null));
    await assert.rejects(() => app.searchPosts('Coringa'), /http_500/);
  });
});

describe('apachetorrent: rota /search do card', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('200 com div.posts/div.release e 502 quando a sessão falha', async () => {
    const app = fresh();
    stubFetch();

    const server = app.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address: any = server.address();
      const base = `http://127.0.0.1:${address.port}`;

      const health = await originalFetch(`${base}/health`);
      assert.equal(health.status, 200);

      const ok = await originalFetch(`${base}/search?q=Coringa`);
      assert.equal(ok.status, 200);
      assert.ok((await ok.text()).includes('class="release"'));

      // Sessão morta: a busca redireciona, o refresh busca o home e ele NÃO
      // traz o token → 502 com session_failed.
      (globalThis.fetch as any) = async (url: any) => {
        const target = String(url);
        if (target.includes('apachetorrent')) {
          if (target.includes('/index.php')) {
            return response('', { status: 302, headers: { location: `${SITE}/` } });
          }
          return response('<html></html>', { headers: { 'set-cookie': 'PHPSESSID=x' } });
        }
        return originalFetch(url);
      };

      const bad = await originalFetch(`${base}/search?q=Outra`);
      assert.equal(bad.status, 502);
      assert.match(await bad.text(), /session_failed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('apachetorrent: registro no addon', () => {
  test('porta, URL default e entrada na matriz RESOLVERS', () => {
    assert.equal(config.resolvers.ports.apachetorrent, 8706);
    assert.equal(
      new URL(config.resolvers.apachetorrentUrl).hostname.replace(/^www\./, ''),
      'apachetorrents.com',
    );
    const entry = brResolvers.RESOLVERS.find((r) => r.name === 'apachetorrent');
    assert.ok(entry, 'apachetorrent precisa estar na matriz RESOLVERS');
    assert.equal(entry.port, 8706);
    assert.equal(entry.siteEnv, 'APACHETORRENT_URL');
  });

  test('host ativo do seletor bate com o default de config', () => {
    const host = (url: string) => new URL(String(url)).hostname.replace(/^www\./, '');
    assert.equal(host(apachetorrent.siteSelector.url()), host(config.resolvers.apachetorrentUrl));
  });

  test('magnet direto é o único caminho: sem /resolve nem protetor de link', () => {
    for (const nome of ['resolveBest', 'resolveButton', 'magnetCache']) {
      assert.equal(apachetorrent[nome], undefined, `${nome} não deveria ser exportado`);
    }
    assert.equal(typeof apachetorrent.isProtectorHost, 'function');
    assert.equal(typeof apachetorrent.fetchSearchHtml, 'function');
  });
});
