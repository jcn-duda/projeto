// Fachada de providers do processo Node. Depois do F4.4 o Node NÃO monta mais
// lista de streams: o pipeline (orquestrador, cache, builder e applyDebrid) saiu
// e o `/stream` é do gateway nativo. O que sobra aqui é o que outras rotas
// (painel, rotas internas do orquestrador Rust) ainda consomem:
//
// - `autofetchStatus`: snapshot do Chupim para o `/dashboard-status.json`;
// - cobertura de pool: leitura pura usada por rotas internas e testes;
// - observador da primeira resposta: tipo/helpers compartilhados com a coleta
//   (`/internal/search/collect`) — a contagem em si agora é do núcleo.
import { autofetchRunnerStatus } from './autofetch-runner.js';
import {
  firstObserverStep, createFirstObserver, firstObserverClaim, promoteFirstObserverEligible,
} from './first-observer.js';
import type { FirstObserverState } from './first-observer.js';
import { idxPoolCovered, poolCovered } from './search-pool-coverage.js';

/**
 * Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário.
 *
 * `searchesInFlight` saiu no F4.4: o contador era do cache de buscas do Node
 * (`search-cache`), que deixou de existir com o corte nativo.
 */
function autofetchStatus() {
  return autofetchRunnerStatus();
}

export {
  autofetchStatus, idxPoolCovered, poolCovered, firstObserverStep, createFirstObserver,
  firstObserverClaim, promoteFirstObserverEligible,
};
export type { FirstObserverState };
