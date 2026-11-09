import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from './helpers/stub.js';
import { configureHtml, installConfigureDom, loadClientModules } from './helpers/client.js';

// "Liberar chave para o app Power Movie": com o selo ligado na instância, o
// switch pula o /seal-config e o link fica com o dk legível, que o app lê para
// usar o mesmo debrid no NZB. Desligado (padrão) o link continua cifrado.

const html = configureHtml();
const SEALED = 'eyJkcyI6InRvcmJveCIsImRrIjoiZW5jLnYxLmZha2UifQ';
const KEY = 'chave-ficticia-123';

const defaults = {
  addonName: 'Adon Teste', providers: ['jackett'], qualities: ['1080p'],
  jackettIndexers: [], jackettIndexersSelected: [],
  maxResults: 40, minSeeders: 1, maxPerIndexer: 0, brReservedSlots: 6,
  brOnly: false, dubbedOnly: true, preferDubbed: true, excludeCam: false, maxSizeGb: 0,
  max2160p: 3, max1080p: 3, max720p: 3, max480p: 3, maxSd: 3, maxUnknown: 3,
  brFirst: true, debridService: '', debridApiKey: '', debridCachedOnly: true,
  showUncachedBr: false, autoFetchBr: true, streamNameStyle: 'compact', streamNameShowSource: true,
  services: [{ id: 'torbox', label: 'TorBox', cacheCheck: true, keyUrl: 'https://torbox.app/' }],
  sealKeyEnabled: true,
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(exposeBeforeSeal: boolean) {
  const dom = installConfigureDom(html);
  const mods = await loadClientModules();
  mods.state.resetConfigureState();
  const originalSetInterval = (globalThis as any).setInterval;
  (globalThis as any).setInterval = () => 0;
  const stub = stubFetch((url) => {
    if (url.includes('/seal-config')) return { ok: true, json: async () => ({ segment: SEALED }) };
    return { ok: true, json: async () => defaults };
  });
  try {
    mods.init.init();
    await wait(20);
    const el = mods.state.state.el;
    assert.equal(el.exposeKeyForApp.getAttribute('aria-checked'), 'false', 'liberar nasce desligado');
    el.debridService.value = 'torbox';
    el.debridService.dispatch('change');
    assert.equal(el.appKeyRow.hidden, false, 'switch aparece com serviço e selo ligados');
    el.debridApiKey.value = KEY;
    el.debridApiKey.dispatch('input');
    if (exposeBeforeSeal) el.exposeKeyForApp.dispatch('click');
    await wait(350);
    const url = String(el.installUrl.textContent);
    const segment = url.replace('http://localhost:7000/', '').replace('/manifest.json', '');
    const sealCalls = stub.calls.filter((c) => c.url.includes('/seal-config')).length;
    return { mods, el, segment, sealCalls };
  } finally {
    stub.restore();
    (globalThis as any).setInterval = originalSetInterval;
    dom.cleanup();
  }
}

test('configure.html traz o switch de liberar chave desligado', () => {
  assert.match(html, /class="switch" id="exposeKeyForApp" role="switch" aria-checked="false"/);
  assert.match(html, /id="appKeyRow" hidden/);
});

test('sem liberar, o link continua cifrado pelo /seal-config', async () => {
  const { segment, sealCalls } = await boot(false);
  assert.equal(sealCalls, 1);
  assert.equal(segment, SEALED);
});

test('liberado para o app, o link leva o dk legível e não chama o selo', async () => {
  const { mods, el, segment, sealCalls } = await boot(true);
  assert.equal(sealCalls, 0, 'selo pendente foi descartado');
  const decoded = mods.keys.decodeConfig(segment);
  assert.equal(decoded[mods.keys.KEYS.debridService], 'torbox');
  assert.equal(decoded[mods.keys.KEYS.debridApiKey], KEY);
  assert.equal(el.keyHintPlain.hidden, false, 'dica de texto puro visível');
  assert.equal(el.keyHintSealed.hidden, true, 'dica de cifra escondida');
});
