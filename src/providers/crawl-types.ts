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
 *   `maxTries`, a URL dorme até o "Reprocessar erros" do painel.
 */
export type CrawlUrlStatus = 'pending' | 'inflight' | 'done' | 'no-torrent' | 'no-work' | 'error';

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

/** Resultado do processamento de UMA página pelo adaptador. */
export interface CrawlWorkResult {
  url: string;
  status: CrawlResultStatus;
  /** IMDb da página. Ausente/null = identificar depois (fase 2) ou ficou sem obra. */
  imdb?: string | null;
  title?: string;
  year?: number | null;
  type?: 'movie' | 'series';
  /** Releases válidas extraídas, no MESMO formato de item cru da busca. */
  releases?: RawItem[];
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
  /** Descoberta: URLs + lastmod + tipo. `since` filtra o incremental. */
  discover(since?: string | null): Promise<DiscoveredUrl[]>;
  /** Processa UMA página e devolve o resultado para o store gravar. */
  fetchWork(url: string): Promise<CrawlWorkResult>;
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
