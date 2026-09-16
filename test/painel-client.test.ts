import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  getPainelState,
  resetPainelState,
  setPainelToken,
  setPainelLoading,
  setPainelError,
  mergePainelPayload,
  subscribePainelToken,
} from '../src/client/painel/store.js';
import { pollOnce, VITAL_BLOCKS } from '../src/client/painel/poll.js';
import { readStored, writeStored } from '../src/client/painel/storage.js';
import { basePrefix, fetchStatus, prefixFromPathname } from '../src/client/painel/api.js';

test('VITAL_BLOCKS inclui searchFirst (KPI I0 do cold)', () => {
  assert.ok(VITAL_BLOCKS.includes('searchFirst'));
});

test('VITAL_BLOCKS não carrega catalog no poll rápido (varredura O(rows))', () => {
  assert.equal(VITAL_BLOCKS.includes('catalog'), false, 'catalog é sob demanda via catalog-report');
});

test('pollOnce pede searchFirst na URL e mescla o bloco no estado', async () => {
  resetPainelState({ token: 'tok' });
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  (globalThis as any).fetch = async (url: string) => {
    seenUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ generatedAt: 'agora', searchFirst: { responses: 4, brVisible: 2 } }),
    };
  };
  try {
    await pollOnce();
    assert.match(decodeURIComponent(seenUrl), /blocos=.*searchFirst/, 'o pedido precisa carregar o bloco');
    assert.deepEqual(getPainelState().payload.searchFirst, { responses: 4, brVisible: 2 });
    assert.equal(getPainelState().connectionState, 'online');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test('429 sai de syncing para warn preservando os dados já carregados', async () => {
  resetPainelState({ token: 'tok', payload: { general: { ok: true } }, connectionState: 'syncing' });
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    await pollOnce();
    const state = getPainelState();
    assert.equal(state.connectionState, 'warn', 'não pode ficar preso em syncing');
    assert.equal(state.loading, false);
    assert.equal(state.error, null);
    assert.deepEqual(state.payload.general, { ok: true }, 'dados anteriores preservados');
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test('falha dura (401) sai de syncing para error', async () => {
  resetPainelState({ token: 'tok' });
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  try {
    await pollOnce();
    assert.equal(getPainelState().connectionState, 'error');
    assert.match(String(getPainelState().error), /Token inválido/);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

test('notificações de estado não sobrescrevem o token que o operador digita', () => {
  resetPainelState({ token: 'salvo' });
  let typed = 'digitando';
  const tokenUpdates: string[] = [];
  const unsubscribe = subscribePainelToken((token) => {
    typed = token;
    tokenUpdates.push(token);
  });
  try {
    setPainelLoading(true);
    setPainelError('erro transitório');
    setPainelError(null);
    mergePainelPayload({ general: { ok: true } });

    assert.equal(typed, 'digitando', 'poll/erro/merge não podem reescrever o input');
    assert.deepEqual(tokenUpdates, []);

    setPainelToken('novo-token');
    assert.equal(typed, 'novo-token');
    assert.deepEqual(tokenUpdates, ['novo-token']);

    // Notificação de estado com o MESMO token não re-dispara o canal.
    setPainelLoading(false);
    assert.deepEqual(tokenUpdates, ['novo-token']);
  } finally {
    unsubscribe();
  }
});

test('prefixFromPathname preserva o segmento de config da install URL', () => {
  assert.equal(prefixFromPathname('/painel'), '');
  assert.equal(prefixFromPathname('/painel/'), '');
  assert.equal(prefixFromPathname('/abc123/painel'), '/abc123');
  assert.equal(prefixFromPathname('/abc123/painel/'), '/abc123');
  assert.equal(prefixFromPathname('/dashboard'), '', 'só a rota /painel define prefixo');
});

test('fetchStatus usa no-store e o prefixo da instalação', async () => {
  resetPainelState({ token: 'tok' });
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenInit: any = null;
  (globalThis as any).fetch = async (url: string, init: any) => {
    seenUrl = String(url);
    seenInit = init;
    return { ok: true, status: 200, json: async () => ({ searchFirst: { responses: 1 } }) };
  };
  (globalThis as any).window = { location: { pathname: '/abc123/painel' } };
  try {
    assert.equal(basePrefix(), '/abc123');
    const res = await fetchStatus('tok', ['searchFirst']);
    assert.equal(res.ok, true);
    assert.equal(seenInit.cache, 'no-store', 'diagnóstico não pode vir do cache do browser');
    assert.equal(seenUrl, '/abc123/dashboard-status.json?blocos=searchFirst');
  } finally {
    (globalThis as any).fetch = originalFetch;
    delete (globalThis as any).window;
  }
});

test('readStored/writeStored degradam sem lançar quando localStorage está bloqueado', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        throw new Error('storage bloqueado');
      },
      setItem() {
        throw new Error('storage bloqueado');
      },
    },
  });
  try {
    assert.equal(readStored('k', 'fallback'), 'fallback');
    assert.doesNotThrow(() => writeStored('k', 'v'));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete (globalThis as any).localStorage;
  }
});

test('import do store não quebra quando localStorage lança no acesso', () => {
  const storeUrl = new URL('../src/client/painel/store.js', import.meta.url).href;
  const code = [
    "Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });",
    `const mod = await import(${JSON.stringify(storeUrl)});`,
    "if (mod.getPainelState().token !== '') { console.error('token inesperado'); process.exit(2); }",
    "process.stdout.write('ok');",
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(out.trim(), 'ok');
});
