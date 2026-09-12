import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from './helpers/stub.js';
import { configureHtml, resetClientEnvironment, installConfigureDom, loadClientModules } from './helpers/client.js';

// A página /configure deixou de ser HTML+JS inline ES5: o JS virou módulos TS
// em src/client/configure, emitidos como ESM nativo. Estes testes importam o
// emit de Node de verdade (via test/helpers/client.ts, import dinâmico) em vez
// de regexar corpos de função no HTML; os testes estruturais continuam lendo o
// configure.html. O que protege o browser agora é o client-esm.test.ts.

const html = configureHtml();

async function env() {
  return resetClientEnvironment(html);
}

test('preset BR recomendado carrega as escolhas comportamentais novas', async () => {
  const { mods } = await env();
  const presets = mods.view.PRESET_BEHAVIORS;
  const rec = presets.recommended;
  // O preset NÃO pode cair abaixo da reserva BR: com maxPerQuality < 6 o BR
  // ainda entra pelas vagas reservadas, que atravessam a cota sem consumi-la.
  assert.equal(rec.maxPerQuality, 3, 'BR recomendado acompanha a cota da instância');
  assert.equal(presets.powerBr.maxPerQuality, 3, 'Power Movie usa a mesma cota');
  assert.ok(rec.brReservedSlots >= rec.maxPerQuality, 'a reserva BR não pode ser menor que a cota');
  assert.equal(rec.excludeCam, true, 'BR recomendado oculta CAM');
  assert.equal(rec.showUncachedBr, false, 'BR recomendado mantém fora-do-cache escondido');
  assert.equal(rec.autoFetchBr, true, 'BR recomendado liga o autofetch');
  assert.equal(presets.powerBr.showUncachedBr, true, 'Power Movie mostra BR fora do cache');
});

test('copy do switch bu aponta Dual/gringo e a chave bu quando cachedOnly esconde BR', () => {
  assert.match(html, /id="showUncachedBr"/);
  assert.match(html, /sobram Dual\/gringo/);
  assert.match(html, /<code>bu<\/code>/);
});

test('collect codifica o estado inteiro e render publica o segmento', async () => {
  const { mods } = await env();
  const { KEYS } = mods.keys;
  mods.state.state.el.maxPerQuality.value = '3';
  mods.state.state.el.maxResults.value = '40';
  mods.state.state.el.streamNameStyle.value = 'verbose';
  mods.state.state.el.streamNameShowSource.value = 'false';
  const cfg = mods.view.collect();
  assert.equal(cfg[KEYS.maxResults], 40);
  ['maxUnknown', 'excludeCam', 'showUncachedBr', 'autoFetchBr', 'brReservedSlots', 'streamNameStyle', 'streamNameShowSource']
    .forEach((key) => assert.ok(KEYS[key] in cfg, 'collect() precisa incluir ' + key));
  ['max2160p', 'max1080p', 'max720p', 'max480p', 'maxSd', 'maxUnknown']
    .forEach((key) => assert.equal(cfg[KEYS[key]], 3, key + ' recebe o valor único'));

  // render() monta a URL de install a partir de collect(): o segmento tem que
  // decodificar de volta ao mesmo estado.
  mods.view.render();
  const url = mods.state.state.el.installUrl.textContent as string;
  const segment = url.replace('http://localhost:7000/', '').replace('/manifest.json', '');
  const decoded = mods.keys.decodeConfig(segment);
  assert.equal(decoded[KEYS.maxResults], 40);
  assert.equal(decoded[KEYS.maxPerQuality] ?? decoded[KEYS.max1080p], 3);
});

test('initialPlan: URL existente vira custom e não aplica preset', async () => {
  const { mods } = await env();
  const defaults = { maxResults: 40, jackettIndexers: [{ id: 'bludv' }], providers: ['jackett'] };
  const saved = mods.init.initialPlan(defaults, { maxResults: 7 });
  assert.equal(saved.preset, 'custom');
  assert.equal(saved.initial.maxResults, 7, 'a URL salva vence os defaults');
  assert.equal('jackettIndexers' in saved.initial, false, 'o catálogo não é uma seleção');
  const fresh = mods.init.initialPlan(defaults, null);
  assert.equal(fresh.preset, 'recommended');
  assert.equal(fresh.initial.maxResults, 40);
});

test('página não tem escolha de provider nem diagnóstico de indexador', () => {
  assert.equal(html.includes('id="providers"'), false, 'chips de provider saíram da página');
  assert.equal(html.includes('id="testIndexers"'), false, 'teste de indexador sai da página');
  assert.equal(html.includes('id="jackettTestToken"'), false, 'token de teste não pode ficar na página');
});

test('vagas por qualidade são um controle só, e apply mostra a maior cota do link antigo', async () => {
  assert.match(html, /id="maxPerQuality"/, 'o controle único precisa existir');
  ['max2160p', 'max1080p', 'max720p', 'max480p', 'maxSd', 'maxUnknown']
    .forEach((id) => assert.equal(html.includes('id="' + id + '"'), false, id + ' não pode ter controle próprio'));
  const { mods } = await env();
  mods.init.apply({
    providers: ['jackett'], qualities: [], maxResults: 40, minSeeders: 1, maxPerIndexer: 0,
    brReservedSlots: 6, brOnly: false, dubbedOnly: true, preferDubbed: true, excludeCam: false,
    maxSizeGb: 0, brFirst: true, debridService: '', debridCachedOnly: true,
    showUncachedBr: false, autoFetchBr: true, max2160p: 1, max1080p: 5,
    max720p: 2, max480p: 2, maxSd: 2, maxUnknown: 2,
  });
  assert.equal(mods.state.state.el.maxPerQuality.value, '5', 'link antigo entra pela maior cota');
});

test('copy do autofetch e aviso AllDebrid acompanham o código', () => {
  assert.match(html, /id="adMagnetNotice"/, 'aviso de magnets AllDebrid precisa existir');
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
  assert.ok(html.includes('Somente dublado na fonte direta BLUDV'), 'rótulo precisa citar a fonte direta BLUDV');
  assert.match(html, /aria-label="Somente dublado na fonte direta BLUDV"/);
});

test('statusText é honesto sem medição e formata idade', async () => {
  const { mods } = await env();
  assert.equal(mods.indexers.statusText(null), 'ainda não consultado');
  assert.match(mods.indexers.statusText({ state: 'online', ms: 1500, checkedAt: new Date().toISOString() }), /online · 1\.5s · medido agora/);
  const twoMinAgo = new Date(Date.now() - 120000).toISOString();
  assert.match(mods.indexers.statusText({ state: 'offline', ms: null, checkedAt: twoMinAgo }), /offline · medido há 2 min/);
  assert.doesNotMatch(mods.indexers.statusText({ state: 'slow', ms: null, checkedAt: null }), /desconhecido/);
});

test('refreshIndexerStatuses atualiza a medição sem reaplicar configuração', async () => {
  const { mods } = await env();
  mods.indexers.fillJackettIndexers([{ id: 'bludv', label: 'BLUDV', isBr: true }]);
  const chip = mods.state.state.el.jackettIndexers.querySelectorAll('.indexer-toggle')[0];
  chip.setAttribute('aria-pressed', 'false');
  mods.indexers.refreshIndexerStatuses({ jackettIndexers: [{ id: 'bludv', status: { state: 'online', ms: 800, checkedAt: new Date().toISOString() } }] });
  assert.equal(chip.getAttribute('aria-pressed'), 'false', 'refresh não pode mexer na seleção');
  const statusText = mods.state.state.el.jackettIndexers.querySelectorAll('.status-text')[0].textContent;
  assert.match(statusText, /online/);
});

test('pollIndexerStatuses evita resposta em cache e colapsa chamadas concorrentes', async () => {
  const { mods } = await env();
  mods.indexers.fillJackettIndexers([{ id: 'bludv', label: 'BLUDV' }]);
  const stub = stubFetch(() => ({ ok: true, json: async () => ({ jackettIndexers: [{ id: 'bludv', status: { state: 'online' } }] }) }));
  try {
    mods.indexers.pollIndexerStatuses();
    mods.indexers.pollIndexerStatuses();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stub.calls.length, 1, 'chamada concorrente não pode duplicar o fetch');
    assert.match(stub.calls[0].url, /\/defaults\.json\?statusAt=\d+/);
    assert.equal(mods.state.state.jackettIndexers[0].status.state, 'online');
  } finally {
    stub.restore();
  }
});

test('KEYS mapeia o limite individual por indexador para jl', async () => {
  const { mods } = await env();
  assert.equal(mods.keys.KEYS.indexerLimits, 'jl');
});

test('collectIndexerLimits serializa overrides inclusive 0 e omite o padrão geral', async () => {
  const { mods } = await env();
  mods.indexers.fillJackettIndexers([{ id: 'bludv', label: 'BLUDV' }]);
  const select = mods.state.state.el.jackettIndexers.querySelectorAll('.indexer-limit')[0];
  select.value = '';
  assert.equal(mods.limits.collectIndexerLimits(), '');
  select.value = '0';
  assert.equal(mods.limits.collectIndexerLimits(), 'bludv:0');
  select.value = '5';
  assert.equal(mods.limits.collectIndexerLimits(), 'bludv:5');
  assert.equal(mods.limits.parseIndexerLimit('21'), 20, 'clampa no intervalo do backend');
  assert.equal(mods.limits.parseIndexerLimit('-1'), 0);
});

test('card de indexador ganha select individual com padrão geral, sem limite e 1..20', async () => {
  const { mods } = await env();
  mods.indexers.fillJackettIndexers([{ id: 'bludv', label: 'BLUDV' }]);
  const select = mods.state.state.el.jackettIndexers.querySelectorAll('.indexer-limit')[0];
  assert.equal(select.tagName, 'select');
  assert.equal(select.children.length, 22, 'padrão + sem limite + 20 opções');
  assert.equal(select.children[0].value, '');
  assert.equal(select.children[0].textContent, 'padrão geral');
  assert.equal(select.children[1].value, '0');
  assert.equal(select.children[1].textContent, 'sem limite');
  assert.match(select.children[21].value, /^20$/);
  assert.match(select.getAttribute('aria-label'), /Limite individual/);
});

test('fromUrl restaura os limites por card sem togglar seleção', async () => {
  const { mods } = await env();
  mods.indexers.fillJackettIndexers([{ id: 'bludv', label: 'BLUDV' }]);
  const segment = mods.keys.encodeConfig({ ji: 'bludv', jl: 'bludv:0' });
  (globalThis as any).location.pathname = '/' + segment + '/configure';
  const chip = mods.state.state.el.jackettIndexers.querySelectorAll('.indexer-toggle')[0];
  chip.setAttribute('aria-pressed', 'true');
  const parsed = mods.init.fromUrl();
  assert.deepEqual(parsed.indexerLimits, { bludv: 0 });
  assert.equal(chip.getAttribute('aria-pressed'), 'true', 'fromUrl não pode togglar cards');
});

test('apply restaura o select individual sem togglar o card', async () => {
  const { mods } = await env();
  mods.indexers.fillJackettIndexers([{ id: 'bludv', label: 'BLUDV' }]);
  const select = mods.state.state.el.jackettIndexers.querySelectorAll('.indexer-limit')[0];
  mods.init.apply({
    providers: ['jackett'], qualities: [], maxResults: 40, minSeeders: 1, maxPerIndexer: 0,
    brReservedSlots: 6, brOnly: false, dubbedOnly: true, preferDubbed: true, excludeCam: false,
    maxSizeGb: 0, brFirst: true, debridService: '', debridCachedOnly: true,
    showUncachedBr: false, autoFetchBr: true, jackettIndexers: ['bludv'], indexerLimits: { bludv: 0 },
  });
  assert.equal(select.value, '0', 'restaura o override, inclusive 0');
});

test('providerChoice recompõe a lista: base intacta + torrentio quando há base de busca', async () => {
  const { mods } = await env();
  mods.state.state.providerBase = ['jackett'];
  mods.state.state.torrentioOn = false;
  assert.equal(mods.view.providerChoice(), 'jackett');
  mods.state.state.torrentioOn = true;
  assert.equal(mods.view.providerChoice(), 'jackett,torrentio');
  mods.state.state.providerBase = ['demo'];
  assert.equal(mods.view.providerChoice(), 'demo', 'demo isola o pool');
  mods.state.state.providerBase = [];
  assert.equal(mods.view.providerChoice(), 'torrentio', 'base vazia com toggle ligado é torrentio-only');
});

test('modo demo isola o pool do Torrentio (sem rede)', async () => {
  const { mods } = await env();
  mods.init.apply({
    providers: ['demo'], qualities: [], maxResults: 40, minSeeders: 1, maxPerIndexer: 0,
    brReservedSlots: 6, brOnly: false, dubbedOnly: true, preferDubbed: true, excludeCam: false,
    maxSizeGb: 0, brFirst: true, debridService: '', debridCachedOnly: true, showUncachedBr: false, autoFetchBr: true,
  });
  assert.equal(mods.state.state.el.torrentioRow.hidden, true);
  assert.equal(mods.state.state.torrentioOn, false);
});

test('apply separa torrentio da base e restaura o toggle preservando a ordem', async () => {
  const { mods } = await env();
  // O elemento real tem role=switch; o getAttribute('role') decide entre
  // aria-checked e aria-pressed no setOn.
  mods.state.state.el.torrentioToggle.setAttribute('role', 'switch');
  mods.init.apply({
    providers: ['jackett', 'torrentio'], qualities: [], maxResults: 40, minSeeders: 1, maxPerIndexer: 0,
    brReservedSlots: 6, brOnly: false, dubbedOnly: true, preferDubbed: true, excludeCam: false,
    maxSizeGb: 0, brFirst: true, debridService: '', debridCachedOnly: true, showUncachedBr: false, autoFetchBr: true,
  });
  assert.deepEqual(mods.state.state.providerBase, ['jackett']);
  assert.equal(mods.state.state.torrentioOn, true);
  assert.equal(mods.state.state.el.torrentioToggle.getAttribute('aria-checked'), 'true');
});

test('fromUrl reconhece `+` como separador de lista junto da vírgula', async () => {
  const { mods } = await env();
  const segment = mods.keys.encodeConfig({ p: 'jackett+torrentio' });
  (globalThis as any).location.pathname = '/' + segment + '/configure';
  const parsed = mods.init.fromUrl();
  assert.deepEqual(parsed.providers, ['jackett', 'torrentio']);
});

test('toggle do pool global Torrentio existe e é switch específico, não seletor', () => {
  assert.match(html, /class="switch" id="torrentioToggle"/);
  assert.match(html, /aria-label="Pool global Torrentio"/);
  assert.equal(html.includes('id="providers"'), false, 'seletor de fonte não pode reaparecer');
  assert.equal(html.includes('id="testIndexers"'), false, 'teste de indexador continua fora');
});

test('a página carrega só o entry ESM, sem script inline', () => {
  assert.match(html, /<script type="module" src="\/client\/configure\/entry\.js"><\/script>/);
  assert.equal(html.includes('configure-app.js'), false, 'a casca antiga saiu da página');
  assert.equal(/<script>\s*"use strict"/.test(html), false, 'não pode sobrar script inline');
});

test('markup real expõe data-preset/data-value/aria que o cliente lê', () => {
  // O Fake DOM do helper parseia este markup; ancorar os atributos impede que
  // uma edição no HTML deixe o teste executando um DOM irreal.
  assert.match(html, /<button type="button" class="preset" data-preset="recommended" aria-pressed="false">/);
  assert.match(html, /<button type="button" class="preset" data-preset="powerBr"/);
  assert.match(html, /<button type="button" class="preset" data-preset="custom"/);
  ['2160p', '1080p', '720p', '480p'].forEach((value) => {
    assert.match(html, new RegExp('<button type="button" class="chip" data-value="' + value + '"'));
  });
  assert.match(html, /class="switch" id="brFirst" role="switch" aria-checked="true"/);
  assert.match(html, /class="switch" id="brOnly" role="switch" aria-checked="false"/);
});

test('init() liga o DOM, clica chip/preset e publica a URL a partir do markup real', async () => {
  const dom = installConfigureDom(html);
  const mods = await loadClientModules();
  mods.state.resetConfigureState();
  const originalSetInterval = (globalThis as any).setInterval;
  // init() agenda o polling; o interval manteria o processo de teste vivo.
  (globalThis as any).setInterval = () => 0;
  const defaults = {
    addonName: 'Adon Teste', providers: ['jackett'], qualities: ['1080p'],
    jackettIndexers: [{ id: 'bludv', label: 'BLUDV', isBr: true }, { id: 'comando', label: 'Comando' }],
    jackettIndexersSelected: ['bludv'],
    maxResults: 40, minSeeders: 1, maxPerIndexer: 0, brReservedSlots: 6,
    brOnly: false, dubbedOnly: true, preferDubbed: true, excludeCam: false, maxSizeGb: 0,
    max2160p: 3, max1080p: 3, max720p: 3, max480p: 3, maxSd: 3, maxUnknown: 3,
    brFirst: true, debridService: '', debridApiKey: '', debridCachedOnly: true,
    showUncachedBr: false, autoFetchBr: true, streamNameStyle: 'compact', streamNameShowSource: true,
    services: [{ id: 'alldebrid', label: 'AllDebrid', cacheCheck: true, keyUrl: 'https://alldebrid.com/' }],
    sealKeyEnabled: false,
  };
  const stub = stubFetch(() => ({ ok: true, json: async () => defaults }));
  try {
    mods.init.init();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Binding pelo markup real: switch com role/aria e inputs do range.
    assert.equal(mods.state.state.el.brFirst.getAttribute('role'), 'switch');
    assert.equal(mods.state.state.el.brFirst.getAttribute('aria-checked'), 'true');
    assert.equal(mods.state.state.el.debridService.children.length, 1, 'serviço populado no select');
    assert.equal(mods.state.state.el.jackettIndexers.querySelectorAll('.indexer-toggle').length, 2, 'cards de indexador criados');
    assert.equal(mods.state.state.el.maxResults.value, '40', 'apply escreve o valor do default');
    assert.equal(dom.document.title, 'Adon Teste — Configurar', 'marca vem do defaults.json');
    const chip1080 = mods.state.state.el.qualities.querySelectorAll('.chip').find((c: any) => c.getAttribute('data-value') === '1080p');
    assert.equal(chip1080.getAttribute('aria-pressed'), 'true', 'qualities do defaults liga o chip');
    // Clique de chip de qualidade: listener no container, ancestral chip.
    const chip720 = mods.state.state.el.qualities.querySelectorAll('.chip').find((c: any) => c.getAttribute('data-value') === '720p');
    mods.state.state.el.qualities.dispatch('click', { target: chip720 });
    assert.equal(chip720.getAttribute('aria-pressed'), 'true');
    // Clique de preset "recommended": reaplica e marca o botão.
    const recommended = mods.state.state.el.presets.querySelectorAll('.preset').find((p: any) => p.getAttribute('data-preset') === 'recommended');
    mods.state.state.el.presets.dispatch('click', { target: recommended });
    assert.equal(recommended.getAttribute('aria-pressed'), 'true');
    assert.equal(mods.state.state.el.brOnly.getAttribute('aria-checked'), 'false', 'preset recommended desliga brOnly');
    // URL renderizada a partir do estado clicado.
    const url = String(mods.state.state.el.installUrl.textContent);
    const segment = url.replace('http://localhost:7000/', '').replace('/manifest.json', '');
    const decoded = mods.keys.decodeConfig(segment);
    assert.equal(decoded[mods.keys.KEYS.maxResults], 40);
    assert.equal(decoded[mods.keys.KEYS.brOnly], 0);
    assert.ok(String(decoded[mods.keys.KEYS.qualities]).includes('720p'), 'chip clicado entra na URL');
  } finally {
    stub.restore();
    (globalThis as any).setInterval = originalSetInterval;
    dom.cleanup();
  }
});
