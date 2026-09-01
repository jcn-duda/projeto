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
function parseObjectLiteral(text: any) {
  const quoted = text.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  return JSON.parse(quoted);
}

function sliceFunction(name: any) {
  const match = html.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n  \\}'));
  assert.ok(match, 'function ' + name + ' não encontrada no configure.html');
  return match[0];
}

function sliceNamedFunction(name: any) {
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
  // A página tem UM controle de vagas por qualidade no lugar de seis, e ele
  // vale também para o balde 'sem resolução' -- o das fontes BR, que não
  // publicam resolução no título. Foi 6 justamente para não encolher esse
  // balde; passou a 3 por decisão do operador em 2026-09-01 (lista mais curta),
  // ciente de que o BR além da reserva perde vaga. O que continua invariante é
  // o preset NÃO poder cair abaixo da reserva BR: com maxPerQuality < 6 o BR
  // ainda entra pelas 6 vagas reservadas, que atravessam a cota sem consumi-la.
  assert.equal(rec.maxPerQuality, 3, 'BR recomendado acompanha a cota da instância');
  assert.equal(presets.powerBr.maxPerQuality, 3, 'Power Movie usa a mesma cota');
  assert.ok(rec.brReservedSlots >= rec.maxPerQuality, 'a reserva BR não pode ficar menor que a cota por qualidade');
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
  ['maxUnknown', 'excludeCam', 'showUncachedBr', 'autoFetchBr', 'brReservedSlots', 'streamNameStyle', 'streamNameShowSource'].forEach((key) => {
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

// A página é de quem INSTALA o addon, não de quem opera a instância: a escolha
// de provider (jackett/prowlarr/demo) e o teste de indexador sob demanda saíram
// daqui -- o teste vive no painel, que já pede o token. Fixar isso evita que
// eles voltem por hábito na próxima edição.
test('página não tem escolha de provider nem diagnóstico de indexador', () => {
  assert.equal(html.includes('id="providers"'), false, 'chips de provider saíram da página');
  assert.equal(html.includes('id="testIndexers"'), false, 'teste de indexador sai da página');
  assert.equal(html.includes('id="jackettTestToken"'), false, 'token de teste não pode ficar na página');
  // Sem chip, mas a fonte de quem já usa outra (prowlarr) não pode ser reescrita:
  // collect() devolve o que veio do link salvo ou dos defaults da instância.
  const collect = sliceFunction('collect');
  assert.match(collect, /cfg\[KEYS\.providers\] = providerChoice\(\);/);
  const apply = sliceNamedFunction('apply');
  assert.match(apply, /providerBase = state\.providers\.filter/);
  assert.match(apply, /return name !== "torrentio"/);
});

// Um controle no lugar de seis. As SEIS chaves continuam indo na URL: o backend
// (SCHEMA em src/runtime.js) não mudou e link antigo com cotas diferentes ainda
// abre -- apply() mostra a maior delas para nenhuma vaga sumir sem o usuário pedir.
test('vagas por qualidade são um controle só, e ele alimenta as seis chaves', () => {
  assert.match(html, /id="maxPerQuality"/, 'o controle único precisa existir');
  ['max2160p', 'max1080p', 'max720p', 'max480p', 'maxSd', 'maxUnknown'].forEach((id) => {
    assert.equal(html.includes('id="' + id + '"'), false, id + ' não pode ter controle próprio');
  });
  const collect = sliceFunction('collect');
  assert.match(collect, /var perQuality = Number\(el\.maxPerQuality\.value\);/);
  ['max2160p', 'max1080p', 'max720p', 'max480p', 'maxSd', 'maxUnknown'].forEach((key) => {
    assert.ok(collect.includes('cfg[KEYS.' + key + '] = perQuality;'), key + ' recebe o valor único');
  });
  const apply = sliceNamedFunction('apply');
  assert.match(apply, /el\.maxPerQuality\.value = Math\.max\(/, 'link antigo entra pela maior cota');
});

test('copy do autofetch e aviso AllDebrid acompanham o código', () => {
  assert.match(html, /id="adMagnetNotice"/, 'aviso de magnets AllDebrid precisa existir');
  assert.match(html, /svc\.id !== "alldebrid"/, 'aviso AllDebrid só com esse serviço');
  assert.equal(html.includes('Um torrent por título'), false, 'teto do autofetch não é mais 1');
  assert.match(html, /até quatro por busca/, 'copy do switch descreve o teto atual');
});

test('switches principais têm role=switch e aria-checked', () => {
  const tags: string[] = [];
  const re = /<button\b[^>]*\bclass="switch"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) tags.push(m[0]);

  assert.equal(tags.length, 9, 'esperava os 9 switches (8 + toggle do Torrentio)');
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

// --- Pool global Torrentio (Fase 1): toggle específico, nunca seletor genérico. ---
// A página não ganhou um seletor de fonte de novo; só um switch que liga/desliga
// o 'torrentio' na lista de providers ('p'), preservando a base (jackett/prowlarr/
// demo). O mesmo toggle fecha quando não há fonte de busca real (modo demo).

test('toggle do pool global Torrentio existe e é switch específico, não seletor', () => {
  assert.match(html, /class="switch" id="torrentioToggle"/);
  assert.match(html, /aria-label="Pool global Torrentio"/);
  assert.match(html, /role="switch"/);
  // Continua SEM diagnóstico e SEM seletor genérico de fonte.
  assert.equal(html.includes('id="providers"'), false, 'seletor de fonte não pode reaparecer');
  assert.equal(html.includes('id="testIndexers"'), false, 'teste de indexador continua fora');
  assert.equal(html.includes('id="jackettTokenTest"'), false, 'token de teste segue no painel');
});

test('providerChoice() recompõe a lista: base intacta + torrentio quando há base de busca', () => {
  assert.match(html, /var providerBase = \["jackett"\]/);
  assert.match(html, /var torrentioOn = false/);
  assert.notEqual(html.indexOf('function providerChoice()'), -1, 'providerChoice passou a ser função');
  assert.match(html, /if \(torrentioOn && hasSearchBase\(\)\) list\.push\("torrentio"\)/);
  assert.match(html, /if \(!list\.length\) list\.push\("jackett"\)/);
});

test('modo demo isola o pool do Torrentio (sem rede)', () => {
  // A base exige uma fonte de busca real: só 'demo' não oferece o toggle.
  assert.match(html, /providerBase\.some\(function \(name\) \{ return name !== "demo"; \}\)/);
  const apply = sliceNamedFunction('apply');
  assert.match(apply, /el\.torrentioRow\.hidden = !offerTorrentio/);
  assert.match(apply, /if \(!offerTorrentio\) torrentioOn = false/);
});

test('aplica separa torrentio da base e restaura o toggle preservando a ordem', () => {
  const d = sliceNamedFunction('apply');
  assert.match(d, /providerBase = state\.providers\.filter/);
  assert.match(d, /torrentioOn = state\.providers\.indexOf\("torrentio"\) !== -1/);
  assert.match(d, /setOn\(el\.torrentioToggle, torrentioOn\)/);
  assert.equal(d.includes('providerBase = state.providers.join'), false);
});

test('fromUrl reconhece `+` como separador de lista junto da vírgula', () => {
  const fromUrl = sliceNamedFunction('fromUrl');
  assert.ok(fromUrl.includes('split(/[,+]/)'), 'toList separa por `+` além da vírgula');
});
