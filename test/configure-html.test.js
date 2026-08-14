const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// configure.html é HTML + JS ES5 servido cru, sem build e sem dependência.
// Este teste lê o arquivo e extrai as partes estáveis com regex (presets,
// collect/render, ramo de URL salva e switches). Sem DOM e sem rede — a
// regressão do front fica protegida pela suíte pura.
const HTML_PATH = path.join(__dirname, '..', 'src', 'public', 'configure.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

// O objeto literal usa chaves sem aspas (ES5); cita as chaves e vira JSON.
function parseObjectLiteral(text) {
  const quoted = text.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  return JSON.parse(quoted);
}

function sliceFunction(name) {
  const match = html.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(match, 'function ' + name + ' não encontrada no configure.html');
  return match[0];
}

test('preset BR recomendado carrega as escolhas comportamentais novas', () => {
  const match = html.match(/var PRESET_BEHAVIORS = (\{[\s\S]*?\n  \});/);
  assert.ok(match, 'PRESET_BEHAVIORS não encontrado');
  const presets = parseObjectLiteral(match[1]);

  const rec = presets.recommended;
  assert.equal(rec.maxUnknown, 6, 'BR recomendado amplia a cota de sem resolução');
  assert.equal(rec.excludeCam, true, 'BR recomendado oculta CAM');
  assert.equal(rec.showUncachedBr, false, 'BR recomendado mantém fora-do-cache escondido');
  assert.equal(rec.autoFetchBr, true, 'BR recomendado liga o autofetch');

  assert.equal(presets.powerBr.showUncachedBr, true, 'Power Movie mostra BR fora do cache');
});

test('render codifica collect() completo e não usa compactConfig', () => {
  const render = sliceFunction('render');
  assert.match(render, /encodeConfig\(collect\(\)\)/, 'render precisa codificar o collect() inteiro');
  assert.equal(html.includes('compactConfig'), false, 'compactConfig não pode existir na página');

  // collect é a fonte da URL: as opções novas precisam estar no conjunto.
  const collect = sliceFunction('collect');
  ['maxUnknown', 'excludeCam', 'showUncachedBr', 'autoFetchBr', 'brReservedSlots'].forEach((key) => {
    assert.match(collect, new RegExp('KEYS\\.' + key + '\\b'), 'collect() precisa incluir ' + key);
  });
});

test('URL existente entra no ramo saved e não aplica preset', () => {
  const match = html.match(/if \(saved !== null\) \{([\s\S]*?)\} else \{([\s\S]*?)\n      \}/);
  assert.ok(match, 'ramo saved/else do estado inicial não encontrado');

  const savedBranch = match[1];
  const elseBranch = match[2];
  assert.match(savedBranch, /apply\(mergeState\(initial, saved\)\)/, 'saved branch aplica o estado da URL');
  assert.match(savedBranch, /setPresetChoice\("custom"\)/, 'saved branch marca como personalizado');
  assert.doesNotMatch(savedBranch, /applyPreset/, 'saved branch não pode aplicar preset sobre a URL');
  assert.match(elseBranch, /apply\(initial\)/, 'configure novo parte dos defaults');
  assert.match(elseBranch, /applyPreset\("recommended"\)/, 'configure novo parte do preset recomendado');
});

test('switches principais têm role=switch e aria-checked', () => {
  const tags = [];
  const re = /<button\b[^>]*\bclass="switch"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) tags.push(m[0]);

  assert.equal(tags.length, 8, 'esperava os 8 switches principais');
  tags.forEach((tag) => {
    assert.match(tag, /\brole="switch"/, 'switch sem role=switch: ' + tag);
    assert.match(tag, /\b(?:aria-checked="true"|aria-checked="false")/, 'switch sem aria-checked: ' + tag);
  });
});

test('texto do toggle BLUDV é específico da fonte direta', () => {
  assert.ok(
    html.includes('Somente dublado na fonte direta BLUDV'),
    'rótulo precisa citar a fonte direta BLUDV, não só "dublado"'
  );
  assert.match(html, /aria-label="Somente dublado na fonte direta BLUDV"/);
});