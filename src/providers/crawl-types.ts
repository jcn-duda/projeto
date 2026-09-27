// Contrato do crawler dos sites BR (plano "Raspagem total dos sites BR",
// Fase 0 — base, SEM rede). O motor é genérico; quem sabe descobrir URLs e
// transformar uma página em releases é o ADAPTADOR de cada site. Nada aqui
// executa: são só os tipos compartilhados entre o motor (fase 3), os
// adaptadores (`crawl-sites/*`, fase 1), as regras puras e o armazenamento
// (`utils/crawl-store*.ts`) — todos importam daqui por `import type`, que é
// apagado na compilação, então não existe aresta de runtime entre as camadas.
//
// O `id` do site é o id do CARD do Jackett (`vacatorrent`, `nerdfilmes`,
// `bludv-cardigann`…): com isso ji/jl/prioridade, reserva por indexer falho e
// "vazio suspeito" tratam o item raspado como qualquer outro daquele site
// (decisão 3 do plano).
import type { RawItem } from '../../types/domain.js';

/** Tipo da página descoberta (padrão de URL do sitemap/listagem do site). */
export type CrawlPageKind = 'movie' | 'tv_show';

/**
 * Estados de uma URL no `crawl.db`:
 * - `pending`: elegível para o motor;
 * - `inflight`: reivindicada por `takeNext` (crash recupera com requeue);
 * - `done`: página lida e releases gravadas;
 * - `no-torrent`: página só de streaming (link `movie-links/<n>`), sem magnet;
 * - `no-work`: tem magnet, mas a obra não foi identificada — obra errada é
 *   pior que obra nenhuma, então NUNCA se chuta; aparece no painel;
 * - `error`: falha de rede/parse; `tries`/`next_at` com backoff e, esgotado o
 *   `maxTries`, a URL dorme até o "Reprocessar erros" do painel;
 * - `simulated`: página COM releases e obra identificada lida em dry-run — a
 *   leitura aconteceu, mas NADA foi gravado no acervo. Não é `done` (mentiria
 *   "gravado") nem volta a `pending` sozinha (perderia o registro da leitura).
 *   Quando o dry-run desliga (true→false), o motor reenfileira as `simulated`
 *   do site ANTES de processar (one-shot, ver `requeueSimulated`), para a
 *   carga não se perder — era isso que o `done` de dry-run escondia.
 */
export type CrawlUrlStatus = 'pending' | 'inflight' | 'done' | 'no-torrent' | 'no-work' | 'error' | 'simulated';

/** Resultado que o `markResult` aceita (`pending`/`inflight` são estados do
 * ciclo, nunca resultado de processamento). */
export type CrawlResultStatus = Exclude<CrawlUrlStatus, 'pending' | 'inflight'>;

/** Fase de uma rodada do motor: carga inicial ou acompanhamento periódico. */
export type CrawlRunPhase = 'initial' | 'incremental';

/** Uma URL achada na descoberta (sitemap/listagem), com o lastmod de origem. */
export interface DiscoveredUrl {
  url: string;
  /** lastmod do sitemap: é ele que decide reprocessar ou não (upsert idempotente). */
  lastmod: string;
  kind: CrawlPageKind;
}

/** Entrada de descoberta tal como o store recebe (alias de leitura no store). */
export type DiscoveredEntry = DiscoveredUrl;

/**
 * Resultado de uma rodada de descoberta. A lista plana escondia a descoberta
 * PARCIAL: sitemap que falhou tem URL ainda não vista cujo lastmod pode estar
 * exatamente dentro do pedaço perdido, então o motor (fase 3) NÃO pode
 * avançar o cursor incremental como se a rodada cobrisse tudo quando
 * `complete: false`. As `urls` parciais continuam válidas (o upsert do store
 * é idempotente); só o cursor não anda. Entrada REJEITADA por host safety não
 * é falha — ela é ruído determinístico, não conteúdo que pudesse ser lido.
 */
export interface CrawlDiscovery {
  urls: DiscoveredUrl[];
  /** `false` quando parte das fontes da descoberta falhou (fora do ar/desafio). */
  complete: boolean;
  /** Origem de cada falha (`<loc>: <motivo>`), para diagnóstico no painel. */
  failures: string[];
  /**
   * Completude POR KIND (F2): o sitemap de filme e o de série falham
   * independentemente, e o cursor de um tipo não pode ser refém da falha do
   * outro. Ausente = legado: o motor trata os dois kinds como `complete` geral.
   * Um kind sem fonte consultada (séries desligadas) sai `true` — sem URLs
   * dele o cursor simplesmente não anda.
   */
  completeByKind?: { movie: boolean; tv_show: boolean };
}

/** Limites de segurança do adaptador de série (Fase 7): teto de cards de
 * temporada visitados por página e de botões de download seguidos por página.
 * Séries explodem em requisições (página → season-internal → N cards → M
 * protetores), então os dois tetos são config do operador, com o custo REAL
 * de requisições medido em `CrawlWorkResult.requestCost` e cobrado no teto
 * horário do motor (ver `crawl-rate.ts`). */
export interface CrawlSeriesLimits {
  enabled: boolean;
  maxCards: number;
  maxButtons: number;
}

/** Opções da descoberta (a de série é gated por config). `sinceByKind` (F2:
 * cursor POR KIND) dá a cada tipo o seu lastmod de corte — filmes podem estar
 * incrementais enquanto séries começam a carga inicial, sem um apagar o
 * cursor do outro. O parâmetro `since` solto segue como fallback para quem
 * não manda o mapa. */
export interface CrawlDiscoverOptions {
  series?: CrawlSeriesLimits;
  sinceByKind?: { movie?: string | null; tv_show?: string | null };
}

/** Opções do processamento de UMA página (o tipo vem da fila, os limites da
 * config viva no snapshot do tick). */
export interface CrawlPageOptions extends CrawlDiscoverOptions {
  kind?: CrawlPageKind;
}

/** Grupo de releases por LOCALIZAÇÃO declarada da obra (Fase 7 séries). Uma
 * página de série produz releases de locações distintas (S/E, S, raiz) e cada
 * uma é gravada na chave do índice/banco que a cobre — nunca tudo na raiz. */
export interface CrawlReleaseGroup {
  season: number | null;
  episode: number | null;
  releases: RawItem[];
}

/** Resultado do processamento de UMA página pelo adaptador. */
export interface CrawlWorkResult {
  url: string;
  status: CrawlResultStatus;
  /**
   * IMDb da OBRA, ancorado na ficha técnica da página. `null` quando a página
   * não tem o link OU quando é ambíguo (duas fichas com tt distintos, tt solto
   * que pode ser de recomendação): obra errada é pior que obra nenhuma — o
   * chute vira identificação por título/ano (fase 2), nunca IMDb inválido.
   */
  imdb?: string | null;
  title?: string;
  year?: number | null;
  type?: 'movie' | 'series';
  /** Releases válidas extraídas, no MESMO formato de item cru da busca. */
  releases?: RawItem[];
  /**
   * Releases agrupadas por locação declarada (séries, Fase 7). Presente quando
   * a página produz locações distintas (S/E, S, raiz); cada grupo é gravado na
   * chave que o cobre. Ausente no caminho de filme (todo o lote na raiz).
   */
  groups?: CrawlReleaseGroup[];
  /**
   * Custo REAL de requisições HTTP da página (contagem medida no adaptador,
   * por HOP — redirect e salto de protetor contam cada um, ver
   * `TransportOptions.onRequest`). O motor cobra no teto por hora: 1 página de
   * série com 5 cards e 12 saltos NÃO é 1 request. Ausente = 1 (a página em
   * si). Erros TAMBÉM carregam o custo: a exceção pode vir com
   * `requestCost` anexado (helper `withRequestCost`) e o motor cobra o que foi
   * gasto antes de falhar.
   */
  requestCost?: number;
  /** Motivo do erro (`status: 'error'`); o painel agrupa por ele. */
  error?: string;
}

/**
 * Adaptador de um site. O motor cuida de fila, ritmo, pausa, retomada,
 * gravação e status; o adaptador só responde estas duas perguntas.
 */
export interface CrawlSite {
  /** id do card do Jackett (dedupe, métricas e `ji`/`jl` por site). */
  id: string;
  /** Rótulo humano para o painel. */
  label: string;
  /**
   * Descoberta: URLs + lastmod + tipo, com o sinal de parcialidade. Falha
   * TOTAL (índice ilegível, todas as fontes fora) continua sendo exceção —
   * é o motor que retenta; falha PARCIAL vem em `failures` com
   * `complete: false`. Séries só entram quando `opts.series.enabled`
   * (Fase 7: default seguro é NÃO descobrir tv_show).
   */
  discover(since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery>;
  /** Processa UMA página e devolve o resultado para o store gravar. */
  fetchWork(url: string, opts?: CrawlPageOptions): Promise<CrawlWorkResult>;
}

/** Uma URL na fila do site (linha de `crawl_url`). */
export interface CrawlUrlRow {
  site: string;
  url: string;
  lastmod: string;
  kind: CrawlPageKind;
  status: CrawlUrlStatus;
  /** IMDb resolvido da página; `null` enquanto não identificado. */
  imdb: string | null;
  /** Tentativas com erro; zera no sucesso, no lastmod novo e no reprocessar. */
  tries: number;
  /** Próxima tentativa elegível (epoch ms); 0 = já pode. */
  nextAt: number;
  /** Último toque do motor (claim ou resultado). */
  checkedAt: number;
  /** Releases válidas gravadas na última visita bem-sucedida. */
  releases: number;
  error: string;
  /** Quando a URL entrou na fila (ordem determinística do próximo pendente). */
  addedAt: number;
}

/** Uma rodada do motor (linha de `crawl_run`). */
export interface CrawlRunRow {
  id: number;
  site: string;
  phase: CrawlRunPhase;
  cursor: string;
  startedAt: number;
  finishedAt: number | null;
  counters: Record<string, number>;
}

/** Resultado do upsert idempotente: o que aconteceu com cada entrada. */
export interface UpsertReport {
  added: number;
  refreshed: number;
  unchanged: number;
}

/** Marcação de resultado aceita pelo store (formato plano, sem `RawItem`). */
export interface MarkResultInput {
  status: CrawlResultStatus;
  imdb?: string | null;
  /** Contagem de releases válidas gravadas nesta visita. */
  releases?: number;
  error?: string;
}

/** Opções do `markResult`: base do backoff e teto de tentativas do motor. */
export interface MarkOpts {
  retryBaseMs?: number;
  maxTries?: number;
}

/** Contadores de um site para o painel (progresso "x de N"). */
export interface SiteCounters {
  total: number;
  byStatus: Record<CrawlUrlStatus, number>;
}

/** Erros agrupados por motivo (o painel mostra o texto cru do último erro). */
export interface CrawlErrorGroup {
  /** Mensagem do erro, como gravada (`error` da linha). */
  reason: string;
  count: number;
}

/** Resultado do "Zerar site": só o estado daquele site em `crawl.db`. */
export interface ClearSiteReport {
  urls: number;
  runs: number;
}
