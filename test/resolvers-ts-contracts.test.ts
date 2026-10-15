import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeEntities, parseSize, stripTags, extractMetaRefresh } from '../resolvers/text.js';
import { mapLimit } from '../resolvers/concurrency.js';
import { unwrapResolverUrl } from '../resolvers/nested-url.js';
import { createMagnetExtractor } from '../resolvers/magnet-extract.js';
import { createQualityRules, createSourceRules, createEpisodeRules } from '../resolvers/release-rules.js';
import { cleanPostTitle, createNormalizeQuery } from '../resolvers/release-format.js';
import { assertAllowedUrl, hasAllowedHost } from '../resolvers/protector.js';
import { capsXml } from '../resolvers/torznab.js';
import { createCache } from '../resolvers/cache.js';
import { selectSearchPosts } from '../resolvers/search-posts.js';
import { isMain } from '../resolvers/is-main.js';
import { createSiteSelector } from '../resolvers/site-selector.js';
import { createProfile } from '../resolvers/site-profile.js';
import * as bludvParsers from '../resolvers/profiles/bludv-parsers.js';
import * as nerdParsers from '../resolvers/profiles/nerdfilmes-parsers.js';
import * as redeParsers from '../resolvers/profiles/redetorrent-parsers.js';
import * as vacaParsers from '../resolvers/profiles/vacatorrent-parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// De dist/test/ a raiz do repositório fica dois níveis acima.
const ROOT = path.join(__dirname, '..', '..');

// Folhas puras de baixa dependência convertidas para .ts (U1). A lista é a
// fonte da verdade dos asserts de fonte×emit abaixo.
const CONVERTED = [
  'text', 'concurrency', 'nested-url', 'magnet-extract', 'matching', 'protector',
  'runtime', 'torznab', 'http-server', 'cache', 'is-main', 'search-posts',
  'resolver-http', 'transport', 'release-rules', 'release-format', 'site-selector',
  'env-config', 'flare',
];

// U2: bootstrap (resolvers/) + os parser modules (resolvers/profiles/).
const CONVERTED_U2 = [
  'site-profile',
  'profiles/bludv-parsers',
  'profiles/nerdfilmes-parsers',
  'profiles/redetorrent-parsers',
  'profiles/vacatorrent-parsers',
];

// U3: os seis profiles principais.
const CONVERTED_U3 = [
  'profiles/bludv',
  'profiles/comandotorrents',
  'profiles/nerdfilmes',
  'profiles/redetorrent',
  'profiles/torrentdosfilmes',
  'profiles/vacatorrent',
];

// U4: o helper lazy do Proxy (os seis shims e os scripts ficam fora de
// resolvers/ e são provados no describe de emit logo abaixo).
const CONVERTED_U4 = ['shim-instance'];

const SHIM_DIRS = [
  'bludv-resolver',
  'comandotorrents-resolver',
  'nerdfilmes-resolver',
  'torrentdosfilmes-resolver',
  'vacatorrent-resolver',
  'redetorrent-resolver',
];

describe('U1: folhas convertidas mantêm o comportamento', () => {
  test('text: decodificação rica, tamanho e meta-refresh', () => {
    assert.equal(decodeEntities('&amp;&#233;'), '&é');
    assert.equal(stripTags('<b>Dual</b> Áudio'), 'Dual Áudio');
    assert.equal(parseSize('2,6 GB'), Math.round(2.6 * 1024 ** 3));
    assert.equal(parseSize('1 KB'), 1024);
    assert.equal(extractMetaRefresh('<meta http-equiv="refresh" content="0;url=https://x.test/a">'), 'https://x.test/a');
  });

  test('concurrency: mapLimit preserva ordem e descarta falhas', async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, async (n) => {
      if (n === 3) throw new Error('boom');
      return n * 10;
    });
    assert.deepEqual(out, [10, 20, 40]);
  });

  test('nested-url: desempacota /resolve aninhado e propaga campos', () => {
    const inner = 'https://alvo.test/go/1';
    const outer = `https://self.test/resolve?url=${encodeURIComponent(inner)}&i=3&h=abc`;
    const out = unwrapResolverUrl(outer, 'https://self.test');
    assert.equal(out.url, inner);
    assert.equal(out.index, '3');
    assert.equal(out.hash, 'abc');
  });

  test('magnet-extract: variante básica e rica', () => {
    const basic = createMagnetExtractor({ decodeEntities });
    const rich = createMagnetExtractor({ decodeEntities, encodedVariants: true });
    assert.equal(
      basic('<script>var url = "magnet:?xt=urn:btih:BD&dn=x";</script>'),
      'magnet:?xt=urn:btih:BD&dn=x',
    );
    assert.equal(
      rich('data-download="magnet%3A%3Fxt%3Durn%3Abtih%3AAC%26dn%3Dy"'),
      'magnet:?xt=urn:btih:AC&dn=y',
    );
  });

  test('release-rules: qualidade/fonte/episódio', () => {
    const q = createQualityRules();
    assert.equal(q.normalizeQuality('Filme 1080p x265'), 1080);
    const s = createSourceRules();
    assert.equal(s.normalizeSource('Filme 1080p WEB-DL'), 'WEB-DL');
    const e = createEpisodeRules();
    assert.equal(e.extractEpisode('Série S02E03'), 3);
    assert.equal(e.extractEpisode('EPISÓDIOS 01 AO 10'), null);
  });

  test('release-format: limpeza e normalizeQuery', () => {
    assert.equal(cleanPostTitle('Filme Torrent (2024) 1080p WEB-DL Dublado'), 'Filme (2024)');
    assert.equal(createNormalizeQuery()('Nome S01E01'), 'Nome');
  });

  test('protector: allowlist por sufixo e protocolo', () => {
    assert.equal(hasAllowedHost('go.systemads1.com', ['systemads1.com']), true);
    assert.equal(hasAllowedHost('evil.com', ['systemads1.com']), false);
    assert.throws(() => assertAllowedUrl('https://evil.com/x', ['systemads1.com']), /blocked_host/);
  });

  test('torznab: caps com o título do perfil', () => {
    assert.match(capsXml('Teste'), /<server title="Teste"/);
  });

  test('search-posts: filtra por título e corta no teto', () => {
    const posts = [{ url: 'a', title: 'Coringa (2019)' }, { url: 'b', title: 'Outro Filme' }];
    const out = selectSearchPosts(() => posts, '', 'Coringa', null, 5);
    assert.deepEqual(out.map((p) => p.url), ['a']);
  });

  test('is-main: sem entrypoint não há principal', () => {
    assert.equal(isMain('file:///x/server.js', undefined), false);
  });
});

describe('U1: contrato do cache é o Map real (sem fachada inventada)', () => {
  test('createCache expõe values/inFlight/cached/clear e compartilha inFlight', async () => {
    const cache = createCache(2);
    assert.ok(cache.values instanceof Map);
    assert.ok(cache.inFlight instanceof Map);
    assert.equal(typeof cache.cached, 'function');
    assert.equal(typeof cache.clear, 'function');

    let loads = 0;
    const loader = () => { loads += 1; return Promise.resolve({ ok: true }); };
    const [a, b] = await Promise.all([cache.cached('k', 1000, loader), cache.cached('k', 1000, loader)]);
    assert.deepEqual(a, { ok: true });
    assert.deepEqual(b, { ok: true });
    assert.equal(loads, 1, 'coalescing deve rodar o loader uma vez');
    assert.equal(cache.values.size, 1);
    assert.deepEqual(cache.values.get('k')?.value, { ok: true });
  });
});

describe('U1: seletor cumpre o contrato real (noteFailure devolve o domínio)', () => {
  test('url/hosts/noteFailure', async () => {
    const selector = createSiteSelector('[teste]', '', 'https://a.example', ['b.example'], { failsBeforeProbe: 99 });
    assert.equal(selector.url(), 'https://a.example');
    assert.deepEqual(selector.hosts().sort(), ['a.example', 'b.example']);
    assert.equal(await selector.noteFailure(), 'https://a.example');
  });

  test('isNetworkError preserva a semântica de thrown com .message', () => {
    const bootstrap = createProfile({
      name: 'teste-ine',
      port: 1,
      selfUrl: 'http://teste-ine',
      siteUrl: 'https://site.example',
      fallbackSuffixes: ['site.example'],
      networkErrorExtra: '|flare_',
      decodeEntities: (value: string | null | undefined) => String(value ?? ''),
    });
    // Objeto simples (não Error) com .message continua classificável.
    assert.equal(bootstrap.isNetworkError({ message: 'blocked_host:evil.test' }), false);
    assert.equal(bootstrap.isNetworkError({ message: 'getaddrinfo ENOTFOUND site.example' }), true);
    // A exclusão extra do perfil (flare_) precisa valer na mesma regra.
    assert.equal(bootstrap.isNetworkError({ message: 'flare_http_500' }), false);
    assert.equal(bootstrap.isNetworkError(new Error('socket hang up')), true);
  });
});

describe('U2: bootstrap e parser modules mantêm o contrato', () => {
  test('createProfile: allowlist canônica e hosts do seletor', () => {
    const bootstrap = createProfile({
      name: 'teste-u2',
      port: 1,
      selfUrl: 'http://teste-u2',
      siteUrl: 'https://site.example',
      fallbackSuffixes: ['site.example'],
      decodeEntities: (value: string | null | undefined) => String(value ?? ''),
    });
    assert.equal(bootstrap.selfUrl, 'http://teste-u2');
    assert.equal(bootstrap.isDetailHost('www.site.example'), true);
    assert.equal(bootstrap.isDetailHost('evil.example'), false);
    assert.equal(bootstrap.assertAllowedUrl('https://site.example/post/').hostname, 'site.example');
    assert.throws(() => bootstrap.assertAllowedUrl('https://evil.example/post/'), /blocked_host/);
    assert.equal(bootstrap.stripTags('<b>Dual</b> Áudio'), 'Dual Áudio');
  });

  test('bludv-parsers: magnet válido e título de release', () => {
    assert.equal(bludvParsers.isValidMagnetUri('magnet:?xt=urn:btih:' + 'a'.repeat(40)), true);
    assert.equal(bludvParsers.isValidMagnetUri('magnet:?xt=urn:btih:curto'), false);
    assert.match(bludvParsers.releaseTitle('Filme Torrent (2024) 1080p WEB-DL Dublado', {
      quality: 1080, source: 'WEB-DL', audio: 'dublado', episode: null, size: null,
    }), /1080p WEB-DL DUBLADO/);
  });

  test('nerdfilmes-parsers: attribute/parsePosts/classificadores', () => {
    assert.equal(nerdParsers.attribute('<a href="https://x.test/a" title="T">', 'href'), 'https://x.test/a');
    const posts = nerdParsers.parsePosts('<article class="featured col item"><div class="item"><div class="image"><a title="Coringa (2019)" href="https://www.filmesviatorrenthd.org/coringa-2019/"><img src="p.jpg"></a></div></div></article>');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://www.filmesviatorrenthd.org/coringa-2019/');
  });

  test('redetorrent-parsers: magnet direto e token systemads', () => {
    const magnet = 'magnet:?xt=urn:btih:' + 'b'.repeat(40) + '&dn=Filme';
    assert.equal(redeParsers.extractMagnetHref(magnet), magnet);
    assert.equal(redeParsers.extractMagnetHref('https://legenda.example/x.srt'), null);
    assert.equal(redeParsers.classifyAudio('LEGENDADO PTBR'), 'legendado');
  });

  test('vacatorrent-parsers: JSON de busca e classificadores', () => {
    const works = vacaParsers.parseSearchJson(JSON.stringify([{ title: 'Um Dia de Sorte', link: '/pt/movie/um-dia/', type: 'Filme', year: 2025 }]));
    assert.equal(works.length, 1);
    assert.equal(works[0].type, 'Filme');
    assert.equal(vacaParsers.extractBatchTitle('<h2 class="bl-hero-title">Título Real</h2>'), 'Título Real');
  });
});

describe('U1: pipeline compila os .ts e não vaza .ts para dist/', () => {
  test('fonte: .ts presente e .js substituído removido', () => {
    for (const name of [...CONVERTED, ...CONVERTED_U2, ...CONVERTED_U3, ...CONVERTED_U4]) {
      assert.ok(fs.existsSync(path.join(ROOT, 'resolvers', `${name}.ts`)), `${name}.ts não existe`);
      assert.equal(fs.existsSync(path.join(ROOT, 'resolvers', `${name}.js`)), false, `${name}.js ainda existe`);
    }
    // Os shims/scripts próprios: fonte .ts, sem .js e sem .d.ts.
    for (const dir of SHIM_DIRS) {
      assert.ok(fs.existsSync(path.join(ROOT, dir, 'server.ts')), `${dir}/server.ts não existe`);
      assert.equal(fs.existsSync(path.join(ROOT, dir, 'server.js')), false, `${dir}/server.js fonte ainda existe`);
      assert.equal(fs.existsSync(path.join(ROOT, dir, 'server.d.ts')), false, `${dir}/server.d.ts redundante ainda existe`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'nerdfilmes-resolver', 'test.ts')), 'test.ts não existe');
    assert.equal(fs.existsSync(path.join(ROOT, 'nerdfilmes-resolver', 'test.js')), false, 'test.js fonte ainda existe');
    assert.ok(fs.existsSync(path.join(ROOT, 'torrentdosfilmes-resolver', 'smoke-test.ts')), 'smoke-test.ts não existe');
    assert.equal(fs.existsSync(path.join(ROOT, 'torrentdosfilmes-resolver', 'smoke-test.js')), false, 'smoke-test.js fonte ainda existe');
  });

  test('emit: dist/resolvers/*.js existe e nenhum .ts vaza', () => {
    const distResolvers = path.join(ROOT, 'dist', 'resolvers');
    assert.ok(fs.existsSync(distResolvers), 'dist/resolvers não existe');
    for (const name of [...CONVERTED, ...CONVERTED_U2, ...CONVERTED_U3, ...CONVERTED_U4]) {
      assert.ok(fs.existsSync(path.join(distResolvers, `${name}.js`)), `${name}.js não foi emitido`);
    }
    const leaked = fs.readdirSync(distResolvers, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name);
    assert.deepEqual(leaked, [], `dist/resolvers vazou .ts: ${leaked.join(', ')}`);
  });

  test('U4: shims compilados pelo tsc — sem fonte .ts vazada e com .js emitido', () => {
    for (const shim of ['bludv-resolver', 'nerdfilmes-resolver', 'torrentdosfilmes-resolver']) {
      const dir = path.join(ROOT, 'dist', shim);
      assert.ok(fs.existsSync(path.join(dir, 'server.js')), `${shim}/server.js não foi emitido pelo tsc`);
    }
    // O smoke-test do tdf e o test do nerd também são emitidos (scripts .ts).
    assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'nerdfilmes-resolver', 'test.js')), 'test.js não emitido');
    assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'torrentdosfilmes-resolver', 'smoke-test.js')), 'smoke-test.js não emitido');
    // Nenhuma FONTE .ts em dist/ (só .js emitido); .d.ts de shim não existe mais.
    const shimTs = fs.readdirSync(path.join(ROOT, 'dist'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name);
    assert.deepEqual(shimTs, [], `dist/ vazou .ts: ${shimTs.join(', ')}`);
    for (const shim of ['bludv-resolver', 'nerdfilmes-resolver']) {
      assert.equal(fs.existsSync(path.join(ROOT, 'dist', shim, 'server.d.ts')), false, `${shim}/server.d.ts não deveria existir`);
    }
  });

  test('imports de runtime continuam com extensão .js', () => {
    const src = fs.readFileSync(path.join(ROOT, 'resolvers', 'release-format.ts'), 'utf8');
    assert.match(src, /from '\.\/text\.js'/);
    assert.match(src, /from '\.\/matching\.js'/);
    assert.ok(!/from '\.\/text'/.test(src), 'import sem .js não é aceito no ESM runtime');
  });

  test('U4: o contrato do shim virou código TS; o .d.ts morto foi removido', () => {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'types', 'resolver-shim.d.ts')),
      false,
      'types/resolver-shim.d.ts ficou morto e deveria ter sido removido',
    );
    const contracts = fs.readFileSync(path.join(ROOT, 'resolvers', 'types.ts'), 'utf8');
    assert.ok(!/noteFailure\(\):\s*Promise<void>/.test(contracts), 'noteFailure ainda mente (void)');
    assert.match(contracts, /noteFailure\(\):\s*Promise<string>/);
    assert.match(contracts, /ResolverCacheEntry/);
  });
});
