import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubFetch } from './helpers/stub.js';
import { resetClientEnvironment } from './helpers/client.js';

// Botão "Código para TV" do /configure: manda o link corrente ao /tv-code e
// mostra o número; link novo esconde o código velho.

const URL_A = 'https://powermovie.net/eyJhIjoxfQ/manifest.json';

test('gera o código a partir do link corrente e mostra na tela', async () => {
  const { dom, mods } = await resetClientEnvironment();
  const stub = stubFetch(() => ({ ok: true, json: async () => ({ code: '4829135', expiresInSec: 1800, usesLeft: 2 }) }));
  try {
    const el = mods.state.state.el;
    el.copyBtn.setAttribute('data-url', URL_A);
    await mods.tvCode.requestTvCode();
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].url.endsWith('/tv-code'));
    assert.equal(stub.calls[0].options?.body, URL_A);
    assert.equal(el.tvCodeOut.hidden, false);
    assert.match(String(el.tvCodeOut.textContent), /4829135/);
    assert.match(String(el.tvCodeOut.textContent), /2 usos/);
  } finally {
    stub.restore();
    dom.cleanup();
  }
});

test('erro do servidor aparece sem quebrar a página', async () => {
  const { dom, mods } = await resetClientEnvironment();
  const stub = stubFetch(() => ({ ok: false, json: async () => ({ error: 'muitas tentativas' }) }));
  try {
    const el = mods.state.state.el;
    el.copyBtn.setAttribute('data-url', URL_A);
    await mods.tvCode.requestTvCode();
    assert.match(String(el.tvCodeOut.textContent), /muitas tentativas/);
  } finally {
    stub.restore();
    dom.cleanup();
  }
});

test('mudar o link esconde o código antigo', async () => {
  const { dom, mods } = await resetClientEnvironment();
  const stub = stubFetch(() => ({ ok: true, json: async () => ({ code: '4829135', expiresInSec: 1800 }) }));
  try {
    const el = mods.state.state.el;
    el.copyBtn.setAttribute('data-url', URL_A);
    await mods.tvCode.requestTvCode();
    mods.seal.applySegment('eyJiIjoyfQ');
    assert.equal(el.tvCodeOut.hidden, true);
  } finally {
    stub.restore();
    dom.cleanup();
  }
});
