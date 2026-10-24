// Dublê da ponte com o colhedor NATIVO (`/harvest/*` do `adom-server`).
//
// O worker, a fila e o dedupe moram no Rust. O que o Node ainda faz é mandar
// pedidos (fire-and-forget) e ler o `pending`; por isso o dublê responde só as
// três rotas que o processo TS toca — enqueue, pending e a invalidação de obra
// que o `finalizeBrProbe` dispara — e devolve 404 em qualquer outra para o teste
// falhar alto em vez de receber corpo mentiroso.
import { flushPendingHarvest } from '../../src/utils/harvest-native.js';
import { stubFetch, type FetchStub } from './stub.js';

export type HarvestBridgeAnswers = {
  /** `accepted` do `POST /harvest/enqueue`. `false` simula dedupe/recusa. */
  accepted?: boolean;
  /** `queued` do `GET /harvest/pending`. */
  queued?: boolean;
  /** `brProbe` do `GET /harvest/pending` (a entrada é uma sonda?). */
  brProbe?: boolean;
};

/**
 * Instala o dublê e devolve o handle. O `restore` é obrigatório no `finally`:
 * o `fetch` é global e um dublê vazado contamina o próximo teste.
 */
export function stubHarvestBridge(answers: HarvestBridgeAnswers = {}): FetchStub {
  return stubFetch((rawUrl) => {
    if (rawUrl.endsWith('/harvest/enqueue')) {
      const accepted = answers.accepted !== false;
      return { ok: true, status: 200, json: async () => ({ accepted, reason: accepted ? 'queued' : 'dedupe' }) };
    }
    if (rawUrl.includes('/harvest/pending')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ queued: answers.queued !== false, brProbe: answers.brProbe !== false }),
      };
    }
    if (rawUrl.endsWith('/streams/invalidate')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, removed: 0 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Chamadas de enfileiramento capturadas — a prova de que o pedido saiu (ou não). */
export function enqueueCalls(stub: FetchStub) {
  return stub.calls.filter((call) => call.url.endsWith('/harvest/enqueue'));
}

/**
 * A confirmação do `pending` é agendada 250 ms depois do POST (a ponte é
 * fire-and-forget): espera o timer e drena os pedidos em voo para o teste não
 * deixar fetch vivo fora do dublê.
 */
export async function settleProbe(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 320));
  await flushPendingHarvest();
}
