// Adaptador de SÉRIES do Vaca Torrent (plano "Raspagem total", Fase 7).
// Extraído do `vaca.ts` pela catraca de linhas e pelo escopo próprio: a página
// da série é só a porta de entrada — o acervo mora em
//
//   página da série → season-internal (data-u/?p=) → cards de temporada/batch
//     → página de cada card (por-episódio .ss-ep OU pack .bl) → parseDownloadLinks
//     → protetor → magnet.
//
// Travas herdadas do filme (não negociáveis):
//   - host safety em TODA URL derivada do conteúdo (season-internal e cards
//     vêm do HTML do site): só hostname candidato do site serve;
//   - fetch direto, sem FlareSolverr (`fetchTextDirect` do profile);
//   - IMDb só ancorado na ficha técnica; ambíguo → null (o TMDB decide).
//
// Específico de série (Fase 7):
//   - TETOS: `maxCards` (cards visitados) e `maxButtons` (botões seguidos).
//     Uma série explode em requisições; o custo REAL (medido por HOP no
//     transporte, protetor e redirect incluídos — F3) volta em `requestCost`
//     para o teto horário do motor;
//   - TRUNCAGEM (F5): página cortada por teto NUNCA é `done` — o pedaço não
//     lido ficaria invisível até o lastmod mudar. Vira erro retentável
//     `series_truncated: …` com backoff até o `maxTries` do motor (que dorme a
//     URL até o "Reprocessar erros"): sem isso a truncagem determinística
//     viraria loop eterno. O operador levanta `CRAWL_SERIES_MAX_*` e
//     reprocessa; a métrica `crawl.page.series-truncated` e o grupo de erro no
//     painel tornam o recorte visível;
//   - PACK × EPISÓDIO: por-episódio usa `link.episode` (o título sai SxxEyy);
//     pack único de temporada limpa o episódio e mantém a temporada; card de
//     slug desconhecido é conservador (season null → raiz da obra);
//   - LOCAÇÃO: cada release é roteada por `releaseWorkTargets` (título × dn,
//     mesma régua do índice) e agrupada por locação declarada (S/E, S, raiz) —
//     é o recorder que grava cada grupo na chave que o cobre, sempre partial.
//
// Nada aqui grava banco nem decide quando rodar: o motor chama, o recorder
// grava, a config (CRAWL_SERIES_*) limita.
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import { seriesSeasonInternalUrl, parseSeasonInternal, extractBatchTitle } from '../../../resolvers/profiles/vacatorrent-parsers.js';
import type { VacaResolverSurface } from './vaca.js';
import type { CrawlReleaseGroup, CrawlSeriesLimits, CrawlWorkResult } from '../crawl-types.js';
import { releaseWorkTargets } from '../../utils/release-work.js';
import { magnetDisplayName } from '../../utils/title-normalization.js';
import * as log from '../../utils/logger.js';

/** Defaults quando a config viva não traz limites (chamada de teste/legado). */
export const DEFAULT_SERIES_LIMITS: CrawlSeriesLimits = { enabled: false, maxCards: 10, maxButtons: 40 };

/**
 * Recorte do adaptador de filme que a série REUSA (mesma régua de título,
 * IMDb e dedupe por hash — duplicar divergiria em silêncio). Tudo o que é
 * estado do `createVacaCrawlSite` (assertSiteUrl, contador de requisições)
 * entra por aqui, então este módulo não importa o `vaca.ts` em runtime
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
}

/**
 * Anexa o custo medido ao erro (F1): a exceção sobe com `requestCost` e o
 * `crawl-page` repassa ao motor — página que falhou no 4º hop custa 4, não 1.
 * Erro alheio (não-Error) é embrulhado; o original vai na mensagem.
 */
export function withRequestCost(err: unknown, cost: number): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  (e as Error & { requestCost?: number }).requestCost = cost;
  return e;
}

/**
 * Temporada declarada no SLUG do card: `/tv/<série>/season/temporada-5/` e
 * os ordinais pt (`1a-temporada`, `2ª-temporada`, `3o-temporada`). Slug que
 * não declara temporada (batch `/batch/…`, layout novo) volta `null` —
 * conservador: a release vai para a raiz da obra em vez de chutar a estação.
 */
export function seasonFromCardSlug(value: string): number | null {
  let path = '';
  try {
    path = decodeURIComponent(new URL(value).pathname).toLowerCase();
  } catch {
    return null;
  }
  const segment = /\/season\/([^/]+)\/?$/.exec(path)?.[1] ?? '';
  const straight = /^temporada-(\d{1,2})$/.exec(segment);
  if (straight) return seasonOrNull(Number(straight[1]));
  // Ordinal antes: "1a-temporada", "2ª-temporada", "3o-temporada" (o
  // ordinal pode vir com ª/º/° ou letra a/o, com ou sem hífen do meio).
  const ordinal = /^(\d{1,2})[-_]*(?:[ªº°]|[ao])?[-_]*temporada$/.exec(segment);
  if (ordinal) return seasonOrNull(Number(ordinal[1]));
  return null;
}

function seasonOrNull(n: number): number | null {
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null;
}

/** Entrada de release com a locação PEDIDA pelo card que a produziu. */
export interface SeriesReleaseEntry {
  release: RawItem;
  request: { season: number | null; episode: number | null };
}

/**
 * Agrupa releases por LOCAÇÃO DECLARADA (título × dn, via
 * `releaseWorkTargets` — a MESMA régua do índice e do banco vivo). Uma
 * release por-episódio cobre S/E e a temporada; um pack cobre a temporada;
 * card sem temporada vai para a raiz. O mesmo hash pode aparecer em dois
 * grupos de propósito: o índice faz merge por hash e o banco dedupe por hash.
 */
export function groupSeriesReleases(entries: readonly SeriesReleaseEntry[]): CrawlReleaseGroup[] {
  const groups = new Map<string, CrawlReleaseGroup>();
  for (const { release, request } of entries) {
    const dn = magnetDisplayName(release) || undefined;
    for (const target of releaseWorkTargets(String(release.title || ''), request, dn)) {
      const key = `${target.season ?? -1}:${target.episode ?? -1}`;
      let group = groups.get(key);
      if (!group) {
        group = { season: target.season, episode: target.episode, releases: [] };
        groups.set(key, group);
      }
      group.releases.push(release);
    }
  }
  // Ordem determinística: episódio > temporada > raiz (o recorder grava na
  // ordem; a raiz por último espelha a especificidade do destinoDe).
  return [...groups.values()].sort((a, b) => {
    if (a.season == null && b.season != null) return 1;
    if (b.season == null && a.season != null) return -1;
    if (a.season !== b.season) return (a.season ?? 0) - (b.season ?? 0);
    return (a.episode ?? -1) - (b.episode ?? -1);
  });
}

const isExpired = (err: unknown) => /protector_link_expired/i.test(
  err instanceof Error ? err.message : String(err),
);
/** Terminal do protetor (F1): expirado OU destino provado não-magnet (download
 * direto). Ambos provam "não há torrent a colher" — sem retry que não muda nada. */
const isTerminal = (err: unknown) => /protector_(?:link_expired|non_magnet)/i.test(
  err instanceof Error ? err.message : String(err),
);
/** F6: host de fora num card (HTML adulterado/anúncio) é diagnóstico, não
 * card falho tolerado — sobe como erro de página (site-level para o painel). */
const isBlockedHost = (err: unknown) => /blocked_host:/i.test(
  err instanceof Error ? err.message : String(err),
);

/**
 * Processa UMA página de série e devolve o resultado GRUPADO por locação.
 * Falha de UM card ou de UM botão não perde os demais (mesma tolerância do
 * filme); todos-falhando é exceção (o motor retenta com backoff). F1: cards
 * com falha NUNCA viram `no-torrent` (erro retentável); F5: página cortada
 * por teto vira `series_truncated`; F6: card com host de fora sobe
 * `blocked_host:<host>` na porta.
 */
export async function fetchSeriesWork(
  ctx: VacaSeriesContext,
  url: string,
  limitsArg?: CrawlSeriesLimits,
): Promise<CrawlWorkResult> {
  const limits = limitsArg ?? DEFAULT_SERIES_LIMITS;
  // Defesa em profundidade (mesma do filme): a fila nasce da nossa descoberta,
  // mas o store pode ter sido editado — host de fora é rejeitado na porta.
  const workUrl = ctx.assertSiteUrl(url);
  // F3: custo por HOP — a contagem é feita pelo transporte (`onRequest`),
  // não à mão antes do fetch (redirect/protetor contam cada um).
  const pageHtml = await ctx.surface.fetchTextDirect(workUrl.href, undefined, { onRequest: ctx.countRequest });
  const { title, year } = ctx.parseTitleYear(pageHtml);
  if (!title) {
    return { url, status: 'error', error: 'layout: página sem <h1> de título' };
  }
  const imdb = ctx.parseImdbId(pageHtml);
  const internalUrl = seriesSeasonInternalUrl(pageHtml, workUrl.href);
  if (!internalUrl) {
    // Série sem season-internal (recém-criada ou layout novo): sem magnet.
    return { url, status: 'no-torrent', imdb, title, year, type: 'series' };
  }
  // season-internal também é página do site: href adulterado é erro
  // diagnosticável, nunca no-torrent (que mentiria sobre o acervo).
  const internalChecked = ctx.assertSiteUrl(internalUrl);
  const internalHtml = await ctx.surface.fetchTextDirect(internalChecked.href, undefined, { onRequest: ctx.countRequest });
  // F5: a contagem REAL da truncagem (slice de cards e teto de botões) é
  // feita na leitura abaixo e decidida no fim da função.
  const obra = { title, year };
  const entries: SeriesReleaseEntry[] = [];
  const seen = new Set<string>();
  let followed = 0;
  let buttons = 0;
  let expiredFails = 0;
  let nonMagnetFails = 0;
  let otherFails = 0;
  let cardsFailed = 0;
  let lastError: unknown = null;

  // F5: truncagem declarada. Card cortado pelo slice e botão/card seguinte
  // cortado pelo teto marcam a página como PARCIAL — o pedaço não lido vira
  // `series_truncated` (erro retentável), nunca `done` silencioso.
  const allCards = parseSeasonInternal(internalHtml, internalChecked.href);
  const maxCards = Math.max(1, limits.maxCards);
  const cardCapHit = allCards.length > maxCards;
  const cards = allCards.slice(0, maxCards);
  let buttonCapHit = false;

  for (const card of cards) {
    if (buttons >= limits.maxButtons) { buttonCapHit = true; break; }
    // F6: card é URL derivada do HTML do site — host de fora é erro
    // diagnosticável NA PORTA (sobe como `blocked_host:<host>`), nunca card
    // "falho" tolerado que esconda o sintoma.
    const cardUrl = ctx.assertSiteUrl(card.url);
    let cardHtml: string;
    try {
      // F3: o custo é por HOP, contado pelo transporte (`onRequest`).
      cardHtml = await ctx.surface.fetchTextDirect(cardUrl.href, undefined, { onRequest: ctx.countRequest });
    } catch (err: unknown) {
      if (isBlockedHost(err)) throw err;
      cardsFailed += 1;
      lastError = err;
      log.warn(`[crawl] vacatorrent: card falhou (${card.url}):`, log.errorMessage(err));
      continue;
    }
    // Temporada do card: o parser dá a do `temporada-N`; slug com ordinal pt
    // ou indefinido passa pelo slug conservador (null → raiz).
    const season = card.season ?? seasonFromCardSlug(card.url);
    const links = ctx.surface.parseDownloadLinks(cardHtml, card.url, {
      season,
      // Pack (batch) publica o título real do pack, que é o que o
      // releaseTitle usa — o bloqueio de pack genérico não se aplica aqui
      // porque a locação é decidida pelo roteador (title × dn), não pelo rótulo.
      ...(card.isBatch ? { realTitle: extractBatchTitle(cardHtml) || null } : {}),
    });
    for (const link of links) {
      if (buttons >= limits.maxButtons) { buttonCapHit = true; break; }
      buttons += 1;
      try {
        if (!/^magnet:/i.test(link.url)) ctx.surface.assertAllowedUrl(link.url);
        // F3: magnet: não faz rede (custo 0); cadeia http conta cada hop.
        const finalHtml = await ctx.surface.fetchFollowingAllowed(link.url, workUrl.href, { onRequest: ctx.countRequest });
        followed += 1;
        const magnet = ctx.surface.extractMagnet(finalHtml);
        if (!magnet) continue; // cadeia resolveu mas não há magnet: não inventa
        const hash = ctx.magnetHash(magnet);
        if (hash && seen.has(hash)) continue; // mesmo hash, botão repetido
        if (hash) seen.add(hash);
        // Locação PEDIDA: pack único limpa o episódio e mantém a temporada;
        // por-episódio usa o link.episode da máquina de episódios (o título
        // sai SxxEyy pelo releaseTitle do filme, mesma régua). Card sem
        // temporada é conservador: episódio sem estação não existe — raiz.
        const request = {
          season: season ?? null,
          episode: season == null || card.isBatch ? null : (link.episode ?? null),
        };
        entries.push({ release: ctx.releaseToRawItem(obra, link, magnet), request });
      } catch (err: unknown) {
        lastError = err;
        if (isExpired(err)) expiredFails += 1;
        else if (/protector_non_magnet/i.test(err instanceof Error ? err.message : String(err))) nonMagnetFails += 1;
        else otherFails += 1;
        log.warn(`[crawl] vacatorrent: botão de série falhou (${url}):`, log.errorMessage(err));
      }
    }
  }

  // F5/B2: página cortada por teto NUNCA é `done` nem `no-torrent` — o resto
  // da série ficaria invisível até o lastmod mudar. Vale para QUALQUER
  // truncagem, inclusive a que coletou 0 magnets: cards ainda não visitados
  // ou botões ainda não seguidos podem conter o torrent que um `no-torrent`
  // mentiria que não existe. Erro retentável rotulado; o `maxTries` do motor
  // é o freio anti-loop (a URL dorme até o operador levantar o teto e usar
  // "Reprocessar erros").
  const truncated = cardCapHit || buttonCapHit;
  if (truncated) {
    return {
      url,
      status: 'error',
      error: `series_truncated: teto de série atingido (cards ${cards.length}/${allCards.length}, botões ${buttons}/${limits.maxButtons})`,
      imdb,
      title,
      year,
      type: 'series',
    };
  }

  if (!entries.length) {
    const terminalFails = expiredFails + nonMagnetFails;
    const allButtonsFailed = expiredFails + nonMagnetFails + otherFails === buttons;
    // F1: cards TODOS/parcialmente falhando é erro retentável — nunca
    // `no-torrent` por comparação 0===0 (o caso `buttons===0, cardsFailed>0`
    // era tragado como "sem torrent" e a série inteira saía do acervo por um
    // sintoma de rede).
    if (cardsFailed > 0) {
      if (!followed && lastError && (buttons === 0 || allButtonsFailed)) {
        throw lastError;
      }
      throw new Error(
        `vacatorrent: série sem magnet — cards com falha `
        + `(${cards.length} card(s), ${cardsFailed} com falha, ${buttons} botão(ões))`
        + (lastError ? `; último erro: ${log.errorMessage(lastError)}` : ''),
      );
    }
    // Cards OK e NENHUM botão publicado (card sem links): sem torrent, honesto.
    // Cards OK e TODOS os botões terminais (expirado + non_magnet, F1):
    // sem torrent útil — magnet morto/download direto não merece retry.
    if (cards.length > 0 && (buttons === 0 || (terminalFails === buttons && otherFails === 0 && followed === 0))) {
      return { url, status: 'no-torrent', imdb, title, year, type: 'series' };
    }
    // Nenhuma cadeia foi adiante e houve falha de transporte: o erro real sobe
    // (motor retenta).
    if (!followed && lastError && (buttons === 0 || allButtonsFailed)) {
      throw lastError;
    }
    const detail = lastError ? `; último erro: ${log.errorMessage(lastError)}` : '';
    throw new Error(
      `vacatorrent: série sem magnet (${cards.length} card(s), ${cardsFailed} com falha, `
      + `${buttons} botão(ões), ${followed} sem magnet${detail})`,
    );
  }
  return {
    url,
    status: 'done',
    imdb,
    title,
    year,
    type: 'series',
    groups: groupSeriesReleases(entries),
  };
}
