// A checagem de cache é o único ponto que lê a lista de arquivos dos packs
// (AllDebrid /magnet/status, TorBox list_files), e é dela que sai o tamanho
// exato do episódio ou do filme dentro de uma coleção.
//
// Medido em Star Trek (2009), 2026-09-13: a coleção pronta vinha do davail e a
// checagem não abortável (caminho da AllDebrid) nem repassava `fileHashes` —
// zero leituras de arquivo, e a lista ficava com o total da coleção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import debrid from '../src/debrid/index.js';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import * as metrics from '../src/utils/metrics.js';
import { accountScope } from '../src/utils/request-key.js';
import { checkCached as alldebridCheckCached } from '../src/debrid/alldebrid-check.js';
import { peekFileSizes, clearFileSizes } from '../src/debrid/file-sizes.js';
import { withDebrid, inventario, soltaInventario } from './helpers/alldebrid-mock.js';
import type { DebridAdapter } from '../types/domain.js';

interface CheckResult {
  cached: Set<string>;
  known: boolean;
}

test('pack sem arquivos servido pelo L1 volta ao serviço e a AllDebrid recebe fileHashes', async () => {
  const calls: Array<{ hashes: string[]; options?: { timeoutMs?: number; fileHashes?: string[] } }> = [];
  const adapter = {
    id: 'premiumize',
    label: 'AllDebrid-like fake',
    short: 'ad',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[], options?: { timeoutMs?: number; fileHashes?: string[] }) {
      calls.push({ hashes: [...infoHashes], ...(options ? { options } : {}) });
      return { cached: new Set(infoHashes), complete: true };
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: `chave-fake-file-refetch-${process.pid}` };
  const run = (hashes: string[], options?: { timeoutMs?: number; fileHashes?: string[] }) =>
    runtime.run({ opts, encoded: '' }, () => debrid.checkCached(hashes, options)) as Promise<CheckResult>;
  try {
    await run(['colecao-pronta', 'outro-hash']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.fileHashes, undefined, 'sem pack pendente não vai lista de arquivos');
    assert.equal(calls[0].options?.timeoutMs, undefined, 'sem teto dinâmico não vai teto');

    const semPack = await run(['colecao-pronta']);
    assert.equal(calls.length, 1, 'sem fileHashes o L1 responde sozinho');
    assert.deepEqual([...semPack.cached], ['colecao-pronta']);

    const comPack = await run(['colecao-pronta'], { fileHashes: ['colecao-pronta'] });
    assert.equal(calls.length, 2, 'o pack sem arquivos volta ao serviço mesmo com positivo no L1');
    assert.deepEqual(calls[1].hashes, ['colecao-pronta']);
    assert.deepEqual(calls[1].options?.fileHashes, ['colecao-pronta'], 'a checagem não abortável repassa fileHashes');
    assert.deepEqual([...comPack.cached], ['colecao-pronta']);
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('o orçamento dinâmico chega como fileWaitTimeoutMs, nunca como timeoutMs de rede', async () => {
  // Revisão 2026-09-14 (2ª rodada): repassar `timeoutMs` ao adaptador tornava
  // abortável o upload da AllDebrid — trabalho que deve seguir após a corrida.
  // O orçamento dinâmico viaja SÓ como `fileWaitTimeoutMs`.
  const calls: Array<{ options?: { timeoutMs?: number; fileWaitTimeoutMs?: number; fileHashes?: string[] } }> = [];
  const adapter = {
    id: 'premiumize',
    label: 'AllDebrid-like fake',
    short: 'ad',
    cacheCheck: true,
    abortSafeCacheCheck: false,
    keyUrl: 'https://x.test',
    async checkCached(_apiKey: string, infoHashes: string[], options?: { timeoutMs?: number; fileWaitTimeoutMs?: number; fileHashes?: string[] }) {
      calls.push({ ...(options ? { options } : {}) });
      return { cached: new Set(infoHashes), complete: true };
    },
    async resolveLink() {
      return null;
    },
  } as unknown as DebridAdapter;
  const original = debrid.BY_ID.get('premiumize') as DebridAdapter;
  debrid.BY_ID.set('premiumize', adapter);
  const opts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: `chave-fake-teto-${process.pid}` };
  const run = (hashes: string[], options?: { timeoutMs?: number; fileHashes?: string[] }) =>
    runtime.run({ opts, encoded: '' }, () => debrid.checkCached(hashes, options)) as Promise<CheckResult>;
  try {
    const com = await run(['teto-pack-1'], { timeoutMs: 2000, fileHashes: ['teto-pack-1'] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.timeoutMs, undefined, 'NENHUM timeoutMs de rede chega ao adaptador não abortável');
    assert.equal(
      calls[0].options?.fileWaitTimeoutMs,
      2000 - config.debrid.packFilesWaitMarginMs,
      'o orçamento chega como fileWaitTimeoutMs, com a margem deduzida',
    );
    assert.deepEqual(calls[0].options?.fileHashes, ['teto-pack-1'], 'fileHashes continua indo junto');
    assert.deepEqual([...com.cached], ['teto-pack-1']);

    const tardio = await run(['teto-pack-2']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options?.timeoutMs, undefined, 'passe tardio não inventa teto');
    assert.equal(calls[1].options?.fileWaitTimeoutMs, undefined, 'passe tardio não inventa orçamento de espera');
    assert.deepEqual([...tardio.cached], ['teto-pack-2']);
  } finally {
    debrid.BY_ID.set('premiumize', original);
  }
});

test('leitura de pack pode ultrapassar o prazo sem cancelar e sem antecipar a limpeza', async () => {
  // A espera da leitura fica dentro do `timeoutMs` da checagem (fail-open), mas
  // a leitura NÃO é cancelada e a limpeza só corre no FIM dela — nunca antes,
  // e nunca depois do scheduleEvict/scheduleReconcile (agendados sincronamente
  // na volta da checagem, antes do await da espera).
  clearFileSizes();
  const KEY = `chave-leitura-prazo-${process.pid}`;
  const ACCOUNT = accountScope(KEY);
  const PACK = 'e7'.repeat(20);
  const GB = 1024 ** 3;
  const ordem: string[] = [];
  const deletedIds: Array<string | number> = [];
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    const ok = (data: unknown) => ({ ok: true, async json() { return { status: 'success', data }; } });
    if (url.pathname.endsWith('/magnet/upload')) {
      return ok({ magnets: [{ hash: PACK, ready: true, id: 900 }] });
    }
    if (url.pathname.endsWith('/magnet/status')) {
      if (url.searchParams.get('id') != null) {
        await delay(150); // leitura de arquivos LENTA: ultrapassa o prazo de 40ms
        ordem.push('leitura');
        return ok({
          magnets: [{
            id: 900,
            hash: PACK,
            status: 'Ready',
            files: [{ n: 'Obra', e: [{ n: 'Obra/Star.Trek.2009.1080p.DUAL.mkv', s: 2.1 * GB, l: 'http://ad/l1' }] }],
          }],
        });
      }
      return ok({ magnets: [] });
    }
    if (url.pathname.endsWith('/magnet/delete')) {
      deletedIds.push(Number(url.searchParams.get('id')));
      ordem.push('delete');
      return ok({ message: 'deleted' });
    }
    throw new Error(`URL inesperada: ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
  const restaurarConfig = withDebrid({ dropReady: true, dropUncached: true, evictPerSearch: false });
  inventario(ACCOUNT, []); // autoridade para o dropReady (e hadInventory → sem skipReadyDrop)
  try {
    metrics.reset();
    const inicio = Date.now();
    const result = await alldebridCheckCached(KEY, [PACK], { fileWaitTimeoutMs: 40, fileHashes: [PACK] });
    const decorrido = Date.now() - inicio;
    assert.equal(result.complete, true);
    assert.ok(result.cached.has(PACK), 'o ⚡ sai mesmo com a leitura ainda em fundo');
    assert.ok(decorrido < 120, `a checagem não espera a leitura de 150ms (voltou em ${decorrido}ms)`);
    assert.equal(ordem.filter((e) => e === 'delete').length, 0, 'a limpeza não é antecipada pela espera');
    const base = metrics.snapshot().counters['debrid.packFiles.waitDeadline'] ?? 0;
    assert.ok(base >= 1, 'o prazo perdido da espera fica medido');
    // A leitura segue em fundo (não abortável) e a limpeza só depois dela.
    const teto = Date.now() + 5000;
    while (Date.now() < teto && !ordem.includes('delete')) await delay(50);
    assert.deepEqual(ordem, ['leitura', 'delete'], 'delete só DEPOIS da leitura terminar');
    assert.deepEqual(deletedIds, [900]);
    assert.ok(peekFileSizes(PACK), 'a leitura não cancelada gravou o fsz para a reanotação');

    // restante <= 0: sem espera, mas a cadeia da leitura fica consumida (sem
    // rejeição unhandled) e a checagem responde normalmente.
    const resZero = await alldebridCheckCached(KEY, [PACK], { fileWaitTimeoutMs: 0, fileHashes: [PACK] });
    assert.ok(resZero.cached.has(PACK), 'orçamento zero degrada a espera sem quebrar a checagem');
    await delay(250); // a leitura em fundo assenta; um reject solto acusaria aqui
  } finally {
    restaurarConfig();
    soltaInventario(ACCOUNT);
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
    clearFileSizes();
  }
});
