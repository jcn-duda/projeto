// Guards de CSS do /painel: tokens compartilhados, piso de fonte de 12px e
// sintaxe compativel com o WebView das TVs (sem nesting, sem color-mix).
//
// Le os FONTES de src/public (servidos crus, sem build), remove comentarios e
// so entao mede: as mencoes a `#hex`/`color-mix`/nesting nos proprios
// comentarios sao documentacao, nao uso. O dashboard-tokens.css e a unica
// fonte de cor (define a paleta); painel.css e painel-limpeza.css sao
// consumidores e nao podem declarar hex nem misturar cores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLIC_DIR = new URL('../../src/public/', import.meta.url);

function readCss(name: string): string {
  return readFileSync(new URL(name, PUBLIC_DIR), 'utf8');
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Remove strings entre aspas (content) para nao casar `{`/`&` dentro delas. */
function stripStrings(css: string): string {
  return css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

const TOKENS = readCss('dashboard-tokens.css');
const PAINEL = readCss('painel.css');
const LIMPEZA = readCss('painel-limpeza.css');

const CONSUMERS: Array<[string, string]> = [
  ['painel.css', PAINEL],
  ['painel-limpeza.css', LIMPEZA],
];

const ALL: Array<[string, string]> = [
  ['dashboard-tokens.css', TOKENS],
  ['painel.css', PAINEL],
  ['painel-limpeza.css', LIMPEZA],
];

/** Primeira regra ANINHADA (abre `{` estando dentro de uma regra comum) ou
 * null. At-rules (`@media`/`@keyframes`) podem conter regras, e o passo de um
 * keyframe pode conter declaracoes: a pilha distingue `@` de seletor comum. */
function firstNestedRule(css: string): string | null {
  const stack: boolean[] = []; // true = prelude e at-rule
  let prelude = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const isAtRule = prelude.trim().startsWith('@');
      if (stack.length > 0 && stack[stack.length - 1] === false) {
        return prelude.trim().slice(0, 60) || '{';
      }
      stack.push(isAtRule);
      prelude = '';
    } else if (ch === '}') {
      stack.pop();
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return null;
}

test('dashboard-tokens.css define a paleta, o reset, o anel de foco e o piso de fonte', () => {
  for (const token of ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--accent', '--accent-ink', '--green', '--amber', '--red', '--red-ink', '--unknown', '--hairline']) {
    assert.ok(TOKENS.includes(token + ':'), 'token ' + token);
  }
  for (const token of ['--field-bg', '--field-border', '--btn-border', '--btn-bg-a', '--btn-bg-b', '--section-bg-a', '--card-border-hover', '--tag-foreign', '--tag-pt']) {
    assert.ok(TOKENS.includes(token + ':'), 'alias ' + token);
  }
  assert.match(TOKENS, /\*\s*\{\s*box-sizing:\s*border-box/);
  assert.ok(TOKENS.includes('--ring:'), 'anel de foco');
  assert.match(TOKENS, /--font-floor:\s*12px/, 'piso de fonte de 12px');
});

test('consumidores do painel nao declaram hex nem color-mix (tokens sao a unica fonte de cor)', () => {
  for (const [name, css] of CONSUMERS) {
    const clean = stripComments(css);
    assert.equal(clean.match(/#[0-9a-fA-F]{3,8}\b/g), null, name + ': hex direto');
    assert.doesNotMatch(clean, /color-mix\s*\(/, name + ': color-mix');
  }
});

test('nenhum CSS do painel usa nesting (regra dentro de regra ou seletor pai &)', () => {
  for (const [name, css] of ALL) {
    const clean = stripStrings(stripComments(css));
    assert.doesNotMatch(clean, /&/, name + ': seletor pai &');
    assert.equal(firstNestedRule(clean), null, name + ': regra aninhada');
  }
});

test('piso de fonte: nenhum font-size literal abaixo de 12px nos consumidores', () => {
  for (const [name, css] of CONSUMERS) {
    const clean = stripComments(css);
    const sizes = clean.match(/font-size:\s*([0-9.]+)px/g) || [];
    assert.ok(sizes.length > 0, name + ': o piso so faz sentido com fontes literais');
    for (const decl of sizes) {
      assert.ok(parseFloat(decl.replace(/[^0-9.]/g, '')) >= 12, name + ': ' + decl);
    }
    assert.match(clean, /font-size:\s*var\(--font-floor\)/, name + ' consome o piso de fonte');
  }
});

test('consumidores usam os aliases de controle dos tokens (sem cor propria)', () => {
  const painel = stripComments(PAINEL);
  for (const token of ['--field-bg', '--btn-border', '--btn-bg-a', '--card-border-hover', '--accent-ink', '--ring']) {
    assert.ok(painel.includes('var(' + token + ')'), 'painel.css var(' + token + ')');
  }
  const limpeza = stripComments(LIMPEZA);
  for (const token of ['--panel-card-radius', '--surface-2', '--red-soft', '--font-floor']) {
    assert.ok(limpeza.includes('var(' + token + ')'), 'painel-limpeza.css var(' + token + ')');
  }
});