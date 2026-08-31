// Fase 8, item 8.14 — anti-reenchimento durável (`adrm:v1`).
//
// A checagem de cache da AllDebrid É um /magnet/upload: a limpeza intencional
// apaga um gringo e a busca seguinte re-sobe o MESMO hash só de perguntar se
// ele está em cache — a limpeza vira esteira. O marcador durável "não re-subir"
// fecha isso sem tocar o ⚡, sem tocar dropReady/dropUncached e sem bloquear o
// play explícito. A blindagem BR de 8.4 (`brOriginMark`) vive na ESCRITA: um
// falso positivo do marcador esconderia para sempre o acervo que a limpeza
// errou ao apagar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import * as metrics from '../src/utils/metrics.js';
import * as alldebrid from '../src/debrid/alldebrid.js';
import * as catalog from '../src/utils/catalog.js';
import {
  reuploadBlocked,
  markReuploadBlocked,
  forgetReuploadBlock,
} from '../src/debrid/alldebrid-reupload.js';

const adrmKey = (account: string, hash: string) => `${prefix('adrm')}${account}:${hash}`;
const counter = (name: string) => metrics.snapshot().counters[name] ?? 0;

// O config lê o .env do operador: o verde da suíte não pode depender de quem
// roda. O pin é o mesmo padrão do setup-env para knobs sensíveis.
config.debrid.reuploadBlock = true;
config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;

const KEY = 'chave-adrm-814';
const ACCOUNT = accountScope(KEY);
const BLOQUEADO = 'ab'.repeat(20);
const LIVRE = 'cd'.repeat(20);
const BR = 'ef'.repeat(20);
const LIXO = 'Old Movie 2019 TrueFrench 1080p WEBRip x264';

/** Muta campos de config.debrid e devolve o restaurador. */
const withDebrid = (patch: Record<string, unknown>) => {
  const saved = Object.entries(patch).map(([k]) => [k, (config.debrid as Record<string, unknown>)[k]] as const);
  Object.assign(config.debrid, patch);
  return () => {
    for (const [k, v] of saved) (config.debrid as Record<string, unknown>)[k] = v;
  };
};

interface MockOpts {
  /** Hashes que o /magnet/upload devolve prontos. */
  ready?: string[];
  /** Estado da conta para o /magnet/status (varreduras e inventário). */
  account?: any[];
  /** O /magnet/delete recusa (conta no teto devolve {status:"error"}). */
  failDelete?: boolean;
}

/**
 * Dublê da API v4.1: /magnet/upload (a própria checagem), /magnet/status
 * (inventário/varreduras) e /magnet/delete. `uploaded`/`deleted` são a prova
 * do que de fato trafegou.
 */
function mockAd({ ready = [], account = [], failDelete = false }: MockOpts = {}) {
  const uploaded: string[] = [];
  const deleted: Array<string | number> = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;

  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const body = (data: unknown) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/upload')) {
      const hashes = url.searchParams.getAll('magnets[]');
      uploaded.push(...hashes);
      return body({
        magnets: hashes.map((hash, i) => ({
          hash,
          ready: ready.includes(hash),
          id: account.find((m: any) => m.hash === hash)?.id ?? 700 + i,
        })),
      });
    }
    if (url.pathname.endsWith('/magnet/status')) {
      const id = url.searchParams.get('id');
      if (id != null) return body({ magnets: account.find((m: any) => m.id === Number(id)) ?? null });
      return body({ magnets: [...account] });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      const id = Number(url.searchParams.get('id'));
      deleted.push(id);
      if (failDelete) {
        // A AllDebrid responde 200 com {status:"error"} quando recusa — é como
        // uma conta no teto rejeita o delete sem devolver HTTP de erro.
        return {
          ok: true,
          async json() { return { status: 'error', error: { code: 'MAGNET_INVALID_ID', message: 'conta recusou' } }; },
        };
      }
      return body({ message: 'deleted' });
    }
    throw new Error(`URL inesperada no teste: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    uploaded,
    deleted,
    account,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

/** A limpeza do checkCached é disparada sem await: dá tempo de assentar. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let keepAlive: NodeJS.Timeout;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => clearInterval(keepAlive));

const limpar = (...hashes: string[]) => {
  for (const h of hashes) cache.forget(adrmKey(ACCOUNT, h));
};

// --- Roundtrip e blindagem BR ----------------------------------------------

test('8.14: roundtrip mark/block/forget sobre a chave adrm real', () => {
  metrics.reset();
  try {
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), false, 'sem marca, não bloqueia');
    assert.equal(markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO), true, 'grava e reporta a marca');
    assert.notEqual(cache.peek(adrmKey(ACCOUNT, BLOQUEADO)), null, 'registro sob o namespace adrm');
    assert.equal(reuploadBlocked(ACCOUNT, 'AB'.repeat(20)), true, 'leitura normaliza caixa');
    assert.equal(counter('debrid.reupload.marked'), 1);
    forgetReuploadBlock(ACCOUNT, BLOQUEADO);
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), false, 'expurgo libera o hash');
  } finally {
    limpar(BLOQUEADO);
    metrics.reset();
  }
});

test('8.14: origem BR (blindagem 8.4) NUNCA marca; estrangeiro provado marca', () => {
  metrics.reset();
  try {
    assert.equal(
      markReuploadBlocked(ACCOUNT, BR, 'Coração de Vingança 2019 Dublado 1080p'),
      false,
      'nome BR: o mark recusa',
    );
    assert.equal(reuploadBlocked(ACCOUNT, BR), false);
    assert.equal(counter('debrid.reupload.skippedBr'), 1, 'a recusa da blindagem é contada');
    assert.equal(markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO), true, 'estrangeiro provado marca');
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), true);
  } finally {
    limpar(BLOQUEADO, BR);
    metrics.reset();
  }
});

// --- Checagem de cache (o upload é a própria checagem) ----------------------

test('8.14: checkCached não envia hash bloqueado, envia o não bloqueado', async () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  metrics.reset();
  const api = mockAd({ ready: [LIVRE] });
  try {
    const result = await alldebrid.checkCached(KEY, [BLOQUEADO, LIVRE]);
    assert.ok(api.uploaded.includes(LIVRE), 'o não bloqueado vai ao /magnet/upload');
    assert.ok(!api.uploaded.includes(BLOQUEADO), 'o bloqueado fica fora da checagem');
    assert.equal(result.cached.has(LIVRE), true);
    assert.equal(result.cached.has(BLOQUEADO), false, 'bloqueado não vira ⚡');
    assert.equal(result.complete, true);
    assert.equal(counter('debrid.reupload.blocked'), 1, 'a re-entrada evitada é contada');
  } finally {
    api.restore();
    limpar(BLOQUEADO);
    metrics.reset();
  }
});

test('8.14: todos bloqueados → Set vazio CONHECIDO (apagado de propósito)', async () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  const api = mockAd({});
  try {
    const result = await alldebrid.checkCached(KEY, [BLOQUEADO]);
    assert.equal(api.uploaded.length, 0, 'nenhum upload');
    assert.equal(result.cached.size, 0);
    assert.equal(result.complete, true, 'vazio intencional, não degradação');
  } finally {
    api.restore();
    limpar(BLOQUEADO);
  }
});

// --- Enqueue do autofetch ---------------------------------------------------

test('8.14: enqueue de hash bloqueado não faz fetch; o livre segue', async () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  metrics.reset();
  const api = mockAd({});
  try {
    assert.equal(await alldebrid.enqueue(KEY, BLOQUEADO), false, 'recusa sem tocar a rede');
    assert.equal(api.uploaded.length, 0, 'nenhum upload do chupim');
    assert.equal(counter('debrid.reupload.blocked'), 1);
    assert.equal(await alldebrid.enqueue(KEY, LIVRE), true, 'hash livre enfileira normal');
    assert.deepEqual(api.uploaded, [LIVRE]);
  } finally {
    api.restore();
    limpar(BLOQUEADO);
    metrics.reset();
  }
});

// --- Kill-switch e TTL 0 ----------------------------------------------------

test('8.14: kill-switch desliga gravação E leitura; reativado, registro volta a valer', () => {
  markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO);
  assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), true, 'precondição: marcado');
  const restore = withDebrid({ reuploadBlock: false });
  try {
    assert.equal(markReuploadBlocked(ACCOUNT, LIVRE, LIXO), false, 'nada é gravado');
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), false, 'leitura desligada');
    assert.equal(reuploadBlocked(ACCOUNT, LIVRE), false);
  } finally {
    restore();
  }
  assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), true, 'reativado, o registro antigo volta a bloquear');
  limpar(BLOQUEADO);
});

test('8.14: TTL 0 desliga o bloqueio inteiro (gravação e leitura)', () => {
  const restore = withDebrid({ alldebridReuploadBlockTtlMs: 0 });
  try {
    assert.equal(markReuploadBlocked(ACCOUNT, BLOQUEADO, LIXO), false, 'TTL 0 não grava');
    assert.equal(reuploadBlocked(ACCOUNT, BLOQUEADO), false);
  } finally {
    restore();
  }
  // Registro pré-existente (TTL mudou depois de gravar): leitura também off.
  cache.set(adrmKey(ACCOUNT, LIVRE), { at: Date.now() }, 3600);
  const restoreTtl = withDebrid({ alldebridReuploadBlockTtlMs: 0 });
  try {
    assert.equal(reuploadBlocked(ACCOUNT, LIVRE), false, 'registro órfão não bloqueia com TTL 0');
  } finally {
    restoreTtl();
    limpar(LIVRE);
  }
});

// --- deleteMagnets: removedIds ----------------------------------------------

test('8.14: deleteMagnets retorna removedIds; falha de delete não vira removido', async () => {
  const api = mockAd({});
  try {
    const ok = await alldebrid.deleteMagnets(KEY, [321, 654]);
    assert.deepEqual([...ok.removedIds ?? []].sort(), [321, 654], 'sucesso lista os ids que saíram');
    assert.equal(ok.falhas.length, 0);
  } finally {
    api.restore();
  }
  const apiFalha = mockAd({ failDelete: true });
  try {
    const res = await alldebrid.deleteMagnets(KEY, [999]);
    assert.equal((res.removedIds ?? []).length, 0, 'falha não lista removido');
    assert.equal(res.falhas.length, 1);
  } finally {
    apiFalha.restore();
  }
});

// --- sweepUndubbed marca SÓ deleção intencional bem-sucedida ----------------

const velhoSec = Math.floor(Date.now() / 1000) - 10 * 24 * 3600;
const SETE_DIAS = 7 * 24 * 3600 * 1000;
const ACERVO_FALHA = 'b1'.repeat(20);

test('8.14: sweepUndubbed bem-sucedida marca o hash apagado', async () => {
  const CHAVE = 'chave-adrm-sweep-ok';
  const CONTA = accountScope(CHAVE);
  const ACERVO = 'a1'.repeat(20);
  const LIXO_HASH = 'a2'.repeat(20);
  // Só o acervo no primeiro snapshot; o lixo entra depois (simula upload do
  // addon pós-snapshot) — é o que o torna candidato à varredura.
  const api = mockAd({
    account: [
      { id: 1, hash: ACERVO, status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
    ],
  });
  metrics.reset();
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();
    api.account.push(
      { id: 2, hash: LIXO_HASH, status: 'Ready', filename: LIXO, uploadDate: velhoSec },
    );
    const r = await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.equal(r.varridos, 1);
    assert.deepEqual([...api.deleted], [2], 'só o lixo estrangeiro sai');
    assert.equal(reuploadBlocked(CONTA, LIXO_HASH), true, 'o que saiu fica marcado');
    assert.equal(reuploadBlocked(CONTA, ACERVO), false, 'o acervo não é marcado');
  } finally {
    api.restore();
    cache.forget(adrmKey(CONTA, LIXO_HASH));
    metrics.reset();
  }
});

test('8.14: sweepUndubbed com delete recusado NÃO marca (o magnet continua lá)', async () => {
  const CHAVE = 'chave-adrm-sweep-falha';
  const CONTA = accountScope(CHAVE);
  const LIXO_HASH = 'b2'.repeat(20);
  const api = mockAd({
    failDelete: true,
    account: [
      { id: 1, hash: ACERVO_FALHA, status: 'Ready', filename: 'Acervo Dublado do Usuário', uploadDate: velhoSec },
    ],
  });
  try {
    await alldebrid.warmInventory(CHAVE);
    await settle();
    api.account.push(
      { id: 2, hash: LIXO_HASH, status: 'Ready', filename: LIXO, uploadDate: velhoSec },
    );
    await alldebrid.sweepUndubbed(CHAVE, { minAgeMs: SETE_DIAS });
    assert.ok(api.deleted.includes(2), 'houve tentativa de delete');
    assert.equal(reuploadBlocked(CONTA, LIXO_HASH), false, 'falha de delete não marca');
  } finally {
    api.restore();
  }
});

test('8.14: dropReady/dropUncached da checagem NÃO marcam (higiene ≠ decisão)', async () => {
  const CHAVE = 'chave-adrm-drop-nao-marca';
  const CONTA = accountScope(CHAVE);
  const FRIO = 'c1'.repeat(20);
  const api = mockAd({ ready: [] });
  try {
    await alldebrid.checkCached(CHAVE, [FRIO]);
    await settle();
    assert.equal(api.deleted.length, 1, 'o não-cacheado saiu da conta (dropUncached)');
    assert.equal(reuploadBlocked(CONTA, FRIO), false, 'rotina de higiene não grava marcador');
  } finally {
    api.restore();
  }
});

// --- Gancho do catálogo (applyDeletions) ------------------------------------

test('8.14: applyDeletions dispara onDeleted só em delete bem-sucedido', async () => {
  const chamados: Array<[string, string | undefined]> = [];
  const deletions = [
    { serviceId: 5, hash: 'd1'.repeat(20), reason: 'duplicado', filename: LIXO },
    { serviceId: 6, hash: 'd2'.repeat(20), reason: 'duplicado', filename: LIXO },
    // T1: mesmo hash sobrevive em outro service_id. O delete é real e ganha
    // tombstone, mas NÃO pode marcar adrm — esconderia o ⚡ do sobrevivente.
    { serviceId: 7, hash: 'd3'.repeat(20), reason: 'duplicado', filename: LIXO, skipMark: true },
  ];
  // Ids 5/7 saem (constam em removedIds); id 6 o executor recusa.
  const executor = async (ids: Array<string | number>) =>
    ids.includes(5) || ids.includes(7)
      ? { ok: 1, falhas: [], removedIds: ids }
      : { ok: 0, falhas: [{ message: 'recusado' }] };
  const res = await catalog.applyDeletions(ACCOUNT, 'alldebrid', deletions, executor, {
    onDeleted: (hash, filename) => chamados.push([hash, filename]),
  });
  assert.deepEqual([res.ok, res.falhas], [2, 1]);
  assert.equal(chamados.length, 1, 'falha e T1/skipMark não disparam o hook');
  assert.equal(chamados[0][0], 'd1'.repeat(20));
  assert.equal(chamados[0][1], LIXO);
});
