import { getPainelState, setPainelLoading, setPainelError, setPainelWarning, mergePainelPayload } from './store.js';
import { fetchStatus } from './api.js';

// `searchFirst` é o que alimenta o KPI I0 da aba Saúde: sem ele no pedido o
// bloco nunca chega e o painel mostra 0/0 como se não houvesse primeira
// resposta medida.
//
// `catalog` NÃO entra no vital: `catalogStatusEnv()` varre as linhas do
// catálogo (O(rows)) e o poll roda a cada refresh. A aba Limpeza carrega o
// relatório sob demanda pela ação `catalog-report`, que já existe.
//
// `indexers` entra porque a aba Saúde mostra o card por indexador. O loader do
// catálogo é memoizado por ciclo de requisição e compartilhado com o bloco
// `general` (que já o pede): o custo de Jackett extra é ZERO — é o mesmo
// `getIndexers()`, e sem o bloco o card ficaria sempre vazio.
//
// `magnetBank` entra porque o card do banco vivo mostra totais/fila. A leitura
// seria O(rows) (COUNT/MAX/GROUP BY) a cada ciclo, então ela é MEMOIZADA no
// backend por MAGNET_BANK_STATUS_TTL_MS (default 60s, invalidada a cada
// escrita): o poll repete a MESMA foto e a varredura não se repete. É o memo
// que torna este bloco vital — sem ele, o lugar seria o carregamento sob
// demanda do card (como `catalog`, O(rows) via `catalog-report`).
//
// `typesafe` alimenta a aba Jev (fila, orçamento e concordância das duas
// perguntas shadow): bloco barato — leitura O(1)/O(adapters) de snapshots em
// memória, sem rede e sem disco.
export const VITAL_BLOCKS = ['general', 'searchFirst', 'indexers', 'debrid', 'conta', 'gate', 'harvest', 'autofetch', 'f3', 'metrics', 'cache', 'magnetdb', 'magnetBank', 'typesafe'];

let inFlight = false;
let timerId: any = null;

export async function pollOnce(blocos: string[] = VITAL_BLOCKS): Promise<void> {
  const state = getPainelState();
  if (!state.token) return;
  if (inFlight) return; // Fila de 1 slot: descarta sobreposição para evitar 429 do gate

  inFlight = true;
  setPainelLoading(true);

  try {
    const res = await fetchStatus(state.token, blocos);
    if (res.ok) {
      mergePainelPayload(res.data);
    } else {
      // No 429, preserva os dados existentes e sai de `syncing` para `warn`:
      // a leitura NÃO completou, e um badge "SINCRONIZANDO..." eterno esconde
      // que o gate está recusando as consultas.
      if (res.status === 429) {
        setPainelWarning();
      } else {
        setPainelError(res.error);
      }
    }
  } finally {
    inFlight = false;
  }
}

export function startPolling(blocos: string[] = VITAL_BLOCKS): () => void {
  stopPolling();
  void pollOnce(blocos);

  const state = getPainelState();
  const intervalMs = Math.max(3000, (state.refreshRateS || 10) * 1000);

  timerId = setInterval(() => {
    void pollOnce(blocos);
  }, intervalMs);

  return stopPolling;
}

export function stopPolling(): void {
  if (timerId != null) {
    clearInterval(timerId);
    timerId = null;
  }
}
