import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadResolverWithEnv(resolverName: string, envOverrides: Record<string, string | undefined | null> = {}) {
  const originalEnv = { ...process.env };
  const modulePath = path.resolve(__dirname, `../${resolverName}-resolver/server.js`);

  delete _require.cache[_require.resolve(modulePath)];

  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }

  let mod;
  try {
    mod = _require(modulePath);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
    delete _require.cache[_require.resolve(modulePath)];
  }

  return mod;
}

interface TestResult { suite: string; name: string; status: "PASS" | "FAIL"; error?: string; stack?: string; }
const results: TestResult[] = [];

function runTest(suite: any, name: any, fn: any) {
  try {
    fn();
    results.push({ suite, name, status: 'PASS' });
    console.log(`  [PASS] ${suite} > ${name}`);
  } catch (err) {
    results.push({ suite, name, status: 'FAIL', error: err.message, stack: err.stack });
    console.error(`  [FAIL] ${suite} > ${name}: ${err.message}`);
  }
}

async function runAsyncTest(suite: any, name: any, fn: any) {
  try {
    await fn();
    results.push({ suite, name, status: 'PASS' });
    console.log(`  [PASS] ${suite} > ${name}`);
  } catch (err) {
    results.push({ suite, name, status: 'FAIL', error: err.message, stack: err.stack });
    console.error(`  [FAIL] ${suite} > ${name}: ${err.message}`);
  }
}

async function main() {
  console.log('================================================================');
  console.log(' EMPIRICAL STRESS TEST SUITE — MILESTONE 1 CHALLENGER');
  console.log('================================================================\n');

  const RESOLVERS = ['bludv', 'comandotorrents', 'nerdfilmes', 'torrentdosfilmes'];

  // ============================================================================
  // SUITE 1: Dynamic Domain Environment Overrides & Fallbacks
  // ============================================================================
  console.log('--- Suite 1: Dynamic Domain Environment Overrides & Fallbacks ---');

  for (const r of RESOLVERS) {
    runTest('Suite 1: Dynamic Overrides', `${r}: aceita SITE_URL dinâmico customizado`, () => {
      const customUrl = `https://custom-mirror-${r}.online`;
      const mod = loadResolverWithEnv(r, { SITE_URL: customUrl });

      assert.equal(mod.isDetailHost(`custom-mirror-${r}.online`), true);
      assert.equal(mod.isDetailHost(`sub.custom-mirror-${r}.online`), true);
      assert.equal(mod.isDetailHost(`www.custom-mirror-${r}.online`), true);
      assert.doesNotThrow(() => mod.assertAllowedUrl(`${customUrl}/post-123/`));
    });

    runTest('Suite 1: Dynamic Overrides', `${r}: preserva fallbacks históricos mesmo com SITE_URL customizado`, () => {
      const mod = loadResolverWithEnv(r, { SITE_URL: 'https://new-mirror.cc' });

      if (r === 'bludv') {
        assert.equal(mod.isDetailHost('bludvfilmes.xyz'), true);
        assert.equal(mod.isDetailHost('bludv.net'), true);
        assert.equal(mod.isDetailHost('bludv.to'), true);
      } else if (r === 'comandotorrents') {
        assert.equal(mod.isDetailHost('comandotorrents.to'), true);
        assert.equal(mod.isDetailHost('comandotorrents.net'), true);
      } else if (r === 'nerdfilmes') {
        assert.equal(mod.isDetailHost('xnerdfilmes.net'), true);
        assert.equal(mod.isDetailHost('nerdfilmestorrent.com'), true);
      } else if (r === 'torrentdosfilmes') {
        assert.equal(mod.isDetailHost('torrentdosfilmes-v2.xyz'), true);
        assert.equal(mod.isDetailHost('torrentdosfilmes.com'), true);
      }
    });

    runTest('Suite 1: Dynamic Overrides', `${r}: respeita env específico (${r.toUpperCase()}_URL)`, () => {
      const specificEnvKey = `${r.toUpperCase()}_URL`;
      const specificUrl = `https://specific-${r}.org`;
      const mod = loadResolverWithEnv(r, { [specificEnvKey]: specificUrl, SITE_URL: undefined });

      assert.equal(mod.isDetailHost(`specific-${r}.org`), true);
      assert.equal(mod.isDetailHost(`www.specific-${r}.org`), true);
      assert.doesNotThrow(() => mod.assertAllowedUrl(`${specificUrl}/item/`));
    });
  }

  // ============================================================================
  // SUITE 2: Subdomain Matching across All Resolvers
  // ============================================================================
  console.log('\n--- Suite 2: Subdomain Matching Across All Resolvers ---');

  for (const r of RESOLVERS) {
    const mod = loadResolverWithEnv(r, {});

    runTest('Suite 2: Subdomain Matching', `${r}: aceita subdomínios simples (www., m., sub.)`, () => {
      if (r === 'bludv') {
        assert.equal(mod.isDetailHost('www.bludvfilmes.xyz'), true);
        assert.equal(mod.isDetailHost('m.bludvfilmes.xyz'), true);
        assert.equal(mod.isDetailHost('sub.bludv.net'), true);
      } else if (r === 'comandotorrents') {
        assert.equal(mod.isDetailHost('www.comandotorrents.to'), true);
        assert.equal(mod.isDetailHost('m.comandotorrents.net'), true);
      } else if (r === 'nerdfilmes') {
        assert.equal(mod.isDetailHost('www.xnerdfilmes.net'), true);
        assert.equal(mod.isDetailHost('sub.nerdfilmestorrent.com'), true);
      } else if (r === 'torrentdosfilmes') {
        assert.equal(mod.isDetailHost('www.torrentdosfilmes-v2.xyz'), true);
        assert.equal(mod.isDetailHost('cdn.torrentdosfilmes.com'), true);
      }
    });

    runTest('Suite 2: Subdomain Matching', `${r}: aceita subdomínios aninhados profundos (a.b.c.domain)`, () => {
      if (r === 'bludv') {
        assert.equal(mod.isDetailHost('alpha.beta.gamma.bludvfilmes.xyz'), true);
        assert.doesNotThrow(() => mod.assertAllowedUrl('https://static.cdn.bludv.to/img/1'));
      } else if (r === 'comandotorrents') {
        assert.equal(mod.isDetailHost('node1.media.comandotorrents.to'), true);
        assert.doesNotThrow(() => mod.assertAllowedUrl('https://node1.media.comandotorrents.to/'));
      } else if (r === 'nerdfilmes') {
        assert.equal(mod.isDetailHost('cache.edge.xnerdfilmes.net'), true);
        assert.doesNotThrow(() => mod.assertAllowedUrl('https://cache.edge.xnerdfilmes.net/'));
      } else if (r === 'torrentdosfilmes') {
        assert.equal(mod.isDetailHost('us.east.torrentdosfilmes-v2.xyz'), true);
        assert.doesNotThrow(() => mod.assertAllowedUrl('https://us.east.torrentdosfilmes-v2.xyz/'));
      }
    });
  }

  // ============================================================================
  // SUITE 3: SSRF & Malicious Input Vectors Stress Test
  // ============================================================================
  console.log('\n--- Suite 3: SSRF & Malicious Input Vectors Stress Test ---');

  for (const r of RESOLVERS) {
    const mod = loadResolverWithEnv(r, {});

    const ssrfVectors = [
      { name: 'localhost with port', url: 'http://localhost:8080/evil', expectedErr: /blocked_host/ },
      { name: 'localhost plain', url: 'http://localhost/admin', expectedErr: /blocked_host/ },
      { name: '127.0.0.1 loopback', url: 'http://127.0.0.1:8702/secret', expectedErr: /blocked_host/ },
      { name: '0.0.0.0 bind all', url: 'http://0.0.0.0:80/', expectedErr: /blocked_host/ },
      { name: 'AWS/GCP metadata IPv4', url: 'http://169.254.169.254/latest/meta-data/', expectedErr: /blocked_host/ },
      { name: 'IPv6 loopback', url: 'http://[::1]:8700/admin', expectedErr: /blocked_host/ },
      { name: 'file protocol passwd', url: 'file:///etc/passwd', expectedErr: /unsupported_protocol/ },
      { name: 'file protocol win.ini', url: 'file:///C:/Windows/win.ini', expectedErr: /unsupported_protocol/ },
      { name: 'gopher protocol', url: 'gopher://127.0.0.1:7000/', expectedErr: /unsupported_protocol/ },
      { name: 'ftp protocol', url: 'ftp://bludvfilmes.xyz/file', expectedErr: /unsupported_protocol/ },
      { name: 'javascript URI', url: 'javascript:alert(1)', expectedErr: /unsupported_protocol/ },
      { name: 'data URI', url: 'data:text/html,<script>alert(1)</script>', expectedErr: /unsupported_protocol/ },
      { name: 'query param spoofing', url: 'http://evil.com?x=xnerdfilmes.net', expectedErr: /blocked_host/ },
      { name: 'hash spoofing', url: 'http://evil.com#xnerdfilmes.net', expectedErr: /blocked_host/ },
      { name: 'subdomain spoofing on evil domain', url: 'http://xnerdfilmes.net.evil.com/', expectedErr: /blocked_host/ },
      { name: 'user info spoofing', url: 'http://xnerdfilmes.net@evil.com/', expectedErr: /blocked_host/ },
      { name: 'no-dot suffix collision (fakexnerdfilmes.net)', url: 'http://fakexnerdfilmes.net/', expectedErr: /blocked_host/ },
      { name: 'no-dot suffix collision (notbludvfilmes.xyz)', url: 'http://notbludvfilmes.xyz/', expectedErr: /blocked_host/ },
      { name: 'no-dot suffix collision (fakecomandotorrents.to)', url: 'http://fakecomandotorrents.to/', expectedErr: /blocked_host/ },
      { name: 'no-dot suffix collision (faketorrentdosfilmes-v2.xyz)', url: 'http://faketorrentdosfilmes-v2.xyz/', expectedErr: /blocked_host/ },
      { name: 'path spoofing', url: 'http://evil.com/xnerdfilmes.net', expectedErr: /blocked_host/ },
      { name: 'dot prefix in path', url: 'http://evil.com/.xnerdfilmes.net', expectedErr: /blocked_host/ },
    ];

    for (const vec of ssrfVectors) {
      runTest('Suite 3: SSRF Defense', `${r}: bloqueia ${vec.name} (${vec.url})`, () => {
        assert.throws(
          () => mod.assertAllowedUrl(vec.url),
          vec.expectedErr,
          `Deveria lançar ${vec.expectedErr} para ${vec.url}`
        );
      });
    }

    runTest('Suite 3: SSRF Defense', `${r}: isDetailHost rejeita domínios maliciosos e protetores`, () => {
      assert.equal(mod.isDetailHost('evil.com'), false);
      assert.equal(mod.isDetailHost('localhost'), false);
      assert.equal(mod.isDetailHost('127.0.0.1'), false);
      assert.equal(mod.isDetailHost('169.254.169.254'), false);
      assert.equal(mod.isDetailHost('xnerdfilmes.net.evil.com'), false);
      assert.equal(mod.isDetailHost('fakexnerdfilmes.net'), false);
      assert.equal(mod.isDetailHost('systemads1.com'), false);
      assert.equal(mod.isDetailHost('videosad.net'), false);
      assert.equal(mod.isDetailHost('canalfutebol.com'), false);
      assert.equal(mod.isDetailHost(''), false);
      assert.equal(mod.isDetailHost(null), false);
      assert.equal(mod.isDetailHost(undefined), false);
    });

    runTest('Suite 3: Malformed Inputs', `${r}: assertAllowedUrl trata entradas vazias ou corrompidas`, () => {
      assert.throws(() => mod.assertAllowedUrl(''), /Invalid URL|unsupported_protocol|blocked_host/);
      assert.throws(() => mod.assertAllowedUrl('http://'), /Invalid URL/);
      assert.throws(() => mod.assertAllowedUrl('not-a-url'), /Invalid URL/);
    });
  }

  // ============================================================================
  // SUITE 4: EXTRA_ALLOWED_PROTECTORS Parsing & Allowlisting
  // ============================================================================
  console.log('\n--- Suite 4: EXTRA_ALLOWED_PROTECTORS Parsing & Allowlisting ---');

  for (const r of RESOLVERS) {
    runTest('Suite 4: Extra Protectors', `${r}: faz parse de múltiplos protetores com espaços, maiúsculas e vírgulas extras`, () => {
      const extra = '   protector-one.com  ,  ,  PROTECTOR-TWO.NET , \t , sub.protector-three.org \n , ';
      const mod = loadResolverWithEnv(r, { EXTRA_ALLOWED_PROTECTORS: extra });

      // Protetores customizados devem ser aceitos em assertAllowedUrl
      assert.doesNotThrow(() => mod.assertAllowedUrl('https://protector-one.com/link/123'));
      assert.doesNotThrow(() => mod.assertAllowedUrl('https://PROTECTOR-TWO.NET/go'));
      assert.doesNotThrow(() => mod.assertAllowedUrl('https://sub.protector-three.org/down'));
      assert.doesNotThrow(() => mod.assertAllowedUrl('https://nested.sub.protector-three.org/down'));

      // isProtectorHost deve reconhecer
      assert.equal(mod.isProtectorHost('protector-one.com'), true);
      assert.equal(mod.isProtectorHost('protector-two.net'), true);
      assert.equal(mod.isProtectorHost('sub.protector-three.org'), true);
      assert.equal(mod.isProtectorHost('sub.protector-one.com'), true);

      // Não deve vazar para isDetailHost
      assert.equal(mod.isDetailHost('protector-one.com'), false);
      assert.equal(mod.isDetailHost('protector-two.net'), false);

      // Domínio não listado continua bloqueado
      assert.equal(mod.isProtectorHost('unlisted-protector.com'), false);
      assert.throws(() => mod.assertAllowedUrl('https://unlisted-protector.com/link'), /blocked_host/);
    });

    runTest('Suite 4: Extra Protectors', `${r}: trata EXTRA_ALLOWED_PROTECTORS vazio, whitespace ou inexistente`, () => {
      for (const emptyVal of ['', '   ', ' \t\n ', ',,,,']) {
        const mod = loadResolverWithEnv(r, { EXTRA_ALLOWED_PROTECTORS: emptyVal });
        // Protetores base ainda funcionam
        assert.equal(mod.isProtectorHost('systemads1.com'), true);
        assert.equal(mod.isProtectorHost('videosad.net'), true);
        assert.equal(mod.isProtectorHost('canalfutebol.com'), true);
        // Desconhecido é bloqueado
        assert.equal(mod.isProtectorHost('evil-ad.com'), false);
      }
    });

    runTest('Suite 4: Extra Protectors', `${r}: nextProtectedUrl extrai links apontando para protetores extras`, () => {
      const extra = 'new-safe-protector.com';
      const mod = loadResolverWithEnv(r, { EXTRA_ALLOWED_PROTECTORS: extra });

      const base = 'https://systemads1.com/step1';
      const htmlJs = '<script>var DEST_URL = "https://new-safe-protector.com/step2";</script>';
      const htmlLink = '<a href="https://new-safe-protector.com/step2">Continue</a>';

      assert.equal(mod.nextProtectedUrl(htmlJs, base), 'https://new-safe-protector.com/step2');
      assert.equal(mod.nextProtectedUrl(htmlLink, base), 'https://new-safe-protector.com/step2');

      // Se o link apontar para host não permitido, deve retornar null
      const htmlEvil = '<script>var DEST_URL = "https://evil-unauthorized.com/step2";</script>';
      assert.equal(mod.nextProtectedUrl(htmlEvil, base), null);
    });
  }

  // ============================================================================
  // SUITE 5: In-Flight Request Coalescing Under High Concurrency
  // ============================================================================
  console.log('\n--- Suite 5: High-Concurrency In-Flight Coalescing Stress Test ---');

  for (const r of ['bludv', 'comandotorrents', 'torrentdosfilmes']) {
    await runAsyncTest('Suite 5: Concurrency Coalescing', `${r}: 50 requisições simultâneas disparam exatamente 1 fetch`, async () => {
      const mod = loadResolverWithEnv(r, {});
      if (mod.postCache) mod.postCache.clear();
      if (mod.inFlight) mod.inFlight.clear();

      let fetchCount = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          fetchCount += 1;
          // Simula latência de rede
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            ok: true,
            status: 200,
            text: async () => `
              <div class="post-single">
                <h3>VERSÃO MKV DUAL ÁUDIO</h3>
                <p>1080p (2.0 GB)</p>
                <a href="https://systemads1.com/go/link1">Magnet-Link</a>
              </div>
            `,
          };
        }) as unknown as typeof globalThis.fetch;

        const postUrl = r === 'bludv'
          ? 'https://bludvfilmes.xyz/filme-concorrencia-pesada/'
          : r === 'comandotorrents'
            ? 'https://comandotorrents.to/filme-concorrencia-pesada/'
            : 'https://torrentdosfilmes-v2.xyz/filme-concorrencia-pesada/';

        const promises = Array.from({ length: 50 }, () => mod.getPostLinks(postUrl));
        const allResults = await Promise.all(promises);

        assert.equal(fetchCount, 1, `Esperava exatamente 1 fetch para 50 chamadas simultâneas, mas foram ${fetchCount}`);
        assert.equal(allResults.length, 50);
        for (const res of allResults) {
          assert.ok(res.links);
          assert.equal(res.links.length, 1);
        }
        assert.equal(mod.inFlight.size, 0, 'inFlight deve estar vazio após conclusão');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  // ============================================================================
  // SUITE 6: Error Handling & Process Resilience
  // ============================================================================
  console.log('\n--- Suite 6: Error Handling & Process Resilience ---');

  for (const r of RESOLVERS) {
    await runAsyncTest('Suite 6: Resilience', `${r}: getPostLinks propaga erro HTTP sem corromper estado ou inFlight`, async () => {
      const mod = loadResolverWithEnv(r, {});
      if (mod.postCache) mod.postCache.clear();
      if (mod.inFlight) mod.inFlight.clear();

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => ({
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
        })) as unknown as typeof globalThis.fetch;

        const postUrl = r === 'bludv'
          ? 'https://bludvfilmes.xyz/filme-erro/'
          : r === 'comandotorrents'
            ? 'https://comandotorrents.to/filme-erro/'
            : r === 'nerdfilmes'
              ? 'https://www.xnerdfilmes.net/filme-erro/'
              : 'https://torrentdosfilmes-v2.xyz/filme-erro/';

        await assert.rejects(
          () => mod.getPostLinks(postUrl),
          /http_503/,
          'Deveria rejeitar com http_503'
        );

        if (mod.inFlight) {
          assert.equal(mod.inFlight.size, 0, 'inFlight map deve ser limpo mesmo em caso de erro');
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  // Summary
  console.log('\n================================================================');
  const total = results.length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;

  console.log(` TOTAL TESTS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error in stress test runner:', err);
  process.exit(1);
});
