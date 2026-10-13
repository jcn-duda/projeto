// Contexto e classificadores de falha do ramo de SÉRIE do VacaTorrent.
//
// Extraído de `vaca-series.ts` pela catraca de linhas (400): o consumidor
// continua importando de `vaca-series.ts` (reexport mantém a API). Aqui só
// moram o contrato do contexto e os testes de string sobre mensagens de erro —
// nada de rede, nada de estado.
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { VacaResolverSurface } from './vaca.js';
import type { CrawlPageLink, CrawlPageUnit } from '../crawl-types.js';

/**
 * Recorte do adaptador de filme que a série REUSA (mesma régua de título,
 * IMDb e dedupe por hash — duplicar divergiria em silêncio). Tudo o que é
 * estado do `createVacaCrawlSite` (assertSiteUrl, contador de requisições)
 * entra por aqui, então o módulo de série não importa o `vaca.ts` em runtime
 * (só o tipo da superfície, que é apagado na compilação).
 */
export interface VacaSeriesContext {
  surface: VacaResolverSurface;
  /** Host safety canônico do adaptador (hostname candidato + assert do resolver). */
  assertSiteUrl(value: string): URL;
  parseTitleYear(html: string): { title: string; year: number | null };
  parseImdbId(html: string): string | null;
  magnetHash(magnet: string): string | null;
  releaseToRawItem(obra: { title: string; year: number | null }, link: ResolverLink, magnet: string): RawItem;
  /** Conta UMA requisição HTTP real (usado como `onRequest` do transporte —
   * cada hop de redirect/protetor conta um, F3). */
  countRequest(): void;
  /** Custo acumulado até agora (para anexar a erros, F1: throw não perde o
   * que já foi gasto — o motor cobra o que mediu, não 1 por página). */
  requestCost(): number;
  /** Cerca do passo: expirado, o laço de cards/botões para (o motor descarta
   * o resultado — a retomada vem do `progress` já gravado). */
  isAborted?: () => boolean;
  /** Tap de observação (`crawl-page`): página/pack da série e os LINKS de card
   * extraídos (pré-protetor), para captura/shadow do parser Rust. Opcional. */
  onPageContent?: (content: string, links?: readonly CrawlPageLink[], unit?: CrawlPageUnit) => void;
}

/** Cadeia do protetor expirada (o Vaca devolve `protector_link_expired`). */
export const isExpired = (err: unknown) => /protector_link_expired/i.test(
  err instanceof Error ? err.message : String(err),
);

/** Terminal do protetor (F1): expirado OU destino provado não-magnet (download
 * direto). Ambos provam "não há torrent a colher" — sem retry que não muda nada. */
export const isTerminal = (err: unknown) => /protector_(?:link_expired|non_magnet)/i.test(
  err instanceof Error ? err.message : String(err),
);

/** F6: host de fora num card (HTML adulterado/anúncio) é diagnóstico, não
 * card falho tolerado — sobe como erro de página (site-level para o painel). */
export const isBlockedHost = (err: unknown) => /blocked_host:/i.test(
  err instanceof Error ? err.message : String(err),
);
