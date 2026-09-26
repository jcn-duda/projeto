import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Infraestrutura C1+C2+C3: os clientes de /configure e /painel são ESM
// nativo compilado para o browser (dist/src/public/client) e, num segundo emit,
// para o Node (dist/src/client) só para os testes. Sem AMD, sem loader, sem
// bundle e sem suporte obrigatório a WebView sem ESM.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const CLIENTS = [
  { name: 'configure', browser: path.join(ROOT, 'dist', 'src', 'public', 'client', 'configure'), node: path.join(ROOT, 'dist', 'src', 'client', 'configure') },
  { name: 'painel', browser: path.join(ROOT, 'dist', 'src', 'public', 'client', 'painel'), node: path.join(ROOT, 'dist', 'src', 'client', 'painel') },
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
    const files = fs.readdirSync(client.browser, { recursive: true } as any).filter((f: any) => String(f).endsWith('.js'));
    assert.ok(files.length >= 2, client.name + ' precisa de módulos no dist');
    for (const file of files as string[]) {
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
  const painelEntry = fs.readFileSync(path.join(CLIENTS[1].browser, 'entry.js'), 'utf8');
  assert.match(painelEntry, /from\s*'\.\/app\.js'/);
  assert.match(painelEntry, /export function bootstrap/);
  assert.match(painelEntry, /\bbootstrap\(\);/);
});

test('segundo emit NodeNext existe em dist/src/client para os dois clientes', () => {
  for (const client of CLIENTS) {
    const expected = client.name === 'configure'
      ? ['entry.js', 'init.js', 'state.js', 'view.js', 'indexers.js']
      : ['entry.js', 'app.js', 'store.js', 'core.js', 'fmt.js', 'api.js', 'view-limpeza.js'];
    for (const file of expected) assert.ok(fs.existsSync(path.join(client.node, file)), 'faltou ' + client.name + '/' + file);
  }
});

test('módulos não têm efeito de DOM no import (entry é quem chama init/bootstrap)', async () => {
  const configure = ['state.js', 'dom.js', 'keys.js', 'limits.js', 'indexers.js', 'view.js', 'seal.js', 'init.js'];
  for (const file of configure) {
    const mod = await import(pathToFileURL(path.join(CLIENTS[0].node, file)).href);
    assert.equal(typeof mod, 'object', file + ' precisa importar');
  }
  // Painel: importa TODO o grafo, exceto o entry (que chama bootstrap() no topo
  // quando há DOM; sem DOM o guard `typeof document` o mantém inerte).
  const painel = fs.readdirSync(CLIENTS[1].node, { recursive: true } as any)
    .filter((f: any) => String(f).endsWith('.js') && !String(f).endsWith('entry.js'));
  for (const file of painel as string[]) {
    const mod = await import(pathToFileURL(path.join(CLIENTS[1].node, file)).href);
    assert.equal(typeof mod, 'object', file + ' precisa importar sem DOM');
  }
});

test('allowlist fechada do servidor cobre todo o emit de browser (configure e painel)', async () => {
  const { CLIENT_ASSETS } = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'routes', 'public.js')).href);
  for (const client of CLIENTS) {
    const emitted = fs.readdirSync(client.browser, { recursive: true } as any)
      .filter((f: any) => String(f).endsWith('.js'))
      .map((f: any) => 'client/' + client.name + '/' + String(f).replace(/\\/g, '/'));
    for (const rel of emitted) assert.ok(CLIENT_ASSETS.includes(rel), 'emit sem rota na allowlist: ' + rel);
  }
  for (const rel of CLIENT_ASSETS) {
    assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'src', 'public', rel)), 'allowlist sem emit: ' + rel);
  }
});

test('configure.html e painel.html carregam UM module no entry', () => {
  const configure = fs.readFileSync(path.join(ROOT, 'dist', 'src', 'public', 'configure.html'), 'utf8');
  assert.match(configure, /<script type="module" src="\/client\/configure\/entry\.js"><\/script>/);
  assert.doesNotMatch(configure, /<script>\s*"use strict"/);
  const painel = fs.readFileSync(path.join(ROOT, 'dist', 'src', 'public', 'painel.html'), 'utf8');
  assert.equal((painel.match(/<script\b/g) || []).length, 1);
  assert.match(painel, /<script type="module" src="\/client\/painel\/entry\.js"><\/script>/);
  assert.doesNotMatch(painel, /src="\/painel-[\w-]+\.js/);
});

test('as cascas clássicas e o cliente legado de /dashboard foram removidos do fonte', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'public', 'configure-app.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'public', 'dashboard.html')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'public', 'dashboard.css')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'src', 'client', 'dashboard')), false);
  assert.equal(fs.readdirSync(path.join(ROOT, 'src', 'public')).some((f) => /^dashboard-.*\.js$/.test(f)), false);
});

test('emit de browser do painel importa/executa sem DOM e o entry sobrevive sem #app', async () => {
  // Os módulos do painel não tocam o DOM no import; o entry chama bootstrap()
  // atrás do guard `typeof document !== 'undefined'` e sai cedo sem `#app`.
  const files = fs.readdirSync(CLIENTS[1].browser, { recursive: true } as any)
    .filter((f: any) => String(f).endsWith('.js') && String(f) !== 'entry.js');
  assert.ok(files.length >= 20, 'o emit de browser do painel precisa dos módulos reais');
  for (const file of files as string[]) {
    const mod = await import(pathToFileURL(path.join(CLIENTS[1].browser, file)).href);
    assert.equal(typeof mod, 'object', file + ' (browser emit) precisa importar/executar');
  }
  const previousDocument = (globalThis as any).document;
  (globalThis as any).document = { getElementById: () => null };
  try {
    const entry = await import(pathToFileURL(path.join(CLIENTS[1].browser, 'entry.js')).href);
    assert.equal(typeof entry.bootstrap, 'function');
  } finally {
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
});
