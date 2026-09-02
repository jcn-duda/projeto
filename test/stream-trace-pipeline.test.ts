// P5 Fase 0 — o ledger observacional atravessa o pipeline real. Mesmo padrão
// do notice-stream.test.ts: helper `build` com checkCached dublado, zero rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import { buildStreams, findStreams } from '../src/providers/index.js';
import { createStreamTrace, serializeTrace } from '../src/utils/stream-trace.js';
import type { StreamTraceState } from '../src/utils/stream-trace.js';
import debrid from '../src/debrid/index.js';
import * as magnetdb from '../src/utils/magnetdb.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import * as cache from '../src/utils/cache.js';
import { streamsCacheKey } from '../src/utils/request-key.js';
import { withMockFetch, fakeResponse } from './e2e/e2e-harness.js';
import type { RawItem, Stream } from '../types/domain.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

interface BuildOptions {
  season?: number | null;
  episode?: number | null;
  cached?: string[];
  cachedOnly?: boolean;
  minSeeders?: number;
  maxResults?: number;
}

/**
 * Mesmo contrato do helper do notice-stream: checkCached dublado, opts de
 * usuário determinísticos. A diferença é que a suíte CRIA o estado do ledger,
 * entrega ao buildStreams e lê o que os cortes registraram.
 */
async function build(raw: RawItem[], {
  season = 1, episode = 1, cached = [], cachedOnly = true, minSeeders = 1, maxResults = 40,
}: BuildOptions = {}): Promise<{ streams: Stream[]; trace: StreamTraceState; payload: ReturnType<typeof serializeTrace> }> {
  const originalCheck = debrid.checkCached;
  debrid.checkCached = async () => ({ cached: new Set(cached), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: cachedOnly,
    autoFetchBr: false,
    minSeeders,
    maxResults,
  };
  const trace = createStreamTrace();
  try {
    const streams = await runtime.run(
      { opts: userOpts, encoded: 'tracetest' },
      async () => buildStreams(raw, {
        meta: null,
        titles: null,
        season,
        episode,
        isDemo: false,
        searchKey: `trace-${Math.random()}`,
        trace,
      } as any),
    ) as Stream[];
    return { streams, trace, payload: serializeTrace(trace) };
  } finally {
    debrid.checkCached = originalCheck;
  }
}

const episodio = (hash: string, extra = {}) => ({
  title: 'Lost Girl S01E01 HDTV XviD',
  infoHash: hash,
  seeders: 3,
  indexer: 'thepiratebay',
  ...extra,
});

const conta = (motivo: string, itens: { reason: string }[]) =>
  itens.filter((item) => item.reason === motivo).length;

test('cachedOnly cortando tudo produz itens cached-only e raw > afterSort > final', async () => {
  // Um item abaixo do piso de seeders (min-seeders), dois tocáveis fora do
  // cache (cached-only). A lista entregue é o aviso: final=1.
  const { streams, trace, payload } = await build(
    [episodio(A, { seeders: 0 }), episodio(B), episodio(C)],
    { cached: [] },
  );

  assert.equal(trace.stages.raw, 3);
  assert.equal(trace.stages.afterSort, 2);
  assert.equal(trace.stages.final, 1, 'o aviso entra na contagem');
  assert.ok(trace.stages.raw > trace.stages.afterSort);
  assert.ok(trace.stages.afterSort > trace.stages.final);

  assert.equal(conta('cached-only', trace.items), 2, 'os dois fora do cache levam o motivo');
  assert.ok(trace.items.some((item) => item.reason === 'min-seeders'), 'o item abaixo do piso também');

  // O aviso de lista vazia é o stream entregue, e o trace o registra.
  assert.equal(streams.length, 1);
  assert.equal(streams[0].notice, true);
  assert.ok(trace.items.some((item) => item.reason === 'notice'));

  // Payload higieno: nada de hash de magnet, mesmo com infoHash no pipeline.
  assert.ok(payload);
  assert.doesNotMatch(JSON.stringify(payload), /[a-f0-9]{40}/);
});

test('com fonte em cache não há corte nenhum no ledger', async () => {
  const { streams, trace } = await build([episodio(A)], { cached: [A] });
  assert.equal(streams.length, 1);
  assert.ok(streams[0].infoHash || streams[0].url);
  assert.deepEqual(trace.stages, { raw: 1, afterSort: 1, final: 1 });
  assert.deepEqual(trace.items, [], 'nada caiu: nenhum item no ledger');
});

test('corte pré-checagem do debrid leva o motivo bad', async () => {
  // Histórico ruim nesta conta: o hash A provou não ter vídeo. O corte é
  // ANTES da checagem (pruneKnownBroken) — o motivo no ledger é 'bad', não
  // 'cached-only', e é exatamente essa distinção que o diagnóstico precisa.
  magnetdb.markBad('premiumize', 'chave-fake', A);
  try {
    const { trace } = await build([episodio(A)], { cached: [] });
    assert.ok(trace.items.some((item) => item.reason === 'bad'), 'pré-checagem registra bad');
    assert.equal(trace.stages.raw, 1);
    assert.equal(trace.stages.final, 1); // lista vazia → aviso
    assert.ok(trace.items.every((item) => item.reason !== 'cached-only'), 'o hash nem chegou à checagem');
  } finally {
    magnetdb.forgetBad('premiumize', 'chave-fake', A);
  }
});

test('dedupe de hash idêntico registra o perdedor', async () => {
  // Mesma hash em dois indexers: o merge fica com um, o perdedor vai pro
  // ledger como 'dedupe'.
  const { trace } = await build(
    [episodio(A, { indexer: 'x' }), episodio(A, { indexer: 'y', seeders: 10 })],
    { cached: [A] },
  );
  assert.ok(trace.items.some((item) => item.reason === 'dedupe'));
  assert.equal(trace.stages.final, 1);
});

test('teto maxResults corta o que não coube no corte final', async () => {
  const itens = Array.from({ length: 6 }, (_, i) =>
    episodio(String(i + 1).repeat(40), { seeders: 10 + i }));
  const { streams, trace } = await build(itens, { cached: itens.map((i) => i.infoHash), maxResults: 3 });
  assert.equal(streams.length, 3);
  assert.ok(conta('max-results', trace.items) >= 1, 'o excedente leva o motivo');
});

test('kill-switch desligado: a busca roda igual e o payload sai null', async () => {
  const original = config.search.streamTrace;
  config.search.streamTrace = false;
  try {
    const { streams, trace, payload } = await build([episodio(A)], { cached: [A] });
    assert.equal(streams.length, 1, 'a lista é idêntica com o ledger desligado');
    assert.deepEqual(trace.items, [], 'nenhuma captura');
    assert.equal(payload, null, 'serializeTrace devolve null com o kill-switch');
  } finally {
    config.search.streamTrace = original;
  }
});

// --- Contrato de gravação: o trace viaja no cache e sobrevive às reescritas ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('contrato: a promoção do passe tardio preserva o trace da primeira build', async () => {
  const id = `tt${Date.now()}5`;
  const saved = {
    replyDeadline: config.replyDeadline,
    ptSweep: config.jackett.ptSweepGlobal,
    releaseIndex: config.releaseIndex.enabled,
    apiKey: config.jackett.apiKey,
    indexers: config.jackett.indexers,
  };
  // O Jackett demora mais que a janela da coleta (piso de 500ms): a primeira
  // build sai PARCIAL com o trace do aviso, e a conclusão tardia — SEM
  // novidade nenhuma — PROMOVE a entrada. É o caminho em que o ledger morria:
  // o cache.set da promoção substitui a entrada inteira, e sem copiar
  // hit.trace o rastro da primeira build desaparecia.
  config.replyDeadline = 1200;
  config.jackett.ptSweepGlobal = false;
  config.releaseIndex.enabled = false;
  config.jackett.apiKey = 'trace-test-key';
  config.jackett.indexers = [];
  try {
    await withMockFetch([
      {
        // Endpoint agregado (/all, JSON): é o que jackett.search consulta com
        // a lista de indexers vazia. A resposta chega TARDIA e VAZIA — a
        // coleta fecha sem novidade nenhuma, então NENHUMA rebuild roda e a
        // única reescrita é a promoção do late (o caso exato da mão).
        match: '/indexers/all/results',
        handler: async () => {
          await sleep(1400);
          return fakeResponse({ Results: [] });
        },
      },
    ], async () => {
      const userOpts = { ...runtime.normalize(null), providers: ['jackett'], debridService: '', debridApiKey: '' };
      await runtime.run({ opts: userOpts, encoded: 'promotetest' }, async () => {
        const primeiro = await findStreams({ type: 'movie', id });
        assert.equal(primeiro.partial, true);
        const key = streamsCacheKey('movie', id, {
          ...runtime.opts(),
          resolveUncached: config.debrid.resolveUncached,
        });
        const parcial = cache.get(key) as { partial?: boolean; trace?: unknown } | null;
        assert.ok(parcial, 'a primeira build gravou a entrada');
        assert.equal(parcial?.partial, true);
        assert.ok(parcial?.trace, 'a primeira build gravou o trace');

        // A coleta fecha sem novidade e o late promove a entrada (~1.4s).
        await sleep(2600);
        const promovida = cache.get(key) as { partial?: boolean; trace?: unknown } | null;
        assert.ok(promovida);
        assert.equal(promovida?.partial, false, 'o passe tardio promoveu a entrada');
        assert.deepEqual(promovida?.trace, parcial?.trace, 'o ledger da primeira build sobrevive à promoção');
      });
    });
  } finally {
    config.replyDeadline = saved.replyDeadline;
    config.jackett.ptSweepGlobal = saved.ptSweep;
    config.releaseIndex.enabled = saved.releaseIndex;
    config.jackett.apiKey = saved.apiKey;
    config.jackett.indexers = saved.indexers;
    cache.clear();
  }
});

test('contrato: promoteCachedBolts preserva o trace ao reescrever a entrada', async () => {
  const key = 'streams:v10:promo-bolts';
  const trace = {
    startedAt: 1,
    finishedAt: 2,
    stages: { raw: 1, final: 1 },
    items: [{ id: 's1', reason: 'dedupe' as const, label: 'Rel', br: false }],
  };
  cache.set(key, {
    streams: [{ name: '[RD download] Filme\n1080p', url: `https://x/resolve/${'b'.repeat(40)}?sig=1` }],
    partial: false,
    debridKnown: true,
    trace,
  }, 900);
  const rdProbe = await import('../src/providers/rd-probe.js');
  const promovidos = rdProbe.promoteCachedBolts(key, ['b'.repeat(40)]);
  assert.equal(promovidos, 1);
  const entry = cache.get(key) as { trace?: unknown; streams?: Stream[] };
  assert.deepEqual(entry.trace, trace, 'o trace sobrevive ao spread da promoção');
  assert.match(String(entry.streams?.[0]?.name || ''), /⚡/);
  cache.forget(key);
});

test('entrada antiga sem o campo trace lê como null (rota não quebra)', () => {
  // Entrada gravada ANTES do campo existir: value.trace === undefined → o
  // serializeTrace da leitura devolve null e o endpoint segue de pé.
  assert.equal(serializeTrace(undefined), null);
});

// --- AllDebrid: o ledger não acrescenta NENHUMA chamada ao debrid -----------
//
// Na AllDebrid a checagem de cache É um upload e a limpeza deleta da conta —
// então "observacional" tem que ser provado, não afirmado. O pipeline roda
// duas vezes (trace ligado × kill-switch desligado) sobre o dublê da API e o
// tráfego registrado (uploads/status/deletes) tem que ser IGUAL: o ledger só
// lê o que o pipeline já calculou, nunca chama por conta própria.
//
// Os conjuntos de hashes são ISOMÓRFICOS (mesmo layout 1 pronto + 2 frios,
// hashes distintos) e não idênticos de propósito: a checagem não-abortável da
// AllDebrid coalesce o MESMO conjunto por 60s em memória de módulo
// (nonAbortableChecks, cache-check.ts) — rodada igual repetida seria servida
// pela promise da primeira e não provaria nada.
test('alldebrid: trace ligado x desligado produz o MESMO tráfego de conta', async () => {
  const { mockAd, inventario, soltaInventario, assenta } = await import('./helpers/alldebrid-mock.js');
  const { accountScope } = await import('../src/utils/request-key.js');
  const CHAVE = 'chave-ad-trace';
  const ACCOUNT = accountScope(CHAVE);
  const D = 'd'.repeat(40);
  const E = 'e'.repeat(40);
  const F = 'f'.repeat(40);
  const opts = () => ({
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: CHAVE,
    // setup-env pina DEBRID_CACHED_ONLY=false: sem este flag o corte
    // cachedOnly nem roda e o ledger não teria o que capturar.
    debridCachedOnly: true,
    autoFetchBr: false,
  });
  const trafego = (raws: RawItem[]) => {
    const pronto = String(raws[1].infoHash ?? '');
    const api = mockAd({ ready: pronto ? [pronto] : [], account: [] });
    return { api, raws };
  };
  const roda = async (raws: RawItem[], comTrace: boolean) => {
    const { api } = trafego(raws);
    const original = config.search.streamTrace;
    config.search.streamTrace = comTrace;
    try {
      const trace = createStreamTrace();
      const streams = await runtime.run(
        { opts: opts(), encoded: 'ad-trace' },
        async () => buildStreams(raws, {
          meta: null, titles: null, season: null, episode: null, isDemo: false,
          searchKey: `ad-trace-${Math.random()}`,
          trace,
        } as any),
      ) as Stream[];
      await assenta();
      return { api, streams, trace };
    } finally {
      config.search.streamTrace = original;
      soltaInventario(ACCOUNT);
      api.restore();
    }
  };
  try {
    cache.clear();
    inventario(ACCOUNT, []);
    const com = await roda([episodio(A), episodio(B), episodio(C)], true);
    assert.equal(com.api.uploaded.length, 3, 'a checagem da AllDebrid (upload) aconteceu');
    assert.ok(com.trace.items.some((item) => item.reason === 'cached-only'), 'o ledger capturou os cortes');

    cache.clear();
    inventario(ACCOUNT, []);
    const sem = await roda([episodio(D), episodio(E), episodio(F)], false);

    // Tráfego de conta IDÊNTICO em forma: mesmos uploads, mesmas leituras de
    // status, mesmos deletes da limpeza — o ledger NÃO é um consumidor novo da
    // AllDebrid (a checagem continua sendo o único toque na conta).
    assert.equal(sem.api.uploaded.length, com.api.uploaded.length, 'uploads (checagem) idênticos');
    assert.equal(sem.api.statusCalls, com.api.statusCalls, 'leituras de status idênticas');
    assert.equal(sem.api.deleted.length, com.api.deleted.length, 'deletes da limpeza idênticos');
    assert.equal(sem.streams.length, com.streams.length, 'lista final idêntica');
  } finally {
    cache.clear();
  }
});
