import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE_ASSETS } from '../src/routes/public.js';

// Fase 0 do redesign do Dashboard — contrato da extração:
//   dashboard-render.js  ← helpers de DESENHO (metric/card/formatos/sparkline
//                          e a pintura _origem), antes no dashboard-core.js;
//   dashboard-probes.js  ← sondas pontuais (testes de indexer/resolver),
//                          antes no dashboard-status.js;
//   dashboard-nav.js     ← switchTab/handleHash por tabela, antes em
//                          dashboard-panels.js.
// Este arquivo fixa QUEM define o quê (regex) e a ordem de scripts no HTML;
// o comportamento em runtime está em dashboard-panels-extract.test.ts,
// dashboard-panel-runtime.test.ts e dashboard-nav.test.ts.

const CORE = new URL('../src/public/dashboard-core.js', import.meta.url);
const RENDER = new URL('../src/public/dashboard-render.js', import.meta.url);
const PROBES = new URL('../src/public/dashboard-probes.js', import.meta.url);
const NAV = new URL('../src/public/dashboard-nav.js', import.meta.url);
const PANELS = new URL('../src/public/dashboard-panels.js', import.meta.url);
const STATUS = new URL('../src/public/dashboard-status.js', import.meta.url);
const MAGNETS = new URL('../src/public/dashboard-magnets.js', import.meta.url);
const HTML = new URL('../src/public/dashboard.html', import.meta.url);

const ES6 = /\b(?:const|let)\b|=>|\?\.|\?\?/;

test('dashboard-render.js define os helpers de desenho; core não os define mais', () => {
  const render = readFileSync(RENDER, 'utf8');
  const core = readFileSync(CORE, 'utf8');
  for (const fn of [
    'formatBytes', 'formatDuration', 'formatDate', 'displayValue',
    'stateName', 'stateLabel', 'element', 'empty',
    'applyOrigem', 'metricOrigem', 'metric', 'renderMetrics', 'asList',
    'card', 'drawSparkline',
  ]) {
    assert.match(render, new RegExp('function ' + fn + '\\('), 'render define ' + fn);
    assert.doesNotMatch(core, new RegExp('function ' + fn + '\\('), 'core não define mais ' + fn);
  }
  // O core mantém o que módulos não-visuais consomem (estado, HTTP, helpers
  // puros de _origem e valueText).
  for (const fn of ['isObject', 'first', 'valueText', 'origemOf', 'origemValue', 'origemTitle', 'requestJson', 'pushSeries']) {
    assert.match(core, new RegExp('function ' + fn + '\\('), 'core mantém ' + fn);
  }
  assert.match(core, /function \$\(id\)/, 'core mantém o seletor $');
  assert.match(core, /AMOSTRA_CEDO_S\s*=\s*\d+/);
});

test('dashboard-probes.js define as sondas; status não as define mais', () => {
  const probes = readFileSync(PROBES, 'utf8');
  const status = readFileSync(STATUS, 'utf8');
  for (const fn of ['runIndexerTest', 'runResolverTest', 'testResultText', 'resolverTestResultText']) {
    assert.match(probes, new RegExp('function ' + fn + '\\('), 'probes define ' + fn);
    assert.doesNotMatch(status, new RegExp('function ' + fn + '\\('), 'status não define mais ' + fn);
  }
  // O ciclo de status/polling/ações permanece no status.
  for (const fn of ['renderStatus', 'loadStatus', 'scheduleRefresh', 'runAction', 'collectStatusIssues']) {
    assert.match(status, new RegExp('function ' + fn + '\\('), 'status mantém ' + fn);
  }
});

test('dashboard-nav.js define as abas por tabela; panels não as define mais', () => {
  const nav = readFileSync(NAV, 'utf8');
  const panels = readFileSync(PANELS, 'utf8');
  assert.match(nav, /function switchTab\(/);
  assert.match(nav, /function handleHash\(/);
  assert.match(nav, /TAB_ITEMS/, 'switchTab é dirigido por tabela');
  assert.match(nav, /tabGeral/);
  assert.match(nav, /tabAutofetch/);
  assert.match(nav, /tabColhedor/);
  assert.match(nav, /tabTrace/);
  assert.doesNotMatch(panels, /function switchTab\(/);
  assert.doesNotMatch(panels, /function handleHash\(/);
});

test('renderMagnetDb mora em dashboard-magnets.js e pinta #magnetMetrics', () => {
  const magnets = readFileSync(MAGNETS, 'utf8');
  const panels = readFileSync(PANELS, 'utf8');
  const html = readFileSync(HTML, 'utf8');
  assert.match(magnets, /function renderMagnetDb\(data, counters, uptimeS\)/);
  assert.match(magnets, /\$\("magnetMetrics"\)/);
  assert.doesNotMatch(magnets, /\$\("cacheMetrics"\)/, 'o banco não divide mais o grid do cache');
  assert.doesNotMatch(panels, /function renderMagnetDb\(/);
  // Wiring no HTML: container próprio da seção do banco + módulos na ordem.
  assert.match(html, /id="magnetMetrics"/);
  assert.match(html, /src="\/dashboard-magnets\.js"/);
  assert.doesNotMatch(html, /function (?:renderMagnetDb|renderGeneral|bind)\(/);
});

// fe4cd8c (MagnetDB durável): os agregados do painel são persistentes por
// estado/adapter, com os grupos L1 × agregados × contadores do processo e os
// textos explicativos — contrato que era regexado em dashboard.test.ts e
// acompanhou a mudança do painel para dashboard-magnets.js.
test('painel do MagnetDB mantém os grupos e as marcas de procedência', () => {
  const magnets = readFileSync(MAGNETS, 'utf8');
  const panels = readFileSync(PANELS, 'utf8');
  assert.match(panels, /function renderGeneral\(/);
  assert.match(panels, /source\.search/);
  assert.doesNotMatch(panels, /function (?:renderMagnetDb|switchTab)\(/);
  assert.match(magnets, /debrid\.check\.cached/);
  assert.match(magnets, /source\.byAdapter/);
  assert.match(magnets, /source\.l1Entries/);
  assert.match(magnets, /source\.evictedQuota/);
  for (const marca of [
    'L1 mag \\(ocupação\\)',
    'registros classificados \\(≠ L1\\)',
    'bad \\(play sem vídeo\\)',
    'descartados dead \\(autofetch ≠ bad\\)',
    'Registros persistentes no banco',
    'Agregados persistentes por estado e serviço',
    'Gravações e descartes desde o restart',
    'gravações alive \\(inclui renovações\\)',
    'Os agregados sobrevivem ao restart pelo mag_meta',
    'expirados ou órfãos',
    'dbCounters\\.aliveSet',
  ]) {
    assert.match(magnets, new RegExp(marca), 'painel MagnetDB sem "' + marca + '"');
  }
});

test('HTML referencia os três módulos novos na ordem de dependência', () => {
  const html = readFileSync(HTML, 'utf8');
  // lastIndexOf: o cabeçalho do HTML cita "dashboard-status.js" em prosa;
  // o contrato vale para as tags <script>.
  const idx = (name: string) => html.lastIndexOf(name);
  assert.ok(idx('dashboard-core.js') > 0);
  assert.ok(
    idx('dashboard-core.js') < idx('dashboard-render.js') &&
      idx('dashboard-render.js') < idx('dashboard-panels.js') &&
      idx('dashboard-panels.js') < idx('dashboard-status.js') &&
      idx('dashboard-status.js') < idx('dashboard-probes.js') &&
      idx('dashboard-magnets.js') < idx('dashboard-nav.js') &&
      idx('dashboard-nav.js') < idx('dashboard-boot.js'),
    'ordem: core → render → panels → status → probes → … → magnets → nav → boot',
  );
});

test('PAGE_ASSETS inclui os três módulos novos (public.ts)', () => {
  for (const asset of ['dashboard-render.js', 'dashboard-probes.js', 'dashboard-nav.js']) {
    assert.ok(PAGE_ASSETS.includes(asset), asset + ' na allowlist fechada');
  }
});

test('módulos novos continuam ES5 puro e nada roda no load', () => {
  for (const url of [RENDER, PROBES, NAV]) {
    const js = readFileSync(url, 'utf8');
    assert.doesNotMatch(js, ES6, url.pathname + ' segue ES5 (WebView de TV)');
    assert.doesNotMatch(js, /innerHTML/, 'dados só por textContent/appendChild');
    // Módulos de declaração: nenhum wiring no load (o boot é o único que roda).
    assert.doesNotMatch(js, /\bbind\s*\(\s*\)\s*;?\s*$/, url.pathname + ' não executa no load');
    assert.doesNotMatch(js, /addEventListener\("load"/, url.pathname + ' sem gatilho de load');
  }
});
