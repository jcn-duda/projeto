import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Infraestrutura C1+C2+C3: os clientes de /configure e /dashboard são ESM
// nativo compilado para o browser (dist/src/public/client) e, num segundo emit,
// para o Node (dist/src/client) só para os testes. Sem AMD, sem loader, sem
// bundle e sem suporte obrigatório a WebView sem ESM.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const CLIENTS = [
  { name: 'configure', browser: path.join(ROOT, 'dist', 'src', 'public', 'client', 'configure'), node: path.join(ROOT, 'dist', 'src', 'client', 'configure') },
  { name: 'dashboard', browser: path.join(ROOT, 'dist', 'src', 'public', 'client', 'dashboard'), node: path.join(ROOT, 'dist', 'src', 'client', 'dashboard') },
];

function readJson(rel: string): any {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

test('tsconfig raiz exclui src/client; os dois emits têm tsconfig próprio', () => {
  const root = readJson('tsconfig.json');
  assert.ok(root.exclude.includes('src/client'));
  const browser = readJson('tsconfig.client.json');
  assert.equal(browser.compilerOptions.outDir, 'dist/src/public/client');
  assert.equal(browser.compilerOptions.module, 'ESNext');
  const node = readJson('tsconfig.client.test.json');
  assert.equal(node.compilerOptions.outDir, 'dist/src/client');
  assert.equal(node.compilerOptions.module, 'NodeNext');
  assert.equal(node.compilerOptions.target, 'ES2022');
});

test('build/typecheck cobrem os três programas', () => {
  const scripts = readJson('package.json').scripts;
  assert.match(scripts.build, /tsconfig\.client\.json/);
  assert.match(scripts.build, /tsconfig\.client\.test\.json/);
  assert.match(scripts.typecheck, /tsconfig\.client\.json/);
  assert.match(scripts.typecheck, /tsconfig\.client\.test\.json/);
});

test('browser emit dos dois clientes é ESM nativo (sem define/AMD/require)', () => {
  for (const client of CLIENTS) {
    const files = fs.readdirSync(client.browser);
    assert.ok(files.length >= 2, client.name + ' precisa de módulos no dist');
    for (const file of files) {
      const code = fs.readFileSync(path.join(client.browser, file), 'utf8');
      assert.doesNotMatch(code, /\bdefine\s*\(/, client.name + '/' + file + ' não pode ter AMD');
      assert.doesNotMatch(code, /\brequire\s*\(/, client.name + '/' + file + ' não pode ter require');
      for (const spec of [...code.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1])) {
        assert.match(spec, /\.js$/, client.name + '/' + file + ' importa sem .js: ' + spec);
      }
    }
  }
  const configureEntry = fs.readFileSync(path.join(CLIENTS[0].browser, 'entry.js'), 'utf8');
  assert.match(configureEntry, /import\s*\{\s*init\s*\}\s*from\s*'\.\/init\.js'/);
  assert.match(configureEntry, /\binit\(\);/);
  const dashboardEntry = fs.readFileSync(path.join(CLIENTS[1].browser, 'entry.js'), 'utf8');
  assert.match(dashboardEntry, /from\s*'\.\/hooks\.js'/);
  assert.match(dashboardEntry, /registerHooks\(\)/);
  assert.match(dashboardEntry, /\bbind\(\);/);
});

test('segundo emit NodeNext existe em dist/src/client para os dois clientes', () => {
  for (const client of CLIENTS) {
    const expected = client.name === 'configure'
      ? ['entry.js', 'init.js', 'state.js', 'view.js', 'indexers.js']
      : ['entry.js', 'hooks.js', 'state.js', 'core.js', 'render.js', 'status-root.js', 'boot.js'];
    for (const file of expected) assert.ok(fs.existsSync(path.join(client.node, file)), 'faltou ' + client.name + '/' + file);
  }
});

test('módulos não têm efeito de DOM no import (entry é quem chama init/bind)', async () => {
  const configure = ['state.js', 'dom.js', 'keys.js', 'limits.js', 'indexers.js', 'view.js', 'seal.js', 'init.js'];
  for (const file of configure) {
    const mod = await import(pathToFileURL(path.join(CLIENTS[0].node, file)).href);
    assert.equal(typeof mod, 'object', file + ' precisa importar');
  }
  // Dashboard: importa TODO o grafo, exceto o entry (que roda bind() no topo).
  const dashboard = fs.readdirSync(CLIENTS[1].node).filter((f) => f.endsWith('.js') && f !== 'entry.js');
  for (const file of dashboard) {
    const mod = await import(pathToFileURL(path.join(CLIENTS[1].node, file)).href);
    assert.equal(typeof mod, 'object', file + ' precisa importar sem DOM');
  }
});

test('allowlist fechada do servidor cobre todo o emit de browser (configure e dashboard)', async () => {
  const { CLIENT_ASSETS } = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'routes', 'public.js')).href);
  for (const client of CLIENTS) {
    const emitted = fs.readdirSync(client.browser).map((f) => 'client/' + client.name + '/' + f);
    for (const rel of emitted) assert.ok(CLIENT_ASSETS.includes(rel), 'emit sem rota na allowlist: ' + rel);
  }
  for (const rel of CLIENT_ASSETS) {
    assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'src', 'public', rel)), 'allowlist sem emit: ' + rel);
  }
});

test('configure.html carrega o entry ESM; dashboard.html carrega UM module no entry', () => {
  const configure = fs.readFileSync(path.join(ROOT, 'dist', 'src', 'public', 'configure.html'), 'utf8');
  assert.match(configure, /<script type="module" src="\/client\/configure\/entry\.js"><\/script>/);
  assert.doesNotMatch(configure, /<script>\s*"use strict"/);
  const dashboard = fs.readFileSync(path.join(ROOT, 'dist', 'src', 'public', 'dashboard.html'), 'utf8');
  assert.equal((dashboard.match(/<script\b/g) || []).length, 1);
  assert.match(dashboard, /<script type="module" src="\/client\/dashboard\/entry\.js"><\/script>/);
  assert.doesNotMatch(dashboard, /src="\/dashboard-[\w-]+\.js/);
});

test('as cascas clássicas foram removidas do fonte', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'public', 'configure-app.js')), false);
  assert.equal(fs.readdirSync(path.join(ROOT, 'src', 'public')).some((f) => /^dashboard-.*\.js$/.test(f)), false);
});

test('emit de browser importa/executa os 30 módulos com DOM montado (inclui o entry)', async () => {
  const { installDashboardDom, dashboardHtml } = await import('./helpers/dashboard-dom.js');
  const dom = installDashboardDom(dashboardHtml());
  try {
    const files = fs.readdirSync(CLIENTS[1].browser).filter((f) => f.endsWith('.js')).sort();
    assert.equal(files.length, 30, 'o emit de browser do dashboard tem 30 módulos');
    for (const file of files) {
      const mod = await import(pathToFileURL(path.join(CLIENTS[1].browser, file)).href);
      assert.equal(typeof mod, 'object', file + ' (browser emit) precisa importar/executar');
    }
    // O entry executou registerHooks()+bind() no import: prova de boot real.
    const entry = await import(pathToFileURL(path.join(CLIENTS[1].browser, 'entry.js')).href);
    assert.equal(typeof entry.registerHooks, 'function');
    const hooks = await import(pathToFileURL(path.join(CLIENTS[1].browser, 'hooks.js')).href);
    assert.ok(hooks.hooks.has('loadStatus'), 'entry do browser registrou o hook loadStatus');
    assert.ok(hooks.hooks.has('renderHealthStrip'));
  } finally {
    dom.cleanup();
  }
});
