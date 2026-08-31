// DEBRID_ALIVE_AS_CACHE — o `mag:alive` (anotação durável, TTL ~7 dias) como ⚡
// de SOBRA em adaptadores COM cacheCheck (a AllDebrid, cuja checagem é upload).
//
// Semântica fixada aqui (plano da sessão de limpeza 2026-08-30):
//   - a checagem do momento é a autoridade; a memória só preenche o SILÊNCIO
//     (checagem degradada/parcial ou hash não coberto) e NUNCA vence um
//     negativo fresco (`davail=0` medido);
//   - `cachedForAutofetch` é snapshot PRÉ-inflação: autofetch e sampler F3
//     exigem evidência medida e não podem ser enganados pela memória;
//   - `accountKnown` continua false: conhecimento pontual não é retrato da
//     conta, então não autoriza o corte do cachedOnly;
//   - o play que se apoiar no atalho e voltar não-ready grava o negativo
//     (`noteUnavailable`, mesma guarda do delete) e autocorrige na janela do
//     `DEBRID_AVAIL_NEG_TTL` — sem marcar `bad` e sem apagar o alive.
//
// Padrão de test/debrid-avail.test.ts: davail semeado pela checagem REAL sobre
// um adaptador fake no registry, `runtime.run` para o contexto de opts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import debrid from '../src/debrid/index.js';
import { peekDavail, noteUnavailable } from '../src/debrid/cache-check.js';
import { enrichInstantWithoutCacheCheck } from '../src/providers/debrid-pipeline-steps.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import { markReuploadBlocked, forgetReuploadBlock } from '../src/debrid/alldebrid-reupload.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as metrics from '../src/utils/metrics.js';
import * as cache from '../src/utils/cache.js';
import * as held from '../src/debrid/protected.js';
import * as runtime from '../src/runtime.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { testOpts } from './helpers/stub.js';
import type { DebridAdapter, Stream } from '../types/domain.js';

// runtime.run devolve unknown; o helper fixa o tipo do resultado sem inventar
// valor nenhum (mesmo padrão do debrid-avail).
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

interface CheckResult {
  cached: Set<string>;
  known: boolean;
}

const counter = (name: string) => metrics.snapshot().counters[name] ?? 0;

/** Muta campos de config.debrid e devolve o restaurador (save/restore). */
const withDebrid = (patch: Record<string, unknown>) => {
  const saved = Object.entries(patch).map(([k]) => [k, (config.debrid as Record<string, unknown>)[k]] as const);
  Object.assign(config.debrid, patch);
  return () => {
    for (const [k, v] of saved) (config.debrid as Record<string, unknown>)[k] = v;
  };
};

/** Adaptador fake cacheCheck:true; o handler decide a resposta da checagem. */
function makeAdapter(id: string, handler: (hashes: string[]) => unknown): DebridAdapter {
  return {
    id,
    label: `fake ${id}`,
    short: 'fk',
    cacheCheck: true,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[]) {
      return handler(infoHashes);
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;
}

function installInRegistry(id: string, adapter: DebridAdapter) {
  const original = debrid.BY_ID.get(id) as DebridAdapter | undefined;
  debrid.BY_ID.set(id, adapter);
  return () => {
    if (original) debrid.BY_ID.set(id, original);
    else debrid.BY_ID.delete(id);
  };
}

/**
 * Semeia o davail pela checagem REAL: o negativo (davail=0) e o positivo
 * (davail=1 + markAlive do próprio checkCached) nascem da mesma escrita da
 * camada, sem acoplar o teste ao formato interno da chave.
 */
async function seedDavail(adapterId: string, apiKey: string, hash: string, cached: boolean): Promise<CheckResult> {
  const restore = installInRegistry(adapterId, makeAdapter(adapterId, () => ({
    cached: new Set(cached ? [hash] : []),
    complete: true,
  })));
  try {
    return await runWith<CheckResult>(
      { opts: testOpts({ debridService: adapterId, debridApiKey: apiKey }), encoded: '' },
      () => debrid.checkCached([hash]),
    );
  } finally {
    restore();
  }
}

const streamFor = (hash: string) => ({ name: `Release ${hash.slice(0, 6)}`, infoHash: hash }) as Stream;

test('knob off (default): alive NÃO infla o cached', () => {
  const KEY = 'conta-alive-off';
  const HASH = 'a'.repeat(40);
  const restore = withDebrid({ aliveAsCache: false });
  try {
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    const antes = counter('debrid.instant.fromAliveAsCache');
    const adapter = makeAdapter('alldebrid', () => ({}));
    // O contrato é MUTAR o Set do chamador (dono do cached é o applyDebrid);
    // o retorno não expõe `cached` — a asserção é sobre o Set passado.
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.has(HASH), false, 'checagem é a autoridade; memória não infla com o knob off');
    assert.equal(result.accountKnown, false);
    assert.equal(result.cachedForAutofetch.has(HASH), false);
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes, 'knob off não conta histórico');
  } finally {
    restore();
  }
});

test('knob on + alive + sem davail: entra, mas accountKnown false e fora do cachedForAutofetch', () => {
  const KEY = 'conta-alive-on';
  const HASH = 'b'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true });
  try {
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    const antes = counter('debrid.instant.fromAliveAsCache');
    const adapter = makeAdapter('alldebrid', () => ({}));
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.has(HASH), true, 'o silêncio da checagem é onde a memória entra');
    assert.equal(result.accountKnown, false, 'histórico pontual não autoriza o corte cachedOnly');
    assert.equal(result.cachedForAutofetch.has(HASH), false, 'autofetch exige evidência medida, não memória');
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes + 1);
  } finally {
    restore();
  }
});

test('knob on + alive + davail=0 fresco: negativo medido vence', async () => {
  const KEY = 'conta-alive-neg';
  const HASH = 'c'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true, availNegTtl: 120 });
  try {
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    const check = await seedDavail('alldebrid', KEY, HASH, false);
    assert.equal(check.known, true);
    assert.equal(peekDavail('alldebrid', KEY, HASH), 0, 'a checagem mediu fora do cache');
    const antes = counter('debrid.instant.fromAliveAsCache');
    const adapter = makeAdapter('alldebrid', () => ({}));
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.has(HASH), false, 'negativo fresco bloqueia o atalho do alive');
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes);
  } finally {
    restore();
  }
});

test('knob on + checagem completa (known=true): bloco de sobra nem roda, com alive presente', () => {
  // Cenário real: davail=1 é colocado EM `cached` pela própria checagem, então
  // "alive + davail=1 fora do cached" é estruturalmente inatingível no pipeline.
  // O que este teste fixa é a guarda `!known`: checagem que respondeu COMPLETA
  // é autoridade — nem com knob ligado e hash alive a memória entra.
  const KEY = 'conta-alive-pos';
  const HASH = 'd'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true, availNegTtl: 120 });
  try {
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    const antes = counter('debrid.instant.fromAliveAsCache');
    const adapter = makeAdapter('alldebrid', () => ({}));
    const cached = new Set([HASH]);
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, true, KEY);
    assert.equal(cached.size, 1, 'nada a acrescentar: o hash já é cache confirmado');
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes, 'checagem completa não consulta o histórico');
    assert.equal(result.cachedForAutofetch.has(HASH), true, 'o que a checagem mediu o autofetch continua vendo');
  } finally {
    restore();
  }
});

test('knob on + sem alive: nada entra', () => {
  const KEY = 'conta-alive-ausente';
  const HASH = 'e'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true });
  try {
    const adapter = makeAdapter('alldebrid', () => ({}));
    const antes = counter('debrid.instant.fromAliveAsCache');
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.size, 0);
    assert.equal(result.accountKnown, false);
    assert.equal(result.cachedForAutofetch.size, 0);
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes);
  } finally {
    restore();
  }
});

test('knob on + cacheCheck:false: caminho existente do RD/DL inalterado', () => {
  const KEY = 'conta-alive-rd';
  const HASH = 'f'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true });
  try {
    magnetdb.markAlive('realdebrid', KEY, [HASH]);
    // Sem autofetchSource: o bloco de inventário nem roda — sobra exatamente o
    // caminho legado de histórico, que o knob novo não pode alterar.
    const adapter = {
      id: 'realdebrid',
      label: 'RD fake',
      short: 'rd',
      cacheCheck: false,
      keyUrl: '',
    } as unknown as DebridAdapter;
    const antes = counter('debrid.instant.fromHistory');
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.has(HASH), true, 'o ⚡ por histórico de play continua valendo');
    assert.equal(result.cachedForAutofetch.has(HASH), true, 'o snapshot pré-inflação é SÓ do bloco novo; o legado segue intocado');
    assert.equal(result.accountKnown, false);
    assert.equal(counter('debrid.instant.fromHistory'), antes + 1);
  } finally {
    restore();
  }
});

test('knob on + availNegTtl=0: guarda do negativo desligada, alive-⚡ aplica', () => {
  const KEY = 'conta-alive-negttl0';
  const HASH = '1'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true, availNegTtl: 0 });
  try {
    // Negativo "presente" na memória: com a guarda desligada ele não pode
    // vetar. Semente direta na chave — noteUnavailable não gravaria com TTL 0.
    cache.set(`${prefix('davail')}alldebrid:${accountScope(KEY)}:${HASH}`, 0, 60);
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    const antes = counter('debrid.instant.fromAliveAsCache');
    const adapter = makeAdapter('alldebrid', () => ({}));
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.has(HASH), true, 'sem guarda de negativo, o atalho é a melhor evidência que resta');
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes + 1);
  } finally {
    restore();
  }
});

test('knob on + alive + hash marcado "não re-subir" (8.14): o atalho não pinta ⚡', () => {
  // O registro `adrm` diz que a limpeza INTENCIONAL apagou o hash: a memória
  // de play não pode ressuscitá-lo como tocável — o enqueue dele já é recusado
  // e oferecer ⚡ seria prometer um play que o serviço não tem.
  const KEY = 'conta-alive-adrm';
  const HASH = '7'.repeat(40);
  const restore = withDebrid({ aliveAsCache: true });
  try {
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    assert.equal(
      markReuploadBlocked(accountScope(KEY), HASH, 'Old Foreign Movie 2019 TrueFrench 1080p'),
      true,
      'precondição: hash marcado como não re-subir',
    );
    const antes = counter('debrid.instant.fromAliveAsCache');
    const adapter = makeAdapter('alldebrid', () => ({}));
    const cached = new Set<string>();
    const result = enrichInstantWithoutCacheCheck(adapter, [streamFor(HASH)], cached, false, KEY);
    assert.equal(cached.has(HASH), false, 'hash apagado de propósito não recebe ⚡ do atalho');
    assert.equal(result.accountKnown, false);
    assert.equal(counter('debrid.instant.fromAliveAsCache'), antes, 'não conta como histórico aplicado');
  } finally {
    restore();
    forgetReuploadBlock(accountScope(KEY), HASH);
  }
});

test('noteUnavailable: davail=0 escopado por conta, sem bad e sem apagar alive', () => {
  const KEY = 'conta-note-unavail';
  const OUTRA = 'conta-note-unavail-b';
  const HASH = '2'.repeat(40);
  const restore = withDebrid({ availNegTtl: 120 });
  try {
    // Contrato da fachada: os dois nascem no cache-check e reaparecem nela.
    assert.equal(typeof debrid.noteUnavailable, 'function');
    assert.equal(typeof debrid.peekDavail, 'function');
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    assert.equal(peekDavail('alldebrid', KEY, HASH), null, 'sem registro ainda');
    noteUnavailable('alldebrid', KEY, HASH);
    assert.equal(peekDavail('alldebrid', KEY, HASH), 0, 'negativo gravado na conta que mediu não-ready');
    assert.equal(peekDavail('alldebrid', OUTRA, HASH), null, 'escopo por conta: a outra não herda o negativo');
    assert.equal(magnetdb.isAlive('alldebrid', KEY, HASH), true, 'o histórico permanece como memória');
    assert.equal(magnetdb.isBad('alldebrid', KEY, HASH), false, 'recusa no play não é NoVideoError');
  } finally {
    restore();
  }
});

// O resolveLink espera entre polls com timer unref(): sem handle vivo o loop
// esvazia no meio do teste (mesmo keepAlive do debrid-drop-uncached).
let keepAlive: NodeJS.Timeout;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

test('play AllDebrid não-ready grava o negativo junto do delete; hold preserva ambos', async () => {
  const KEY = 'conta-play-neg';
  const HELD_KEY = 'conta-play-neg-held';
  const HASH = '3'.repeat(40);
  const HELD_HASH = '4'.repeat(40);
  const IDS: Record<string, number> = { [HASH]: 901, [HELD_HASH]: 902 };
  const deleted: number[] = [];
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: unknown) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/upload')) {
      const hash = url.searchParams.get('magnets[]') || '';
      return body({ magnets: [{ hash, id: IDS[hash] ?? 999, status: 'Downloading' }] });
    }
    if (url.pathname.endsWith('/magnet/status')) {
      const id = Number(url.searchParams.get('id'));
      // 902 devolve sem info: resolveLink cai no ramo não-ready sem pagar os 3
      // polls de 700ms; 901 simula o torrent que nunca fica Ready.
      if (id === 902) return body({ magnets: null });
      return body({ magnets: { id, status: 'Downloading' } });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deleted.push(Number(url.searchParams.get('id')));
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  const restore = withDebrid({ aliveAsCache: true, availNegTtl: 120, dropUncached: true });
  try {
    // Parte A: sem proteção — delete E negativo na mesma guarda.
    magnetdb.markAlive('alldebrid', KEY, [HASH]);
    const link = await alldebrid.resolveLink(KEY, HASH);
    assert.equal(link, null, 'sem cache o play não resolve');
    assert.ok(deleted.includes(901), 'download fantasma removido da conta');
    assert.equal(peekDavail('alldebrid', KEY, HASH), 0, 'o atalho que errou grava o negativo e autocorrige');
    assert.equal(magnetdb.isAlive('alldebrid', KEY, HASH), true, 'negativo do play não apaga o histórico');
    assert.equal(magnetdb.isBad('alldebrid', KEY, HASH), false, 'não-ready não é play sem vídeo');

    // Parte B: hash segurado pelo autofetch — NENHUM dos dois efeitos.
    held.hold(HELD_HASH, 60, accountScope(HELD_KEY));
    await alldebrid.resolveLink(HELD_KEY, HELD_HASH);
    assert.ok(!deleted.includes(902), 'hold preserva o download em curso');
    assert.equal(peekDavail('alldebrid', HELD_KEY, HELD_HASH), null, 'mesma guarda do delete: protegido não grava negativo');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    held.release(HELD_HASH, accountScope(HELD_KEY));
    restore();
  }
});
