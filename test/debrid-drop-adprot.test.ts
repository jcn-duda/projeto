// Suíte de testes: proteção durável (`adprot:v1`) no adaptador e reconcile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as held from '../src/debrid/protected.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { mockAccountWith, settle, flushImmediate, type FileEntry } from './helpers/alldebrid-account-mock.js';

let keepAlive: any;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => {
  clearInterval(keepAlive);
});

/** Grava um registro adprot direto na chave real, com a idade que o teste quer. */
const retain = (
  account: string,
  hash: string,
  { readyAt = null, acceptedAt = Date.now() }: { readyAt?: number | null; acceptedAt?: number } = {},
) => {
  cache.set(`${prefix('adprot')}alldebrid:${account}:${hash}`, { acceptedAt, readyAt }, 3600);
};

const KEY = 'chave-de-teste';
const HELD = 'c'.repeat(40);
const IDS = { [HELD]: 333 };

function mockAllDebrid({ ready = [], statusOf = () => 'Ready', files = [] }: { ready?: string[]; statusOf?: (id: number) => string; files?: FileEntry[] } = {}) {
  const deleted: number[] = [];
  const uploaded: string[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });

    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      uploaded.push(...hashes);
      return body({
        magnets: hashes.map((hash) => ({
          hash,
          ready: ready.includes(hash),
          id: (IDS as any)[hash] ?? 999,
        })),
      });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deleted.push(Number(url.searchParams.get('id')));
      return body({ message: 'deleted' });
    }
    if (url.pathname.endsWith('/magnet/status')) {
      const id = Number(url.searchParams.get('id'));
      return body({ magnets: { id, status: statusOf(id), files } });
    }
    if (url.pathname.endsWith('/link/unlock')) {
      return body({ link: 'https://cdn.alldebrid.test/arquivo.mkv' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    deleted,
    uploaded,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

function mockAccountMutable(magnets: any[]) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) return body({ magnets: [...magnets] });
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  return { deleted, magnets, restore() { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}

function mockAccountStates(magnets: any) {
  const deleted: number[] = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const byId = new Map(magnets.map((m: any) => [m.id, m]));

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: any) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/status')) return body({ magnets: [...byId.values()] });
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      byId.delete(id);
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  return { deleted, restore() { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; } };
}

const antigo = Math.floor(Date.now() / 1000) - 3 * 3600;
const velhoSec = Math.floor(Date.now() / 1000) - 10 * 24 * 3600;
const SETE_DIAS = 7 * 24 * 3600 * 1000;

// --- Proteção DURÁVEL (`adprot:v1`) no adaptador -----------------------------

test('proteção durável sem hold pula dropUncached e dropReady, e conta protectedBrSkipped', async () => {
  const CHAVE = 'chave-adprot-checagem';
  const ACCOUNT_ADPROT = accountScope(CHAVE);
  const BR_FRIO = 'ad'.repeat(20);
  const BR_PRONTO = 'ae'.repeat(20);
  const origUncached = config.debrid.dropUncached;
  const origReady = config.debrid.dropReady;
  config.debrid.dropUncached = true;
  config.debrid.dropReady = true;
  const api = mockAccountWith([], [BR_PRONTO]);
  metrics.reset();
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();
    await flushImmediate();

    held.protectBr('alldebrid', ACCOUNT_ADPROT, BR_FRIO);
    held.protectBr('alldebrid', ACCOUNT_ADPROT, BR_PRONTO);
    metrics.reset();
    await alldebrid.checkCached(CHAVE, [BR_FRIO, BR_PRONTO]);
    await settle();

    assert.equal(api.deleted.length, 0, 'durável: nem o frio (dropUncached) nem o pronto (dropReady) saem');
    assert.equal(
      metrics.snapshot().counters['debrid.cleanup.protectedBrSkipped'] || 0,
      2,
      'os dois hashes poupados pela proteção durável contam na métrica',
    );
  } finally {
    config.debrid.dropUncached = origUncached;
    config.debrid.dropReady = origReady;
    held.unprotect('alldebrid', ACCOUNT_ADPROT, BR_FRIO);
    held.unprotect('alldebrid', ACCOUNT_ADPROT, BR_PRONTO);
    metrics.reset();
    api.restore();
  }
});

test('resolveLink NÃO apaga BR retido pela proteção durável (mesmo sem hold)', async () => {
  const api = mockAllDebrid({ statusOf: () => 'Downloading' });
  const ACCOUNT_ADPROT = accountScope(KEY);
  try {
    held.protectBr('alldebrid', ACCOUNT_ADPROT, HELD);
    const link = await alldebrid.resolveLink(KEY, HELD, {});

    assert.equal(link, null);
    assert.deepEqual(api.deleted, [], 'a proteção durável preserva o download do BR no play');
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, HELD);
    api.restore();
  }
});

test('varredura undubbed pula o BR retido pela proteção durável', async () => {
  const CHAVE = 'chave-varredura-adprot';
  const ACCOUNT_ADPROT = accountScope(CHAVE);
  const BR_RETIDO = 'ab'.repeat(20);
  const LIXO = 'ac'.repeat(20);
  const api = mockAccountMutable([
    { id: 1, hash: 'ad'.repeat(20), status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
  ]);
  held.protectBr('alldebrid', ACCOUNT_ADPROT, BR_RETIDO);
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();

    api.magnets.push(
      { id: 2, hash: BR_RETIDO, status: 'Ready', filename: 'Foreign Old Movie 2009 720p WEBRip', uploadDate: velhoSec },
      { id: 3, hash: LIXO, status: 'Ready', filename: 'Another Foreign Movie 2010 TrueFrench BRRip', uploadDate: velhoSec },
    );

    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.deepEqual(api.deleted, [3], 'o BR retido (durável) sobrevive; só o lixo solto sai');
    assert.equal(r.varridos, 1);
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, BR_RETIDO);
    api.restore();
  }
});

test('varredura dead remove o BR retido e limpa a proteção durável', async () => {
  const CHAVE = 'chave-varredura-adprot-dead';
  const ACCOUNT_ADPROT = accountScope(CHAVE);
  const M0RTO = 'ae'.repeat(20);
  const api = mockAccountStates([
    { id: 60, hash: M0RTO, status: 'No peer after 30 minutes', uploadDate: antigo },
  ]);
  held.protectBr('alldebrid', ACCOUNT_ADPROT, M0RTO);
  metrics.reset();
  try {
    assert.equal(held.isDurablyProtected('alldebrid', ACCOUNT_ADPROT, M0RTO), true, 'precondição: retido');

    await alldebrid.sweepDead(CHAVE);
    assert.deepEqual(api.deleted, [60], 'estado terminal é lixo, não acervo: remove mesmo durável');
    assert.equal(held.isDurablyProtected('alldebrid', ACCOUNT_ADPROT, M0RTO), false, 'o dead destrava a proteção');
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, M0RTO);
    metrics.reset();
    api.restore();
  }
});

test('proteção durável é por conta: a mesma hash em outra conta continua sendo limpa', async () => {
  const OUTRA = 'chave-de-teste-b';
  const api = mockAllDebrid({ ready: [] });
  const ACCOUNT_ADPROT = accountScope(KEY);
  metrics.reset();
  try {
    held.protectBr('alldebrid', ACCOUNT_ADPROT, HELD);
    await alldebrid.checkCached(OUTRA, [HELD]);
    await settle();

    assert.deepEqual(api.deleted, [IDS[HELD]], 'a retenção de uma conta não vale para a outra');
    assert.equal(metrics.snapshot().counters['debrid.cleanup.protectedBrSkipped'] || 0, 0);
  } finally {
    held.unprotect('alldebrid', ACCOUNT_ADPROT, HELD);
    metrics.reset();
    api.restore();
  }
});

test('kill switch da proteção durável restaura a limpeza mesmo sobre registro retido', async () => {
  const api = mockAllDebrid({ ready: [] });
  const ACCOUNT_ADPROT = accountScope(KEY);
  const originalProtect = config.debrid.autoFetchProtectBr;
  metrics.reset();
  try {
    config.debrid.autoFetchProtectBr = true;
    held.protectBr('alldebrid', ACCOUNT_ADPROT, HELD);
    assert.equal(held.isDurablyProtected('alldebrid', ACCOUNT_ADPROT, HELD), true, 'precondição: proteção de pé');

    config.debrid.autoFetchProtectBr = false;
    metrics.reset();
    await alldebrid.checkCached(KEY, [HELD]);
    await settle();
    assert.deepEqual(api.deleted, [IDS[HELD]], 'com o kill switch, o registro retido deixa de poupar');
    assert.equal(metrics.snapshot().counters['debrid.cleanup.protectedBrSkipped'] || 0, 0, 'nada conta como poupado');
  } finally {
    config.debrid.autoFetchProtectBr = originalProtect;
    held.unprotect('alldebrid', ACCOUNT_ADPROT, HELD);
    metrics.reset();
    api.restore();
  }
});

// --- Reconcile: o reaper que fecha as janelas de restart --------------------

test('pending mais velho que o settle destrava na checagem e volta à limpeza', async () => {
  const CHAVE = 'chave-adprot-pending-velho';
  const CONTA = accountScope(CHAVE);
  const BR = 'af'.repeat(20);
  const api = mockAllDebrid({ ready: [] });
  metrics.reset();
  try {
    retain(CONTA, BR, { acceptedAt: Date.now() - (config.debrid.autoFetchTtl * 1000 + 60_000) });
    assert.equal(held.isDurablyProtected('alldebrid', CONTA, BR), true, 'precondição: retido');

    await alldebrid.checkCached(CHAVE, [BR]);
    await settle();

    assert.equal(held.isDurablyProtected('alldebrid', CONTA, BR), false, 'pending expirado destrava o registro');
    assert.deepEqual(api.deleted, [999], 'o magnet volta à limpeza normal da busca');
    assert.equal(metrics.snapshot().counters['adprot.pendingExpired'] || 0, 1);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
    api.restore();
  }
});

test('acervo pronto que regrediu (deixou de ter ⚡) destrava a retenção', async () => {
  const CHAVE = 'chave-adprot-regrediu';
  const CONTA = accountScope(CHAVE);
  const BR = 'b0'.repeat(20);
  const api = mockAllDebrid({ ready: [] });
  metrics.reset();
  try {
    retain(CONTA, BR, { acceptedAt: Date.now() - 3_600_000, readyAt: Date.now() - 3_000_000 });
    await alldebrid.checkCached(CHAVE, [BR]);
    await settle();

    assert.equal(held.isDurablyProtected('alldebrid', CONTA, BR), false, 'sem ⚡ não há acervo a reter');
    assert.deepEqual(api.deleted, [999]);
    assert.equal(metrics.snapshot().counters['adprot.regressed'] || 0, 1);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
    api.restore();
  }
});

test('pending fresco e acervo pronto continuam poupados pelo reconcile', async () => {
  const CHAVE = 'chave-adprot-reconcile-ok';
  const CONTA = accountScope(CHAVE);
  const NOVO = 'c0'.repeat(20);
  const api = mockAllDebrid({ ready: [] });
  metrics.reset();
  try {
    retain(CONTA, NOVO, { acceptedAt: Date.now() - 60_000 });
    await alldebrid.checkCached(CHAVE, [NOVO]);
    await settle();

    assert.equal(held.isDurablyProtected('alldebrid', CONTA, NOVO), true, 'download dentro do prazo segue retido');
    assert.deepEqual(api.deleted, []);
    assert.equal(metrics.snapshot().counters['adprot.pendingExpired'] || 0, 0);
    assert.equal(metrics.snapshot().counters['adprot.regressed'] || 0, 0);
  } finally {
    cache.clearNamespace('adprot');
    metrics.reset();
    api.restore();
  }
});
