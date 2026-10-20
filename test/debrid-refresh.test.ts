// Rodada 2: checagem ligada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import { applyDebrid } from './helpers/pipeline-oracle/index.js';

process.env.CACHE_PERSIST = 'false';


const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** Forma mínima do stream que o teste monta e inspeciona depois do applyDebrid. */
interface TestStream {
  infoHash: string;
  name: string;
  title: string;
}

const stream = (infoHash: string): TestStream => ({ infoHash, name: 'Release 1080p', title: 'Release 1080p' });

// runtime.run devolve unknown; o helper fixa o tipo do retorno sem mudar o teste.
const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

/**
 * O bug em produção: nenhum stream ganhava ⚡ na AllDebrid, e a lista sem raio
 * era cacheada como completa por CACHE_TTL. Duas metades, testadas separadas —
 * quem PRODUZ o pedido de refresh e quem o CONSOME.
 */

// --- Metade 1: o passo de resposta pergunta à AllDebrid. A consulta não pode
// ser abortada (checar é dar upload), então ela disputa o prazo sem cancelar o
// trabalho e sinaliza o que a checagem respondeu.

test('AllDebrid com orçamento suficiente checa na resposta e devolve ⚡', async () => {
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-que-toca-a-rede-de-proposito',
  };

  // Antes a AllDebrid pulava a consulta no passo de resposta (abortar depois do
  // upload perderia os ids da limpeza). Agora ela disputa o prazo sem ser
  // abortada: com orçamento acima do piso, a checagem REAL roda aqui e a
  // primeira lista já sai com ⚡. O dublê só faz a API responder em cache.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    assert.ok(
      String(url).includes('api.alldebrid.com'),
      'a checagem da AllDebrid roda no passo de resposta',
    );
    return {
      ok: true,
      json: async () => ({
        status: 'success',
        data: { magnets: [{ hash: A, ready: true }, { hash: B, ready: true }] },
      }),
    };
  }) as unknown as typeof globalThis.fetch;

  let flag = null;
  try {
    const result = await runWith<TestStream[]>({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        deadlineAt: Date.now() + 5000, // teto ativo = passo de resposta
        onCacheResult: (res: any) => {
          flag = res.needsFullRefresh;
        },
      } as any),
    );

    assert.equal(result.length, 2);
    for (const s of result) assert.match(s.name, /\[AD⚡\]/);
    assert.equal(flag, false, 'checagem confiável na resposta dispensa o refresh');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('checagem que falha na resposta mantém download e pede refresh', async () => {
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-falha-na-checagem',
  };

  // Falha REAL da checagem (serviço fora do ar), não mais o pulo deliberado: a
  // consulta correu e não respondeu, então "não perguntei" continua valendo —
  // ninguém recebe ⚡ falso e o refresh fica marcado para o passe tardio.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('simula serviço fora do ar');
  };

  let flag = null;
  try {
    const result = await runWith<TestStream[]>({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        deadlineAt: Date.now() + 5000,
        onCacheResult: (res: any) => {
          flag = res.needsFullRefresh;
        },
      } as any),
    );

    assert.equal(result.length, 2);
    for (const s of result) assert.match(s.name, /\[AD download\]/);
    assert.ok(!result.some((s) => s.name.includes('⚡')));
    assert.equal(flag, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('orçamento abaixo do piso não chama rede e pede refresh', async () => {
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-abaixo-do-piso',
  };

  // Orçamento (deadline − margem) entre 0 e o piso: a consulta não abortável só
  // atrasaria a resposta sem chance útil de vencer. Nenhuma rede, unknown, e o
  // refresh fica marcado para o passe tardio.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('abaixo do piso a checagem não pode tocar a rede');
  };

  let flag = null;
  try {
    const result = await runWith<TestStream[]>({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        deadlineAt: Date.now() + 700, // margem 500 → orçamento ≈ 200 < piso
        onCacheResult: (res: any) => {
          flag = res.needsFullRefresh;
        },
      } as any),
    );

    assert.equal(fetchCalls, 0, 'abaixo do piso a checagem nem começa');
    assert.equal(result.length, 2);
    for (const s of result) assert.match(s.name, /\[AD download\]/);
    assert.equal(flag, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('falha sem teto (passe tardio) mantém needsFullRefresh', async () => {
  const opts = {
    ...runtime.defaults(),
    debridService: 'alldebrid',
    debridApiKey: 'chave-falha-no-tardio',
  };

  // Passe tardio chama a checagem SEM teto dinâmico. Falha aí também é
  // `needsFullRefresh` — antes o refresh só era pedido quando o timeout
  // existia, e uma falha sem teto virava `debridKnown:true` no cache.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('simula serviço fora do ar no passe tardio');
  };

  let flag = null;
  try {
    const result = await runWith<TestStream[]>({ opts, encoded: 'ad-conf' }, () =>
      applyDebrid([stream(A), stream(B)], {
        // Sem deadlineAt: o passe tardio consulta com o timeout completo do adaptador.
        onCacheResult: (res: any) => {
          flag = res.needsFullRefresh;
        },
      } as any),
    );

    assert.equal(result.length, 2);
    for (const s of result) assert.match(s.name, /\[AD download\]/);
    assert.equal(flag, true, 'falha sem teto não pode virar "debridKnown:true"');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Fim da metade 1. As metades 2 e 3 (`debridRefreshSatisfied` e
// `streamsNeedRevalidation`) eram cascas do fim da busca do Node e saíram com o
// pipeline TS (F4.4). A régua equivalente vive no núcleo Rust
// (`adom_core::search_finish`); o oráculo do applyDebrid, que ainda importa,
// segue coberto aqui.
