import test from 'node:test';
import assert from 'node:assert/strict';
import { coreJson } from '../src/utils/native-json.js';

/**
 * A fronteira napi usa `serde_json`, que RECUSA `\ud800` de surrogate órfão.
 * Sem o `toWellFormed` a chamada lançaria no caminho da resposta; aqui a
 * unidade vira U+FFFD, a perda já documentada da travessia `String`.
 */
test('coreJson troca surrogate órfão por U+FFFD e não emite escape inválido', () => {
  const text = `A${String.fromCharCode(0xd800)}B`;
  const json = coreJson({ title: text });
  assert.ok(json.includes('\uFFFD'), 'órfão vira U+FFFD');
  assert.ok(!json.includes('\\ud800'), 'escape inválido não sai do helper');
  assert.deepEqual(JSON.parse(json), { title: 'A\uFFFDB' });
});

test('coreJson preserva par surrogate válido, números e booleanos', () => {
  const emoji = '😀';
  assert.equal((JSON.parse(coreJson({ s: emoji })) as { s: string }).s, emoji);
  assert.deepEqual(JSON.parse(coreJson({ s: 'ok', n: 1, b: true })), {
    s: 'ok',
    n: 1,
    b: true,
  });
});
