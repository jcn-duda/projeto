import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import { createTestServer } from './e2e/e2e-harness.js';
import { PAGE_ASSETS } from '../src/routes/public.js';

// ---------------------------------------------------------------------------
// Fase 1 do redesign do dashboard (1.1–1.4): tokens, contratos de CSS e
// acessibilidade. O dashboard.css nao declara COR nenhuma por conta própria —
// consome var(--...) do dashboard-tokens.css — e a identidade visual fica nos
// valores dos tokens (os mesmos de antes da extracao).
// ---------------------------------------------------------------------------

const TOKENS = readFileSync(new URL('../src/public/dashboard-tokens.css', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/public/dashboard.css', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../src/public/dashboard.html', import.meta.url), 'utf8');
const RENDER = readFileSync(new URL('../src/public/dashboard-render.js', import.meta.url), 'utf8');

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

test('1.1 dashboard-tokens.css: paleta base, escala de raios, aliases e reset', () => {
  // Paleta base compartilhada com configure.css.
  for (const token of ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--accent', '--accent-ink', '--green', '--amber', '--red', '--red-ink', '--unknown', '--hairline']) {
    assert.ok(TOKENS.includes(token + ':'), `token ${token} definido no tokens.css`);
  }
  // Escala de raios (menor -> maior + pill).
  for (const token of ['--radius-xs', '--radius-sm', '--radius', '--radius-lg', '--radius-pill']) {
    assert.ok(TOKENS.includes(token + ':'), `escala de raio ${token} definida`);
  }
  // Aliases semanticos que substituem os literais do dashboard.css.
  for (const token of ['--field-bg', '--field-border', '--field-border-hover', '--btn-border', '--btn-bg-a', '--btn-bg-b', '--btn-bg-hover-a', '--btn-bg-hover-b', '--section-bg-a', '--section-bg-b', '--card-border-hover', '--tag-foreign', '--tag-foreign-bg', '--tag-pt', '--tag-pt-bg']) {
    assert.ok(TOKENS.includes(token + ':'), `alias ${token} definido`);
  }
  // Reset + anel de foco + piso de fonte.
  assert.match(TOKENS, /\*\s*\{\s*box-sizing:\s*border-box/);
  assert.ok(TOKENS.includes('--ring:'), 'anel de foco --ring definido');
  assert.ok(TOKENS.includes('--font-floor:'), 'piso de fonte --font-floor definido');
});

test('1.1 dashboard.css: ZERO cor literal hex — tudo vem de var(--...)', () => {
  const hex = CSS.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(hex, null, `dashboard.css nao pode declarar hex: ${JSON.stringify(hex)}`);
  // Os aliases que sustentam a identidade sao realmente consumidos.
  for (const token of ['--field-bg', '--btn-border', '--section-bg-a', '--card-border-hover', '--tag-foreign', '--tag-pt']) {
    assert.ok(CSS.includes('var(' + token + ')'), `var(${token}) consumido no dashboard.css`);
  }
});

test('1.3 dashboard.html: tokens carregam ANTES do dashboard.css', () => {
  const tokensIdx = HTML.indexOf('/dashboard-tokens.css');
  const cssIdx = HTML.indexOf('/dashboard.css');
  assert.ok(tokensIdx !== -1, 'link para /dashboard-tokens.css presente');
  assert.ok(cssIdx !== -1, 'link para /dashboard.css presente');
  assert.ok(tokensIdx < cssIdx, 'tokens antes do dashboard.css');
});

test('1.3 PAGE_ASSETS inclui dashboard-tokens.css e a rota o serve', async () => {
  assert.ok(PAGE_ASSETS.includes('dashboard-tokens.css'), 'allowlist fechada inclui o novo CSS');
  const res = await server.request('GET', '/dashboard-tokens.css');
  assert.equal(res.status, 200);
  assert.match(res.text, /--accent:/);
});

test('Piso de fonte: nenhum font-size abaixo de 12px no dashboard.css', () => {
  const sizes = CSS.match(/font-size:\s*([0-9.]+)px/g) || [];
  assert.ok(sizes.length > 0, 'dashboard.css declara font-size em px');
  for (const decl of sizes) {
    const px = parseFloat(decl.replace(/[^0-9.]/g, ''));
    assert.ok(px >= 12, `font-size abaixo do piso: "${decl}"`);
  }
});

test('KPI sem corte: nada de line-clamp nem elipsis; quebra balanceada e title no render', () => {
  // O antigo clamp de 2 linhas truncava com "…" — não pode voltar nas chaves
  // nem nos valores (o restante da página pode cortar; os KPIs não).
  assert.doesNotMatch(CSS, /-webkit-line-clamp/, 'KPI nao trunca com line-clamp');
  const bloco = CSS.slice(CSS.indexOf('.metric .key, .metric .value'), CSS.indexOf('.metric .value.small'));
  assert.doesNotMatch(bloco, /text-overflow/, 'KPI nao corta com elipsis');
  // Duas (ou mais) linhas balanceadas ONDE não corta texto: text-wrap: balance
  // é progressão pura — equilibra sem truncar.
  assert.match(bloco, /text-wrap:\s*balance/);
  assert.match(bloco, /overflow-wrap:\s*anywhere/);
  // O texto integral viaja no title (dashboard-render.js, metric/metricOrigem).
  assert.match(RENDER, /keyEl\.title\s*=/, 'key recebe title');
  assert.match(RENDER, /valueEl\.title\s*=|content\.title\s*=/, 'value recebe title');
});

test('Contraste/foco: :focus-visible + fallback keyboard-nav para WebView antigo', () => {
  assert.match(CSS, /button:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  // Fallback compatível: WebView sem :focus-visible recebe o anel via classe
  // keyboard-nav (ligada por Tab, desligada por ponteiro no dashboard-boot.js).
  assert.match(CSS, /html\.keyboard-nav button:focus[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  // Nenhuma ocorrência de `button:focus` cru fora do fallback keyboard-nav:
  // clique de mouse não deixa contorno permanente.
  for (const line of CSS.split('\n')) {
    if (/button:focus(?!-visible)/.test(line)) {
      assert.match(line, /html\.keyboard-nav/, 'button:focus so no fallback keyboard-nav: ' + line.trim());
    }
  }
  // O boot instala o fallback (ES5, Tab liga / ponteiro desliga).
  const BOOT = readFileSync(new URL('../src/public/dashboard-boot.js', import.meta.url), 'utf8');
  assert.match(BOOT, /function bindKeyboardFocus\(\)/, 'fallback definido');
  assert.match(BOOT, /function bind\(\)\s*\{\s*bindKeyboardFocus\(\)/, 'fallback ligado no boot');
  assert.match(BOOT, /addEventListener\("keydown",\s*enableKeyboardNav\)/, 'Tab liga keyboard-nav');
  assert.match(BOOT, /addEventListener\("pointerdown",\s*disableKeyboardNav\)/, 'ponteiro desliga keyboard-nav');
  assert.match(BOOT, /addEventListener\("mousedown",\s*disableKeyboardNav\)/, 'fallback de ponteiro antigo');
});

test('1.4 Mobile (max-width: 650px): abas com snap/fade e alvos de 44px (inclusive checkbox)', () => {
  const m = CSS.match(/@media \(max-width: 650px\)\s*\{[\s\S]*?\n\}\n@media/);
  assert.ok(m, 'bloco @media 650px presente e fechado antes do reduced-motion');
  const bloco = m ? m[0] : '';
  assert.match(bloco, /scroll-snap-type:\s*x proximity/, 'trilho de abas com scroll-snap');
  assert.match(bloco, /scroll-snap-align:\s*start/, 'aba alinhada no snap');
  assert.match(bloco, /mask-image:\s*linear-gradient/, 'fade nas bordas do trilho');
  assert.match(bloco, /\.tab-btn\s*\{[^}]*min-height:\s*44px/, 'aba com alvo de 44px');
  assert.match(bloco, /button,[^{]*\{[^}]*min-height:\s*44px/, 'controles com alvo de 44px');
  // B1: o checkbox entra no piso de toque MEDIDO 44x44 — cobre #rememberToken,
  // #cacheInstallation, #catalog_include_known, os formulários do Chupim/
  // Colhedor e as linhas do catálogo. Os seletores compostos precisam estar
  // na lista: só o seletor simples perde para as regras de 18px de cima.
  assert.match(bloco, /input\[type="checkbox"\][^{]*\{[^}]*width:\s*44px[^}]*height:\s*44px/, 'B1: todo checkbox 44x44 no mobile');
  assert.match(bloco, /\.form-item input\[type="checkbox"\]/, 'B1: checkbox dos formulários coberto');
  for (const id of ['rememberToken', 'cacheInstallation', 'catalog_include_known']) {
    assert.match(HTML, new RegExp('id="' + id + '"\\s+type="checkbox"'), 'checkbox do B1 presente no HTML: ' + id);
  }
});

test('Bloqueios da validação visual: card-head 44px, .hidden vence o grid largo e faixa sticky preservada', () => {
  const m = CSS.match(/@media \(max-width: 650px\)\s*\{[\s\S]*?\n\}\n@media/);
  const bloco = m ? m[0] : '';
  // B2: o summary.card-head gerado pelo render (details.card) também é alvo
  // de toque no mobile — o cabeçalho inteiro abre o <details>.
  assert.match(bloco, /summary\.card-head\s*\{[^}]*min-height:\s*44px/, 'B2: summary.card-head com piso de 44px no mobile');
  assert.match(RENDER, /element\("summary",\s*"card-head"\)/, 'B2: summary.card-head é markup gerado');
  // B3: em >=1600 a regra #viewGeral (especificidade de ID) venceria
  // .tab-view.hidden — o par #viewGeral.hidden mantém a aba oculta fechada.
  const largo = CSS.slice(CSS.indexOf('@media (min-width: 1600px)'), CSS.indexOf('/* ------- Responsivo'));
  assert.ok(largo.includes('grid-template-columns: repeat(12'), 'grade de 12 colunas no bloco largo');
  assert.match(largo, /#viewGeral\.hidden\s*\{[^}]*display:\s*none/, 'B3: #viewGeral.hidden segue display:none no >=1600');
  // Fase 2.1: .health-wrap continua position:sticky também no mobile — o
  // override static do media 650px não pode voltar.
  assert.match(CSS, /\.health-wrap\s*\{[^}]*position:\s*sticky/, 'Fase 2.1: sticky base preservada');
  assert.doesNotMatch(bloco, /\.health-wrap[^{]*\{[^}]*position:\s*static/, 'Fase 2.1: sem override static no mobile');
});

test('Identidade preservada: contratos existentes do dashboard.css continuam', () => {
  // Contratos regexados por test/dashboard-modernization.test.ts e o painel.
  for (const anchor of ['.sparkline-svg', '.sparkline-path', '.connection.syncing', '.last-updated.stale', '@media (max-width: 650px)']) {
    assert.ok(CSS.includes(anchor), `âncora ${anchor} preservada`);
  }
});
