// Despacho PARALELO entre sites (2026-09-30). O motor era serial — uma página
// de um site por vez, com pausa global — e o site passava quase todo o tempo
// esperando rede: medido na VPS, 9,5% de CPU e 379 MB de 3 GB com o raspador
// rodando. Agora até `CRAWL_MAX_PARALLEL` sites trabalham ao mesmo tempo, e
// cada um continua no PRÓPRIO ritmo (`delayMs` contra o `lastActiveAt` do site):
// nenhum site recebe mais requisições por minuto do que antes, só deixa de
// esperar o vizinho.
//
// Duas travas que o paralelo não pode furar:
//  - FAIXA DO FLARESOLVERR: ele atende UM pedido por vez e é o MESMO da busca
//    ao vivo. Sites que passam por ele (`CRAWL_FLARE_SITES`) nunca correm dois
//    ao mesmo tempo — senão a fila do Chromium atrasaria a busca do usuário;
//  - um site nunca corre em dobro: quem está em voo fica fora da escolha.
//
// A ESCOLHA continua sendo a do `selectNext` (classe, fome, justiça por
// `lastActiveAt`): o despacho só a repete enquanto houver vaga, tirando da
// disputa quem já foi escolhido, quem está em voo e quem ainda está no ritmo.
import type { CrawlerSiteConfig } from '../utils/crawler-live-schema.js';
import { assessSites, selectNext, type SelectDeps, type SiteCandidate } from './crawl-site-select.js';
import type { SiteRuntime } from './crawl-site-runtime.js';

export interface DispatchInput {
  ids: string[];
  inflight: ReadonlySet<string>;
  maxParallel: number;
  flareSites: ReadonlySet<string>;
  runtimeOf(id: string): SiteRuntime;
  configOf(id: string): CrawlerSiteConfig;
  deps: SelectDeps;
  now: number;
}

export interface DispatchResult {
  /** Sites a iniciar agora, na ordem da escolha. */
  chosen: SiteCandidate[];
  /** Avaliação de todos os sites fora de voo (para o motivo no painel). */
  all: SiteCandidate[];
  /** Sites com trabalho barrados SÓ pelo próprio ritmo. */
  paced: Set<string>;
}

/** O site já pode fazer a próxima requisição, pelo PRÓPRIO intervalo? */
function pacedOut(rt: SiteRuntime, cfg: CrawlerSiteConfig, now: number): boolean {
  return rt.lastActiveAt > 0 && now - rt.lastActiveAt < cfg.delayMs;
}

export function pickBatch(input: DispatchInput): DispatchResult {
  const { ids, inflight, flareSites, runtimeOf, configOf, deps, now } = input;
  const free = ids.filter((id) => !inflight.has(id));
  const all = assessSites(free, runtimeOf, configOf, deps, now);
  const paced = new Set(free.filter((id) => pacedOut(runtimeOf(id), configOf(id), now)));
  const chosen: SiteCandidate[] = [];
  const taken = new Set<string>();
  let flareTaken = [...inflight].some((id) => flareSites.has(id));
  let slots = Math.max(0, Math.trunc(input.maxParallel) - inflight.size);
  while (slots > 0) {
    const pool = free.filter((id) => !taken.has(id) && !paced.has(id) && !(flareTaken && flareSites.has(id)));
    if (pool.length === 0) break;
    const { chosen: next } = selectNext(pool, runtimeOf, configOf, deps, now);
    if (!next) break;
    chosen.push(next);
    taken.add(next.id);
    if (flareSites.has(next.id)) flareTaken = true;
    slots -= 1;
  }
  return { chosen, all, paced };
}
