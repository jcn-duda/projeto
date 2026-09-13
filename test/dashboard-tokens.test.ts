import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { PAGE_ASSETS } from '../src/routes/public.js';
import { resetDashboardEnvironment } from './helpers/dashboard.js';

// ---------------------------------------------------------------------------
// Fase 1 do redesign: tokens, contratos de CSS e acessibilidade. O dashboard.css
// não declara cor literal — consome var(--...) do dashboard-tokens.css. O
// fallback keyboard-nav vive no boot ESM (src/client/dashboard/boot.ts).
// ---------------------------------------------------------------------------

const TOKENS = readFileSync(new URL('../src/public/dashboard-tokens.css', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/public/dashboard.css', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
const BOOT_SRC = readFileSync(new URL('../../src/client/dashboard/boot.ts', import.meta.url), 'utf8');

let server: any;
let savedToken: string;

before(async () => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = '';
  server = await createTestServer(createApp().app);
});

after(async () => {
  await server.close();
  config.jackett.testToken = savedToken;
});

test('dashboard-tokens.css: paleta, raios, aliases, reset e anel de foco', () => {
  for (const token of ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--accent', '--accent-ink', '--green', '--amber', '--red', '--red-ink', '--unknown', '--hairline']) {
    assert.ok(TOKENS.includes(token + ':'), 'token ' + token);
  }
  for (const token of ['--radius-xs', '--radius-sm', '--radius', '--radius-lg', '--radius-pill']) assert.ok(TOKENS.includes(token + ':'), token);
  for (const token of ['--field-bg', '--field-border', '--field-border-hover', '--btn-border', '--btn-bg-a', '--btn-bg-b', '--btn-bg-hover-a', '--btn-bg-hover-b', '--section-bg-a', '--section-bg-b', '--card-border-hover', '--tag-foreign', '--tag-foreign-bg', '--tag-pt', '--tag-pt-bg']) assert.ok(TOKENS.includes(token + ':'), token);
  assert.match(TOKENS, /\*\s*\{\s*box-sizing:\s*border-box/);
  assert.ok(TOKENS.includes('--ring:'));
  assert.ok(TOKENS.includes('--font-floor:'));
});

test('dashboard.css: zero hex e aliases consumidos', () => {
  assert.equal(CSS.match(/#[0-9a-fA-F]{3,8}\b/g), null);
  for (const token of ['--field-bg', '--btn-border', '--section-bg-a', '--card-border-hover', '--tag-foreign', '--tag-pt']) {
    assert.ok(CSS.includes('var(' + token + ')'), 'var(' + token + ')');
  }
});

test('dashboard.html: tokens antes do css; PAGE_ASSETS com os dois; rota serve', async () => {
  assert.ok(HTML.indexOf('/dashboard-tokens.css') < HTML.indexOf('/dashboard.css'));
  assert.ok(PAGE_ASSETS.includes('dashboard-tokens.css'));
  const res = await server.request('GET', '/dashboard-tokens.css');
  assert.equal(res.status, 200);
  assert.match(res.text, /--accent:/);
});

test('piso de fonte: nenhum font-size abaixo de 12px', () => {
  const sizes = CSS.match(/font-size:\s*([0-9.]+)px/g) || [];
  assert.ok(sizes.length > 0);
  for (const decl of sizes) assert.ok(parseFloat(decl.replace(/[^0-9.]/g, '')) >= 12, decl);
});

test('KPI sem corte: sem line-clamp/ellipsis e title no render (módulo real)', async () => {
  assert.doesNotMatch(CSS, /-webkit-line-clamp/);
  const bloco = CSS.slice(CSS.indexOf('.metric .key, .metric .value'), CSS.indexOf('.metric .value.small'));
  assert.doesNotMatch(bloco, /text-overflow/);
  assert.match(bloco, /text-wrap:\s*balance/);
  assert.match(bloco, /overflow-wrap:\s*anywhere/);
  const { dom, mods } = await resetDashboardEnvironment();
  const box = dom.element('metricBox');
  mods.render.metric(box, 'chave', 'valor');
  assert.ok(box.children[0].children[0].title, 'key recebe title');
  assert.ok(box.children[0].children[1].title, 'value recebe title');
  mods.render.card(dom.element('cardBox'), { id: 'x' }, {});
  const details = dom.byId['cardBox'].children[0];
  assert.equal(details.children[0].className, 'card-head');
  assert.equal(details.children[0].tagName, 'summary');
  dom.cleanup();
});

test('KPI alinhado: key/value em bloco próprio (nunca inline)', async () => {
  // Contrato de alinhamento da aba Geral: render.ts cria key e value como
  // <span> irmãos SEM espaço entre eles. Sem display: block o navegador os
  // trata como uma única run inline e `overflow-wrap: anywhere` quebra no
  // meio do texto colado ("rss412.7 MB"), deixando cartões da mesma fileira
  // com o valor em alturas diferentes. O teste trava o contrato nas duas
  // pontas: as tags que o render produz e a declaração que as empilha.
  const regra = CSS.match(/\.metric \.key,\s*\.metric \.value\s*\{([^}]*)\}/);
  assert.ok(regra, 'regra compartilhada de .metric .key/.value');
  assert.match(regra![1], /display:\s*block/);
  const { dom, mods } = await resetDashboardEnvironment();
  const box = dom.element('metricBox');
  mods.render.metric(box, 'rss', '412.7 MB');
  const item = box.children[0];
  const key = item.children[0];
  const value = item.children[1];
  assert.equal(key.tagName, 'span', 'key é span inline por padrão');
  assert.equal(value.tagName, 'span', 'value é span inline por padrão');
  assert.equal(key.className, 'key');
  assert.equal(value.className, 'value');
  dom.cleanup();
});

test('contraste/foco: :focus-visible e fallback keyboard-nav no boot ESM', () => {
  assert.match(CSS, /button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  assert.match(CSS, /html\.keyboard-nav button:focus[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  for (const line of CSS.split('\n')) {
    if (/button:focus(?!-visible)/.test(line)) assert.match(line, /html\.keyboard-nav/, line.trim());
  }
  assert.match(BOOT_SRC, /function bindKeyboardFocus\(\)/);
  assert.match(BOOT_SRC, /bindKeyboardFocus\(\)/);
  assert.match(BOOT_SRC, /addEventListener\('keydown',\s*enableKeyboardNav\)/);
  assert.match(BOOT_SRC, /addEventListener\('pointerdown',\s*disableKeyboardNav\)/);
  assert.match(BOOT_SRC, /addEventListener\('mousedown',\s*disableKeyboardNav\)/);
});

test('mobile (max-width: 650px): snap/fade, alvos 44px e checkbox coberto', () => {
  const m = CSS.match(/@media \(max-width: 650px\)\s*\{[\s\S]*?\n\}\n@media/);
  assert.ok(m);
  const bloco = m![0];
  assert.match(bloco, /scroll-snap-type:\s*x proximity/);
  assert.match(bloco, /scroll-snap-align:\s*start/);
  assert.match(bloco, /mask-image:\s*linear-gradient/);
  assert.match(bloco, /\.tab-btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(bloco, /button,[^{]*\{[^}]*min-height:\s*44px/);
  assert.match(bloco, /input\[type="checkbox"\][^{]*\{[^}]*width:\s*44px[^}]*height:\s*44px/);
  assert.match(bloco, /\.form-item input\[type="checkbox"\]/);
  for (const id of ['rememberToken', 'cacheInstallation', 'catalog_include_known']) {
    assert.match(HTML, new RegExp('id="' + id + '"\\s+type="checkbox"'), id);
  }
});

test('bloqueios visuais: card-head 44px, #viewGeral.hidden e sticky preservada', () => {
  const m = CSS.match(/@media \(max-width: 650px\)\s*\{[\s\S]*?\n\}\n@media/);
  const bloco = m ? m[0] : '';
  assert.match(bloco, /summary\.card-head\s*\{[^}]*min-height:\s*44px/);
  const largo = CSS.slice(CSS.indexOf('@media (min-width: 1600px)'), CSS.indexOf('/* ------- Responsivo'));
  assert.ok(largo.includes('grid-template-columns: repeat(12'));
  assert.match(largo, /#viewGeral\.hidden\s*\{[^}]*display:\s*none/);
  assert.match(CSS, /\.health-wrap\s*\{[^}]*position:\s*sticky/);
  assert.doesNotMatch(bloco, /\.health-wrap[^{]*\{[^}]*position:\s*static/);
});

test('identidade preservada: âncoras do dashboard.css continuam', () => {
  for (const anchor of ['.sparkline-svg', '.sparkline-path', '.connection.syncing', '.last-updated.stale', '@media (max-width: 650px)']) {
    assert.ok(CSS.includes(anchor), anchor);
  }
});
