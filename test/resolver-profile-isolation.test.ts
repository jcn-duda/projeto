import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createResolver as createBludvResolver } from '../resolvers/profiles/bludv.js';
import { createResolver as createNerdfilmesResolver } from '../resolvers/profiles/nerdfilmes.js';
import { createProfile } from '../resolvers/site-profile.js';
import * as nerdParsers from '../resolvers/profiles/nerdfilmes-parsers.js';

// Fase 3 do saneamento: os profiles deixam de ler process.env no topo e passam
// a expor uma factory que recebe a configuração explícita. Depois da conversão
// para ESM, o teste também fixa que os profiles exportam a FACTORY, nunca uma
// instância — o shim é quem materializa a instância lazy.
//   1. importar um profile não lê nem muta o ambiente (import-safe);
//   2. duas instâncias do MESMO profile não compartilham cache nem seletor.
const PROFILE_NAMES = [
  'bludv', 'comandotorrents', 'nerdfilmes',
  'torrentdosfilmes', 'vacatorrent', 'redetorrent',
];
const PROFILES_DIR = fileURLToPath(new URL('../resolvers/profiles/', import.meta.url));

describe('Profiles de resolver: factory explícita e import-safe', () => {
  test('duas instâncias do mesmo profile têm configs e caches independentes', () => {
    const a = createBludvResolver({
      siteUrl: 'https://a.example',
      extraProtectors: ['prot-a.example'],
    });
    const b = createBludvResolver({
      siteUrl: 'https://b.example',
      extraProtectors: ['prot-b.example'],
    });

    // Config distinta por instância (sem estado de módulo compartilhado).
    assert.equal(a.siteSelector.url(), 'https://a.example');
    assert.equal(b.siteSelector.url(), 'https://b.example');
    assert.notEqual(a.siteSelector, b.siteSelector);

    // Allowlist de protetor também é por instância.
    assert.equal(a.isProtectorHost('prot-a.example'), true);
    assert.equal(a.isProtectorHost('prot-b.example'), false);
    assert.equal(b.isProtectorHost('prot-b.example'), true);
    assert.equal(b.isProtectorHost('prot-a.example'), false);

    // Caches independentes: escrever em um não vaza para o outro.
    assert.notEqual(a.postCache, b.postCache);
    assert.notEqual(a.magnetCache, b.magnetCache);
    a.postCache.set('hash-compartilhado', { value: 1, expiresAt: Date.now() + 60_000 });
    assert.equal(b.postCache.has('hash-compartilhado'), false);
  });

  test('nerdfilmes: parseDownloadLinks isolado por instância (override de protetores)', () => {
    const a = createNerdfilmesResolver({ extraProtectors: ['prot-a.example'] });
    const b = createNerdfilmesResolver({ extraProtectors: ['prot-b.example'] });
    const base = 'https://www.filmesviatorrenthd.org/post/';
    const htmlA = '<a href="https://prot-a.example/go/1">1080p BluRay DUBLADO</a>';
    const htmlB = '<a href="https://prot-b.example/go/2">1080p BluRay DUBLADO</a>';

    // O parseDownloadLinks injetado é o da INSTÂNCIA: cada uma reconhece só o
    // seu próprio protetor extra (não há singleton de módulo do parsers).
    assert.equal(a.parseDownloadLinks(htmlA, base).length, 1, 'a reconhece seu protetor');
    assert.equal(b.parseDownloadLinks(htmlA, base).length, 0, 'b ignora protetor de a');
    assert.equal(b.parseDownloadLinks(htmlB, base).length, 1, 'b reconhece seu protetor');
    assert.equal(a.parseDownloadLinks(htmlB, base).length, 0, 'a ignora protetor de b');
  });

  test('B1: extraProtectors em caixa mista é canonicalizado na factory', () => {
    const instance = createBludvResolver({
      extraProtectors: ['  Prot-Mixed.Example  ', 'OUTRO.example', 'prot-mixed.example'],
    });

    // hasAllowedHost compara host minúsculo; sem canonicalização o sufixo em
    // caixa mista nunca casa.
    assert.equal(instance.isProtectorHost('prot-mixed.example'), true);
    assert.equal(instance.isProtectorHost('sub.prot-mixed.example'), true);
    assert.equal(instance.isProtectorHost('outro.example'), true);
    // A descoberta genérica usa a mesma lista; o href da URL sai normalizado
    // (host minúsculo) pelo próprio construtor de URL.
    const html = '<p><a href="https://PROT-MIXED.example/go/7">1080p</a></p>';
    assert.equal(
      instance.nextProtectedUrl(html, 'https://bludvfilmes.xyz/post/'),
      'https://prot-mixed.example/go/7',
    );
  });

  test('B3: opts não consegue sobrescrever o assertAllowedUrl canônico', async () => {
    const bootstrap = createProfile({
      name: 'teste-b3',
      port: 1,
      selfUrl: 'http://teste-b3',
      siteUrl: 'https://site.example',
      urlsCsv: '',
      fallbackSuffixes: ['site.example'],
      decodeEntities: (value: any) => value,
    });
    // Um opts malicioso/errado que libera tudo não pode furar a allowlist.
    const fetchFollowing = bootstrap.fetchFollowingAllowed({
      assertAllowedUrl: () => ({ href: 'https://evil.example/' }),
    });
    await assert.rejects(() => fetchFollowing('https://evil.example/'), /blocked_host/);
  });

  test('B4: singleton do nerdfilmes-parsers não lê env; extras entram pela factory', () => {
    const saved = process.env.EXTRA_ALLOWED_PROTECTORS;
    process.env.EXTRA_ALLOWED_PROTECTORS = 'Env-Only.Example';
    try {
      assert.equal(nerdParsers.isProtectorHost('env-only.example'), false, 'singleton não pode ler env');
      const html = '<a href="https://env-only.example/go/1">1080p BluRay DUBLADO</a>';
      assert.equal(nerdParsers.parseDownloadLinks(html).length, 0, 'default base-only');

      const injected = nerdParsers.createNerdDownloadLinks({
        isProtectorHost: (hostname: string) => String(hostname).toLowerCase() === 'env-only.example',
      });
      assert.equal(injected(html, 'https://www.filmesviatorrenthd.org/post/').length, 1, 'factory injetada reconhece');
    } finally {
      if (saved === undefined) delete process.env.EXTRA_ALLOWED_PROTECTORS;
      else process.env.EXTRA_ALLOWED_PROTECTORS = saved;
    }
  });

  test('importar os profiles não lê nem muta process.env', () => {
    const keys = [
      'PORT', 'SELF_URL', 'SITE_URL',
      'BLUDV_URL', 'BLUDV_URLS', 'BLUDV_MAX_POSTS',
      'COMANDOTORRENTS_URL', 'NERDFILMES_URL', 'TORRENTDOSFILMES_URL',
      'VACATORRENT_URL', 'REDETORRENT_URL',
      'EXTRA_ALLOWED_PROTECTORS', 'EXTRA_PROTECTORS',
      'FLARE_SOLVERR_URL', 'FLARE_TIMEOUT_MS', 'FLARE_SESSION_TTL_MS',
      'TIMEOUT_MS', 'MAX_POSTS', 'POST_CACHE_MS', 'SEARCH_CACHE_MS',
      'MAGNET_CACHE_MS', 'MAX_RESOLVE_ATTEMPTS',
    ];
    // Filho limpo (ESM, `--input-type=module`): um Proxy troca a leitura de
    // qualquer env do perfil por um erro — se o topo do módulo ainda lesse o
    // ambiente, o import dinâmico estourava.
    const script = [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      `const keys = ${JSON.stringify(keys)};`,
      "const realEnv = process.env;",
      "const snapshot = {};",
      "for (const k of keys) snapshot[k] = realEnv[k];",
      "process.env = new Proxy(realEnv, { get(target, prop) {",
      "  if (typeof prop === 'string' && keys.includes(prop)) throw new Error('import leu env: ' + prop);",
      "  return target[prop];",
      "} });",
      `const names = ${JSON.stringify(PROFILE_NAMES)};`,
      `const dir = ${JSON.stringify(PROFILES_DIR)};`,
      "for (const name of names) {",
      "  const mod = await import(pathToFileURL(path.join(dir, name + '.js')).href);",
      "  if (typeof mod.createResolver !== 'function') throw new Error(name + ': profile sem createResolver');",
      "  if ('siteSelector' in mod || 'createServer' in mod) throw new Error(name + ': profile exporta instância');",
      "}",
      "for (const k of keys) { if (realEnv[k] !== snapshot[k]) throw new Error('import mutou env: ' + k); }",
      "process.stdout.write('ok');",
    ].join('\n');

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.equal(res.stdout.trim(), 'ok');
  });
});
