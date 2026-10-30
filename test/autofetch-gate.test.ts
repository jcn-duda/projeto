// Gate de OCUPAÇÃO da conta — o único pedaço do Chupim que continua em TS.
// `src/providers/autofetch-gate.ts` FICA (leva B4): memo local + refresh em
// background, rede proibida no caminho síncrono. O efeito de disparo é medido
// pelo oráculo congelado (`applyDebrid`), que já é o produtor pós-corte.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import debridCheck from './helpers/pipeline-oracle/debrid-check.js';
import * as runtime from '../src/runtime.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as srcGate from '../src/providers/autofetch-gate.js';
import * as accountGate from './helpers/pipeline-oracle/autofetch-account-gate.js';
import * as held from '../src/debrid/protected.js';
import { kvForget, kvPeek } from '../src/utils/native-kv.js';
import { accountScope } from '../src/utils/request-key.js';
import { applyDebrid } from './helpers/pipeline-oracle/index.js';
import type { DebridAdapter } from '../types/domain.js';

const PM = 'premiumize';
const API_KEY = 'chave-gate-cheia';
const pmAdapter = debrid.BY_ID.get(PM) as DebridAdapter;
const account = accountScope(API_KEY);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hx = (seed: string) => seed.repeat(40).slice(0, 40);
const brDub = (hash: string) => ({
  infoHash: hash,
  name: 'Filme Conta Cheia Dublado',
  title: 'Filme Conta Cheia Dublado',
  _br: true,
  _dubbed: true,
  _quality: '1080p',
  _seeders: 1,
});

test('memo frio é fail-open, memo quente bloqueia e pauseAt 0 desliga', async () => {
  const originalCheck = debridCheck.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const originalStatus = pmAdapter.accountStatus;
  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchPauseAt = 5;
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    debridCheck.checkCached = async () => ({ cached: new Set(), known: true });
    accountGate.resetAccountGate();

    // Frio: nenhuma medição local, então a busca não pode ser barrada.
    assert.equal(accountGate.accountGateBlocked(pmAdapter, API_KEY), false, 'memo frio não bloqueia');
    assert.equal(accountGate.accountGateSnapshot()._origem.accounts, 'naomedido', 'frio é declarado, não pintado como saudável');
    await sleep(20);
    assert.equal(accountGate.accountGateBlocked(pmAdapter, API_KEY), true, 'memo quente acima do limiar bloqueia');

    // Painel: digest de 12 hex, contagem/limiar e origem da medição — sem a
    // chave crua nem hash de 40.
    const snap = accountGate.accountGateSnapshot();
    assert.equal(snap.pauseAt, 5);
    assert.equal(snap.blocked, true);
    assert.equal(snap._origem.accounts, 'amostra');
    const alvo = snap.accounts.find((item) => item.count === 900);
    assert.ok(alvo, 'a conta medida aparece no painel');
    assert.equal(alvo.max, 5);
    assert.equal(alvo.source, 'accountStatus');
    assert.equal(alvo.blocked, true);
    assert.match(alvo.id, /^[a-f0-9]{12}$/, 'id do painel é digest de 12 hex');
    const body = JSON.stringify(snap);
    assert.equal(body.includes(API_KEY), false, 'nenhuma apiKey no painel');
    assert.doesNotMatch(body, /[a-f0-9]{40}/i, 'nenhum hash cru no painel');

    config.debrid.autoFetchPauseAt = 0;
    assert.equal(accountGate.accountGateBlocked(pmAdapter, API_KEY), false, 'flag 0 desliga o gate');
    const desligado = accountGate.accountGateSnapshot();
    assert.equal(desligado.blocked, false, 'pauseAt 0 não pinta bloqueio');
    assert.equal(desligado.accounts.find((item) => item.count === 900)?.blocked, false);
  } finally {
    debridCheck.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.accountStatus = originalStatus;
    accountGate.resetAccountGate();
  }
});

test('conta cheia barra o disparo, devolve o hold e não grava marker; memo frio libera', async () => {
  const originalCheck = debridCheck.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const originalEnqueue = pmAdapter.enqueue;
  const originalStatus = pmAdapter.accountStatus;
  const userOpts = {
    ...runtime.defaults(),
    debridService: PM,
    debridApiKey: API_KEY,
    debridCachedOnly: true,
    autoFetchBr: true,
  };
  const run = (h: string, searchKey: string) => runtime.run({ opts: userOpts, encoded: 'cfg-gate' }, () =>
    applyDebrid([brDub(h)] as never, { searchKey } as never),
  );
  const hCold = hx('e');
  const hHot = hx('f');
  let enqueues = 0;
  try {
    config.debrid.publicUrl = 'http://addon.test';
    config.debrid.autoFetchPauseAt = 5;
    pmAdapter.enqueue = async () => { enqueues += 1; return true; };
    pmAdapter.accountStatus = async () => ({ magnets: 900 });
    debridCheck.checkCached = async () => ({ cached: new Set(), known: true });
    accountGate.resetAccountGate();

    // Aquece o memo sem passar pela busca.
    accountGate.accountGateBlocked(pmAdapter, API_KEY);
    await sleep(20);

    await run(hHot, 'gate-cheio');
    await sleep(20);
    assert.equal(enqueues, 0, 'conta cheia impede o debrid.enqueue');
    assert.equal(held.isHeld(hHot, account), false, 'bloqueio libera o hold do candidato');
    assert.equal(kvPeek(autofetch.markerKey(PM, account, hHot)), null, 'bloqueio não grava marker');

    // Memo frio: fail-open — o mesmo candidato sai e o aceite RETÉM o hold.
    accountGate.resetAccountGate();
    await run(hCold, 'gate-frio');
    await sleep(20);
    assert.equal(enqueues, 1, 'primeira chamada com memo frio enfileira normalmente');
    assert.equal(held.isHeld(hCold, account), true, 'aceite mantém o hold');
    assert.equal(accountGate.accountGateBlocked(pmAdapter, API_KEY), true, 'refresh da busca fria reaqueceu o memo');
  } finally {
    debridCheck.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.enqueue = originalEnqueue;
    pmAdapter.accountStatus = originalStatus;
    accountGate.resetAccountGate();
    autofetch.releaseSearch('gate-frio');
    autofetch.releaseSearch('gate-cheio');
    for (const h of [hCold, hHot]) {
      kvForget(autofetch.markerKey(PM, account, h));
      held.release(h, account);
    }
  }
});

test('contagem não numérica não vira memo: o gate segue fail-open', async () => {
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  const originalStatus = pmAdapter.accountStatus;
  try {
    config.debrid.autoFetchPauseAt = 5;
    pmAdapter.accountStatus = async () => ({}) as never;
    accountGate.resetAccountGate();
    assert.equal(accountGate.accountGateBlocked(pmAdapter, API_KEY), false, 'primeira chamada é fail-open');
    await sleep(20);
    assert.equal(accountGate.accountGateBlocked(pmAdapter, API_KEY), false, 'sem contagem nada é gravado no memo');
    assert.equal(accountGate.accountGateSnapshot()._origem.accounts, 'naomedido');
  } finally {
    config.debrid.autoFetchPauseAt = originalPauseAt;
    pmAdapter.accountStatus = originalStatus;
    accountGate.resetAccountGate();
  }
});

test('retrato do painel em src é o shape vazio (o gate mora no oráculo)', () => {
  const originalPauseAt = config.debrid.autoFetchPauseAt;
  try {
    config.debrid.autoFetchPauseAt = 7;
    const snap = srcGate.accountGateSnapshot();
    assert.equal(snap.pauseAt, 7, 'pauseAt vem da config viva');
    assert.equal(snap.blocked, false);
    assert.deepEqual(snap.accounts, [], 'sem memo em produção não há conta medida');
    assert.equal(snap.inFlight, 0);
    assert.equal(snap._origem.accounts, 'naomedido');
  } finally {
    config.debrid.autoFetchPauseAt = originalPauseAt;
  }
});
