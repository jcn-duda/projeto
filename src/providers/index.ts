// Fachada de providers do processo Node. Depois do F4.4 o Node NÃO monta mais
// lista de streams: o pipeline (orquestrador, cache, builder e applyDebrid) saiu
// e o `/stream` é do gateway nativo. O que sobra aqui é o que outras rotas
// (painel, rotas internas do orquestrador Rust) ainda consomem:
//
// - `autofetchStatus`: snapshot do Chupim para o `/dashboard-status.json`;
// - cobertura de índice (`idxPoolCovered`): leitura pura do colhedor e do
//   br-gap. O observador da primeira resposta e o `poolCovered` saíram: o
//   primeiro foi para o oráculo de teste, o segundo não tinha chamador.
import autofetchLive from '../utils/autofetch-live.js';
import * as autofetchTrace from '../utils/autofetch-trace.js';
import { obraSummaries } from './autofetch-obra-summary.js';
import { idxPoolCovered } from './search-pool-coverage.js';

/**
 * Snapshot local do Chupim; nunca devolve searchKey, conta nem apiKey.
 *
 * `searchesInFlight` saiu no F4.4: o contador era do cache de buscas do Node
 * (`search-cache`), que deixou de existir com o corte nativo.
 *
 * CORTE DO CHUPIM TS: `recheckLots`, `settleLots`, `lots`, `seasonSearchKeys`,
 * `skips`, `queues` e `budget` eram lidos do `autofetch-runner` em memória.
 * Com o runner fora, esses números são do worker nativo e chegam ao painel pelo
 * bloco `gateway` (`/autofetch` da admin). A foto do Node fica PARCIAL: só o
 * que o Node ainda é dono — config ao vivo, pausa, obras do teto e o trace de
 * skips. Campo ausente aqui significa "sem fonte no Node", nunca zero.
 */
function autofetchStatus() {
  // `cfg:v1:autofetch` ao vivo (defaults do .env + overrides do painel). É a
  // mesma leitura que o `autofetch.snapshot()` publica como `config`.
  const live = autofetchLive.snapshot();
  return {
    config: live,
    paused: live.paused,
    pausedSince: live.pausedSince,
    // Resumo por OBRA do teto (F2/F7): leitura quiet do L1, sem identidade.
    obras: obraSummaries(),
    // Por que o Chupim desistiu: últimos registros do trace em memória.
    lastSkips: autofetchTrace.lastSkips(20),
  };
}

export { autofetchStatus, idxPoolCovered };
