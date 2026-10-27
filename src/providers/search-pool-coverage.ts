/**
 * Casca fina de `search-pool-coverage` — a decisão vive em
 * `adom_core::search_pool_coverage` (napi `idxPoolCovered`; o `poolCovered` do
 * núcleo segue no napi, sem chamador no Node desde que o build saiu do TS).
 *
 * POR QUÊ (as decisões medidas que o núcleo preserva):
 *
 * - Cobertura é por POOL, nunca contagem pura: BR dublado → global dublado →
 *   melhor swarm saudável, a MESMA noção do autofetch. Tudo isso mora no núcleo;
 *   aqui só entram os itens e o piso de seeders lido da config viva (o
 *   `poolCovered` do TS lia `autofetchLive.effective().autoFetchMinSeeders`
 *   dentro da função — o núcleo não conhece config, então o número viaja).
 * - "Índice cobre" NUNCA é contagem pura: uma temporada indexada só com
 *   legendado não pode impedir a busca BR dublada de rodar. E, em busca de
 *   EPISÓDIO, pack de temporada não decide sozinho — o caso medido "True
 *   Detective 2ª Temporada [1080p DUBLADO 22.41 GB]" sustentava S02E01 e o
 *   dublado DO EPISÓDIO nunca aparecia. O pack continua ENTRANDO na lista (é
 *   fonte tocável); ele só não manda o Jackett para o tail.
 * - O registro do Chupim (`source === 'autofetch'`) prova que escolhemos uma
 *   release, não que o índice tem material — fica fora da cobertura.
 * - `search.idx.packOnly` é MÉTRICA (efeito): o núcleo devolve o flag
 *   `packOnly` e esta casca conta, respeitando `countMetrics:false` (via
 *   instantânea do banco, cujo dado não é do índice).
 */
import autofetchLive from '../utils/autofetch-live.js';
import * as metrics from '../utils/metrics.js';
import { nativeCore } from '../utils/native-core.js';

/** Superfície do núcleo que esta casca consome. */
interface PoolCoverageCore {
  idxPoolCovered(
    releasesJson: string,
    season: number | null,
    episode: number | null,
    minSeeders: number,
  ): string;
}

function core(): PoolCoverageCore {
  return nativeCore<PoolCoverageCore>();
}

/**
 * "Índice cobre" com as releases do índice (ver o cabeçalho do módulo).
 */
export function idxPoolCovered(
  releases: any[],
  { season = null, episode = null, countMetrics = true }: { season?: number | null; episode?: number | null; countMetrics?: boolean } = {},
) {
  const out = JSON.parse(core().idxPoolCovered(
    JSON.stringify(releases),
    season ?? null,
    episode ?? null,
    autofetchLive.effective().autoFetchMinSeeders,
  )) as { covered: boolean; packOnly: boolean };
  // `countMetrics:false` mantém o funil `search.idx` limpo quando quem pergunta
  // é a via instantânea do banco (o dado não é do índice).
  if (out.packOnly && countMetrics) metrics.count('search.idx.packOnly');
  return out.covered;
}
