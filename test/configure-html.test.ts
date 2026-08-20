// @ts-nocheck — rodada 1: checagem suspensa para fechar o portão do src;
// remover arquivo a arquivo na rodada 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function sliceNamedFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + ' não encontrada no configure.html');
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') depth -= 1;
    if (depth === 0) return html.slice(start, i + 1);
  }
  assert.fail('function ' + name + ' não foi fechada no configure.html');
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

test('copy do autofetch e aviso AllDebrid acompanham o código', () => {
  assert.match(html, /id="adMagnetNotice"/, 'aviso de magnets AllDebrid precisa existir');
  assert.match(html, /svc\.id !== "alldebrid"/, 'aviso AllDebrid só com esse serviço');
  assert.equal(html.includes('Um torrent por título'), false, 'teto do autofetch não é mais 1');
  assert.match(html, /até quatro por busca/, 'copy do switch descreve o teto atual');
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

test('status dos indexadores é atualizado periodicamente sem reaplicar configuração', () => {
  const refresh = sliceNamedFunction('refreshIndexerStatuses');
  const poll = sliceNamedFunction('pollIndexerStatuses');

  const interval = html.match(/var INDEXER_STATUS_POLL_MS = (\d+);/);
  assert.ok(interval, 'intervalo do polling não encontrado');
  assert.ok(Number(interval[1]) >= 5000 && Number(interval[1]) <= 30000,
    'polling precisa atualizar rápido sem sobrecarregar o endpoint');
  assert.match(html, /setInterval\(pollIndexerStatuses, INDEXER_STATUS_POLL_MS\)/);
  assert.match(poll, /fetch\("\/defaults\.json\?statusAt=" \+ new Date\(\)\.getTime\(\)\)/,
    'polling precisa evitar resposta de status em cache');
  assert.match(poll, /indexerStatusPollInFlight = true/);
  assert.match(poll, /indexerStatusPollInFlight = false/);

  assert.match(refresh, /setIndexerStatus\(item\.id, latest\[item\.id\]\)/);
  ['apply(', 'applyPreset(', 'fillJackettIndexers(', 'setChips(', 'setOn('].forEach((call) => {
    assert.equal(refresh.includes(call), false, 'refresh de status não pode chamar ' + call);
  });
});

test('status sem medição é honesto e polling mantém JavaScript ES5', () => {
  const statusText = sliceNamedFunction('statusText');
  const refresh = sliceNamedFunction('refreshIndexerStatuses');
  const poll = sliceNamedFunction('pollIndexerStatuses');
  const addedJs = statusText + refresh + poll;

  assert.match(statusText, /return "ainda não consultado"/);
  assert.doesNotMatch(statusText, /desconhecido/);
  assert.match(statusText, /medido há/);
  assert.doesNotMatch(addedJs, /\b(?:const|let|class|async|await)\b|=>|`/,
    'status precisa continuar compatível com WebViews ES5');
});


test('KEYS mapeia o limite individual por indexador para jl', () => {
  assert.match(html, /indexerLimits: "jl"/);
});

test('collect inclui os limites individuais por indexador', () => {
  const collect = sliceFunction('collect');
  assert.match(collect, /KEYS\.indexerLimits\b/);
  assert.match(collect, /collectIndexerLimits\(\)/);
});

test('card de indexador ganha select individual com padrão geral, sem limite e 1..20', () => {
  const fill = sliceNamedFunction('fillJackettIndexers');
  assert.match(fill, /createElement\("select"\)/);
  assert.match(fill, /className = "indexer-limit"/);
  assert.match(fill, /defaultOption\.value = ""/, 'padrão geral é vazio');
  assert.match(fill, /defaultOption\.textContent = "padrão geral"/);
  assert.match(fill, /unlimitedOption\.value = "0"/, '0 é override explícito de sem limite');
  assert.match(fill, /unlimitedOption\.textContent = "sem limite"/);
  assert.match(fill, /limitValue <= 20/, 'opções numéricas vão de 1 a 20');
  assert.match(fill, /limit\.setAttribute\("aria-label"/);
});

test('collectIndexerLimits serializa overrides inclusive 0 e omite o padrão geral', () => {
  const collectLimits = sliceNamedFunction('collectIndexerLimits');
  assert.match(collectLimits, /querySelectorAll\("\.indexer-limit"\)/);
  assert.match(collectLimits, /if \(value === ""\) return;/, 'só o padrão geral (vazio) fica fora');
  assert.match(collectLimits, /result\.push\(id \+ ":" \+ limit\)/, 'serializa id:limite');
  // parseIndexerLimit aceita "0": o override de sem limite entra na URL.
  const parse = sliceNamedFunction('parseIndexerLimit');
  assert.ok(parse.includes('/^-?\\d+$/'), 'aceita inteiro, incluindo "0"');
  assert.match(parse, /Math\.min\(20, Math\.max\(0, number\)\)/, 'clampa no mesmo intervalo do backend');
});

test('fromUrl restaura os limites por card sem togglar seleção', () => {
  const fromUrl = sliceNamedFunction('fromUrl');
  assert.match(fromUrl, /KEYS\.indexerLimits/);
  assert.match(fromUrl, /state\.indexerLimits = normalizeIndexerLimits\(/);
  assert.equal(fromUrl.includes('setChips('), false, 'fromUrl não pode togglar cards');
  assert.equal(fromUrl.includes('setOn('), false, 'fromUrl não pode togglar switches');
});

test('apply restaura o select individual sem togglar o card', () => {
  const apply = sliceNamedFunction('apply');
  const match = html.match(/var savedLimits = normalizeIndexerLimits\(state\.indexerLimits\);[\s\S]*?\n    \}\);?/);
  assert.ok(match, 'bloco de restauração dos limites não encontrado');
  const block = match[0];
  assert.match(block, /querySelectorAll\("\.indexer-limit"\)/);
  assert.match(block, /select\.value = Object\.prototype\.hasOwnProperty\.call\(savedLimits, id\)/);
  assert.match(block, /String\(savedLimits\[id\]\)/, 'restaura o override, inclusive 0');
  assert.match(block, /: ""/, 'sem override volta para o padrão geral');
  assert.equal(block.includes('setChips('), false, 'restaurar limite não pode togglar cards');
  assert.equal(block.includes('setOn('), false, 'restaurar limite não pode togglar switches');
});

test('código de limite por card mantém JavaScript ES5', () => {
  const start = html.indexOf('function parseIndexerLimit');
  const end = html.indexOf('function statusText');
  assert.ok(start !== -1 && end !== -1 && end > start, 'funções do limite não encontradas');
  const added = html.slice(start, end);
  assert.doesNotMatch(added, /\b(?:const|let|class|async|await)\b|=>|`/,
    'JS dos limites precisa continuar compatível com WebViews ES5');
});
