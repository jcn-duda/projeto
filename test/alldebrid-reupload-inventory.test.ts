// 8.14+ — destrava do marcador `adrm` quando o inventário (`dinv`) prova que o
// hash bloqueado voltou PRONTO. A marca existe porque o serviço NÃO tem o
// magnet; prova de prontidão da própria conta desfaz a razão da marca. Memo
// frio/ausente NUNCA destrava (falha ao provar). Casos extraídos de
// test/alldebrid-reupload.test.ts para manter os dois arquivos sob o teto.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { accountScope } from '../src/utils/request-key.js';
import * as metrics from '../src/utils/metrics.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as inventoryMemo from '../src/debrid/inventory-memo.js';
import { reuploadBlocked, markReuploadBlocked } from '../src/debrid/alldebrid-reupload.js';
import { adrmKey, counter, mockAd } from './helpers/alldebrid-mock.js';

// O verde não pode depender do .env de quem roda (mesmo pin do 8.14).
config.debrid.reuploadBlock = true;
config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;

const KEY = 'chave-adrm-814';
const ACCOUNT = accountScope(KEY);
const BLOQUEADO = 'ab'.repeat(20);
const LIXO = 'Old Movie 2019 TrueFrench 1080p WEBRip x264';

const limpar = (...hashes: string[]) => {
  for (const h of hashes) cache.forget(adrmKey(ACCOUNT, h));
};

let keepAlive: NodeJS.Timeout;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

// --- Destrava pelo inventário (dinv) -----------------------------------------

test('8.14+: bloqueado e PRONTO no memo dinv fica fora do upload, mas entra no Set cached; marca expurgada', async () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  metrics.reset();
  // A conta prova que o hash está pronto de novo: a razão do adrm acabou.
  inventoryMemo.store('alldebrid', KEY, [
    { title: 'Re-adicionado pelo usuário', infoHash: BLOQUEADO, size: 1024 },
  ]);
  const api = mockAd({});
  try {
    const result = await alldebrid.checkCached(KEY, [BLOQUEADO]);
    assert.equal(api.uploaded.length, 0, 'NÃO vai ao /magnet/upload (requisito exato)');
    assert.equal(result.cached.has(BLOQUEADO), true, 'une direto ao Set cached/ready');
    assert.equal(result.complete, true);
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), false, 'marca adrm expurgada');
    assert.equal(counter('debrid.reupload.unblockedByInventory'), 1, 'métrica exata do destravamento');
    assert.equal(counter('debrid.reupload.blocked'), 1, 'o bloqueio inicial continua contado');
  } finally {
    api.restore();
    cache.forget(inventoryMemo.memoKey('alldebrid', KEY));
    limpar(BLOQUEADO);
    metrics.reset();
  }
});

test('8.14+: bloqueado AUSENTE do memo dinv continua fora de upload e de cache', async () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  metrics.reset();
  // Memo QUENTE mas sem o hash: prova de ausência, não de prontidão.
  inventoryMemo.store('alldebrid', KEY, [
    { title: 'Outro magnet', infoHash: 'aa'.repeat(20), size: 1 },
  ]);
  const api = mockAd({});
  try {
    const result = await alldebrid.checkCached(KEY, [BLOQUEADO]);
    assert.equal(api.uploaded.length, 0, 'sem upload');
    assert.equal(result.cached.size, 0, 'sem cache');
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), true, 'marca permanece');
    assert.equal(counter('debrid.reupload.unblockedByInventory'), 0);
    // Memo FRIO: mesmo resultado.
    cache.forget(inventoryMemo.memoKey('alldebrid', KEY));
    const frio = await alldebrid.checkCached(KEY, [BLOQUEADO]);
    assert.equal(api.uploaded.length, 0);
    assert.equal(frio.cached.size, 0);
    assert.equal(counter('debrid.reupload.unblockedByInventory'), 0);
  } finally {
    api.restore();
    cache.forget(inventoryMemo.memoKey('alldebrid', KEY));
    limpar(BLOQUEADO);
    metrics.reset();
  }
});

test('8.14+: enqueue de bloqueado pronto no inventário destrava e retorna true SEM upload', async () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  metrics.reset();
  inventoryMemo.store('alldebrid', KEY, [
    { title: 'Já pronto na conta', infoHash: BLOQUEADO, size: 2048 },
  ]);
  const api = mockAd({});
  try {
    assert.equal(await alldebrid.enqueue(KEY, BLOQUEADO), true, 'sucesso: o item já está pronto no serviço');
    assert.equal(api.uploaded.length, 0, 'nenhum upload');
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), false, 'marca expurgada');
    assert.equal(counter('debrid.reupload.unblockedByInventory'), 1);
    assert.equal(counter('debrid.reupload.blocked'), 0, 'sem log/métrica de recusa');
  } finally {
    api.restore();
    cache.forget(inventoryMemo.memoKey('alldebrid', KEY));
    limpar(BLOQUEADO);
    metrics.reset();
  }
});

test('8.14+: memo dinv stale não destrava — mark com apiKey invalida o hash do inventário', async () => {
  // H1: o hash foi APAGADO e marcado, mas o memo dinv ainda o contém como
  // pronto. O mark produtivo (com apiKey) remove o hash do memo na hora — a
  // prova do inventário só vale enquanto o hash está de fato lá — e a busca
  // seguinte NÃO destrava, NÃO faz upload e NÃO retorna cached.
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  metrics.reset();
  inventoryMemo.store('alldebrid', KEY, [
    { title: 'Memo stale pós-deleção', infoHash: BLOQUEADO, size: 1024 },
  ]);
  // Mark DE NOVO com apiKey: a deleção intencional produtiva invalida o memo.
  assert.equal(markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO, KEY), true, 'marca gravada');
  const memo = inventoryMemo.peek('alldebrid', KEY) || [];
  assert.equal(
    memo.some((i) => String(i.infoHash || '').toLowerCase() === BLOQUEADO),
    false,
    'o hash stale saiu do memo dinv',
  );
  const api = mockAd({});
  try {
    const result = await alldebrid.checkCached(KEY, [BLOQUEADO]);
    assert.equal(api.uploaded.length, 0, 'sem upload do hash apagado');
    assert.equal(result.cached.size, 0, 'sem ⚡ inventado de memo stale');
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), true, 'marca adrm permanece');
    assert.equal(counter('debrid.reupload.unblockedByInventory'), 0);
  } finally {
    api.restore();
    cache.forget(inventoryMemo.memoKey('alldebrid', KEY));
    limpar(BLOQUEADO);
    metrics.reset();
  }
});