import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CLIENT_ASSETS, PAGE_ASSETS } from '../src/routes/public.js';

const DIST_PAINEL_DIR = new URL('../src/public/client/painel/', import.meta.url);
const SRC_PAINEL_DIR = new URL('../../src/client/painel/', import.meta.url);
const PUBLIC_DIR = new URL('../src/public/', import.meta.url);

test('vendor preact.js confere exatamente com o hash no cabeçalho do preact.d.ts', () => {
  const dtsPath = new URL('vendor/preact.d.ts', SRC_PAINEL_DIR);
  const dtsContent = readFileSync(dtsPath, 'utf8');
  const hashMatch = dtsContent.match(/\/\/\s*sha256:\s*([0-9a-f]{64})/i);
  assert.ok(hashMatch, 'preact.d.ts precisa ter o sha256 no cabeçalho');
  const expectedHash = hashMatch[1].toLowerCase();

  const jsPath = new URL('vendor/preact.js', DIST_PAINEL_DIR);
  const jsContent = readFileSync(jsPath);
  const actualHash = createHash('sha256').update(jsContent).digest('hex').toLowerCase();
  assert.equal(actualHash, expectedHash, 'o sha256 do vendor precisa bater com o declarado no .d.ts');
});

/** Percorre o emit do painel recursivamente (o diretório `limpeza/` também
 * publica módulos) — a allowlist é comparada com o conjunto INTEIRO, não só o
 * topo, senão um módulo novo em subpasta fica sem rota sem ninguém notar. */
function emittedPainelModules(dir: URL, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...emittedPainelModules(new URL(entry.name + '/', dir), prefix + entry.name + '/'));
    } else if (entry.name.endsWith('.js')) {
      out.push('client/painel/' + prefix + entry.name);
    }
  }
  return out;
}

test('CLIENT_ASSETS cobre exatamente os arquivos do cliente /painel emitidos', () => {
  const allEmitted = emittedPainelModules(DIST_PAINEL_DIR).sort();

  const allowlisted = CLIENT_ASSETS.filter((a) => a.startsWith('client/painel/')).sort();
  assert.deepEqual(allowlisted, allEmitted, 'todo módulo emitido do painel precisa constar na allowlist fechada');
});

test('PAGE_ASSETS inclui painel-tokens.css e painel.css', () => {
  assert.ok(PAGE_ASSETS.includes('painel-tokens.css'), 'PAGE_ASSETS precisa conter painel-tokens.css');
  assert.ok(PAGE_ASSETS.includes('painel.css'), 'PAGE_ASSETS precisa conter painel.css');
  assert.ok(PAGE_ASSETS.includes('dashboard-tokens.css'), 'o painel consome dashboard-tokens.css');
  assert.equal(PAGE_ASSETS.includes('dashboard.css'), false, 'o dashboard.css legado saiu da allowlist');
});

test('painel.css define o alias .painel-form-grid usado por view-config', () => {
  const css = readFileSync(new URL('painel.css', PUBLIC_DIR), 'utf8');
  assert.match(css, /\.painel-form-grid\s*\{/, '.painel-form-grid precisa existir no CSS');
});

test('painel.html tem UM <script type="module"> no entry e carrega tokens + CSS', () => {
  const htmlPath = new URL('painel.html', PUBLIC_DIR);
  const html = readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 1, 'painel.html deve ter um único script');
  assert.match(scripts[0], /type="module"/);
  assert.match(scripts[0], /src="\/client\/painel\/entry\.js"/);

  assert.match(html, /<link\b[^>]*href="\/dashboard-tokens\.css"[^>]*>/);
  assert.match(html, /<link\b[^>]*href="\/painel-tokens\.css"[^>]*>/);
  assert.match(html, /<link\b[^>]*href="\/painel\.css"[^>]*>/);
  assert.match(html, /<div\s+id="app">\s*<\/div>/);
});

test('nenhum import nu ou require nos módulos do painel', () => {
  for (const rel of emittedPainelModules(DIST_PAINEL_DIR)) {
    const file = rel.replace('client/painel/', '');
    const js = readFileSync(new URL(file, DIST_PAINEL_DIR), 'utf8');
    const imports = [...js.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.match(spec, /\.js$/, file + ' importa sem .js: ' + spec);
    }
    assert.doesNotMatch(js, /\brequire\s*\(/, file + ' não pode usar require');
  }
});

test('HTTP GET /painel e /:userConfig/painel respondem 200 com no-store e HTML versionado', async () => {
  const { createApp } = await import('../src/app.js');
  const { createTestServer, encodeConfig } = await import('./e2e/e2e-harness.js');

  const server = await createTestServer(createApp().app);
  try {
    const res = await server.request('GET', '/painel');
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type') || ''), /html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.text, /src="\/client\/painel\/entry\.js\?v=[0-9a-f]{10}"/);
    assert.match(res.text, /href="\/painel\.css\?v=[0-9a-f]{10}"/);

    const userCfg = encodeConfig({ qualities: ['1080p'] });
    const resUser = await server.request('GET', `/${userCfg}/painel`);
    assert.equal(resUser.status, 200);
    assert.match(String(resUser.headers.get('content-type') || ''), /html/);
    assert.equal(resUser.headers.get('cache-control'), 'no-store');
    assert.match(resUser.text, /src="\/client\/painel\/entry\.js\?v=[0-9a-f]{10}"/);
  } finally {
    await server.close();
  }
});

