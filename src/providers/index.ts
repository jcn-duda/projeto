// Fachada de providers do processo Node. Depois do F4.4 o Node NÃO monta mais
// lista de streams: o pipeline (orquestrador, cache, builder e applyDebrid) saiu
// e o `/stream` é do gateway nativo. O que sobra aqui é o que outras rotas
// (painel, rotas internas do orquestrador Rust) ainda consomem:
//
// - `autofetchStatus`: snapshot do Chupim para o `/dashboard-status.json`;
// - cobertura de índice (`idxPoolCovered`): leitura pura do colhedor e do
//   br-gap. O observador da primeira resposta e o `poolCovered` saíram: o
//   primeiro foi para o oráculo de teste, o segundo não tinha chamador.
import { autofetchRunnerStatus } from './autofetch-runner.js';
import { idxPoolCovered } from './search-pool-coverage.js';

/**
 * Snapshot local dos lotes; nunca devolve searchKey nem configuração do usuário.
 *
 * `searchesInFlight` saiu no F4.4: o contador era do cache de buscas do Node
 * (`search-cache`), que deixou de existir com o corte nativo.
 */
function autofetchStatus() {
  return autofetchRunnerStatus();
}

export { autofetchStatus, idxPoolCovered };
