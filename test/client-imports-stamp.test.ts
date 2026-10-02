import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stampRelativeImports, countRelativeImports } from '../src/routes/client-imports.js';

// O entry já carregava `?v=<fingerprint>`, mas os imports internos dele não —
// a URL de um módulo filho era a mesma entre deploys. O addon serve o filho com
// `no-cache`, só que o header da origem não é a última palavra: a Cloudflare
// reescrevia para `max-age=14400` e o painel continuava rodando JS velho ao
// lado de dados novos. Carimbar a query fecha isso sem depender de CDN.
const V = 'abc1234567';

describe('client-imports: carimbo de versão nos imports relativos', () => {
  test('carimba as formas que o browser resolve', () => {
    assert.equal(
      stampRelativeImports("import { html } from './vendor/preact.js';", V),
      "import { html } from './vendor/preact.js?v=abc1234567';",
    );
    assert.equal(
      stampRelativeImports("import { a } from '../action.js';", V),
      "import { a } from '../action.js?v=abc1234567';",
    );
    assert.equal(
      stampRelativeImports("export { x } from './core.js';", V),
      "export { x } from './core.js?v=abc1234567';",
    );
    assert.equal(
      stampRelativeImports("const m = await import('./lazy.js');", V),
      "const m = await import('./lazy.js?v=abc1234567');",
    );
    assert.equal(
      stampRelativeImports("import './efeito.js';", V),
      "import './efeito.js?v=abc1234567';",
    );
    assert.equal(
      stampRelativeImports('import { a } from "./aspas-duplas.js";', V),
      'import { a } from "./aspas-duplas.js?v=abc1234567";',
    );
  });

  test('não toca no que não é nosso para versionar', () => {
    // Bare specifier: uma query o quebraria, e esses bundles não têm nenhum.
    const bare = "import fs from 'node:fs';";
    assert.equal(stampRelativeImports(bare, V), bare);
    // URL absoluta aponta para fora — versionar não é nossa decisão.
    const absoluto = "import x from 'https://cdn.exemplo/x.js';";
    assert.equal(stampRelativeImports(absoluto, V), absoluto);
    // Caminho absoluto de raiz também não é relativo.
    const raiz = "import y from '/client/painel/app.js';";
    assert.equal(stampRelativeImports(raiz, V), raiz);
  });

  test('specifier que já tem query fica intacto (nunca ?v=a?v=b)', () => {
    const jaTem = "import { a } from './ja.js?v=antigo';";
    assert.equal(stampRelativeImports(jaTem, V), jaTem);
    // Carimbar duas vezes é idempotente: o segundo passe não acha mais nada.
    const uma = stampRelativeImports("import { a } from './x.js';", V);
    assert.equal(stampRelativeImports(uma, V), uma);
  });

  test('versão vazia devolve o código intacto', () => {
    const code = "import { a } from './x.js';";
    assert.equal(stampRelativeImports(code, ''), code);
    assert.equal(stampRelativeImports(code, undefined as any), code);
  });

  test('entrada vazia/nula não quebra', () => {
    assert.equal(stampRelativeImports('', V), '');
    assert.equal(stampRelativeImports(null as any, V), '');
    assert.equal(countRelativeImports(null as any), 0);
  });

  test('carimba TODOS os imports do módulo, não só o primeiro', () => {
    const code = [
      "import { html } from './vendor/preact.js';",
      "import { Card } from './kit.js';",
      "import { formatBytes } from './fmt.js';",
    ].join('\n');
    assert.equal(countRelativeImports(code), 3);
    const out = stampRelativeImports(code, V);
    assert.equal((out.match(/\?v=abc1234567/g) || []).length, 3);
    assert.equal(countRelativeImports(out), 0, 'nenhum specifier pode sobrar sem query');
  });

  test('não altera o corpo do módulo fora dos imports', () => {
    // String comum que PARECE um caminho não pode virar import carimbado.
    const code = "const caminho = './saude-model.js';\nconsole.log('from ./x.js');";
    assert.equal(stampRelativeImports(code, V), code);
  });
});
