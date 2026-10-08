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
//   - PACK × EPISÓDIO: a LOCAÇÃO de cada botão nasce de EVIDÊNCIA REAL
//     (`declaredSeriesLocation` em `vaca-series-locate.ts`): o dn do magnet
//     vence (é conteúdo), o slug/título do card é página. Pack "todas as
//     temporadas"/temporada única vai S ou raiz legítima — NUNCA um `E01`
//     fictício do marcador `ss-ep-num`; por-episódio usa `link.episode`;
//   - LOCAÇÃO: cada release é roteada por `releaseWorkTargets` (título × dn,
//     mesma régua do índice) e agrupada por locação declarada (S/E, S, raiz) —
//     é o recorder que grava cada grupo na chave que o cobre, sempre partial;
//   - RETOMADA (Fase 7 v2, Parte B): página cortada por teto vira status
//     `partial` com progresso monotônico (`doneCards`/`card.skip`) gravado no
//     `crawl.db` — a próxima tentativa recomeça dos cards feitos em vez de
//     refazer a série do zero (One Piece/TWD: o teto de cards deixava a série
//     em `error series_truncated` para sempre). Avanço zera `tries`; estagnação
//     vira `error series_stall` com backoff (decisão no `crawl-page`).
//
// Nada aqui grava banco nem decide quando rodar: o motor chama, o recorder
// grava, a config (CRAWL_SERIES_*) limita.
import type { RawItem } from '../../../types/domain.js';
import type { ParsedResolverLink, ResolverLink } from '../../../resolvers/types.js';
import { seriesSeasonInternalUrl, parseSeasonInternal, extractBatchTitle } from '../../../resolvers/profiles/vacatorrent-parsers.js';
import type { VacaResolverSurface } from './vaca.js';
import type { CrawlReleaseGroup, CrawlSeriesLimits, CrawlWorkResult, SeriesWorkProgress } from '../crawl-types.js';
import { declaredSeriesLocation, groupSeriesReleases, seasonFromCardSlug } from './vaca-series-locate.js';
import type { SeriesReleaseEntry } from './vaca-series-locate.js';
import { magnetDisplayName } from '../../utils/title-normalization.js';
import * as log from '../../utils/logger.js';
import { crawlFetch } from './vaca-fetch.js';

/** Teto da memória de dedupe no progresso (fica na coluna `progress`). */
const SEEN_MAX = 500;

/**
 * Assinatura de botão de PACK (sem episódio) com tamanho REAL: qualidade +
 * áudio + tamanho. É a única identidade antes do protetor — a URL
 * `systemtech` é cifrada por página (0/10 iguais entre cards do TWD). Botão
 * de episódio NÃO tem assinatura: S01E01 e S02E01 com o mesmo tamanho
 * arredondado seriam releases diferentes, e o custo de errar é perder uma.
 * Sem tamanho (ou o sentinela "1 KB" do resolver) também não.
 */
export function packSignature(link: Pick<ResolverLink, 'quality' | 'audio' | 'size' | 'episode'>): string | null {
  if (link.episode != null) return null;
  const size = String(link.size || '').trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
  if (!/\d/.test(size) || /^1(\.0+)?kb$/.test(size)) return null;
  return `s:${link.quality ?? '-'}|${link.audio ?? '-'}|${size}`;
}

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
  /** Cerca do passo: expirado, o laço de cards/botões para (o motor descarta
   * o resultado — a retomada vem do `progress` já gravado). */
  isAborted?: () => boolean;
}

/**
 * Anexa o custo medido ao erro (F1): a exceção sobe com `requestCost` e o
 * `crawl-page` repassa ao motor — página que falhou no 4º hop custa 4, não 1.
 * Erro alheio (não-Error) é embrulhado; o original vai na mensagem.
 *
 * O núcleo é `crawl-sites/shared.ts` (o NerdFilmes consome o mesmo); o
 * reexport mantém a API pública deste módulo.
 */
export { withRequestCost } from './shared.js';

// Roteamento por slug e agrupamento por locação mudaram para
// `vaca-series-locate.ts` (catraca de linhas): reexportados para não mudar
// o consumo existente (testes e o próprio motor).
export { seasonFromCardSlug, groupSeriesReleases } from './vaca-series-locate.js';
export type { SeriesReleaseEntry } from './vaca-series-locate.js';

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
 * filme); F1: cards com falha NUNCA viram `no-torrent`; F5/Fase 7 v2: página
 * cortada por teto (ou com card falho depois de progresso) vira `partial` com
 * progresso retomável; F6: card com host de fora sobe `blocked_host:<host>`.
 *
 * `resume` é o progresso da tentativa anterior (coluna `progress` da linha):
 * cards em `doneCards` não são re-visados; `card.skip` recomeça o laço de
 * botões no ponto onde o teto cortou (o card é re-buscado — 1 request —, os
 * botões já seguidos não).
 */
export async function fetchSeriesWork(
  ctx: VacaSeriesContext,
  url: string,
  limitsArg?: CrawlSeriesLimits,
  resume?: SeriesWorkProgress | null,
): Promise<CrawlWorkResult> {
  const limits = limitsArg ?? DEFAULT_SERIES_LIMITS;
  // Defesa em profundidade (mesma do filme): a fila nasce da nossa descoberta,
  // mas o store pode ter sido editado — host de fora é rejeitado na porta.
  const workUrl = ctx.assertSiteUrl(url);
  // F3: custo por HOP — a contagem é feita pelo transporte (`onRequest`),
  // não à mão antes do fetch (redirect/protetor contam cada um).
  const pageHtml = await crawlFetch(ctx.surface, workUrl.href, undefined, { onRequest: ctx.countRequest });
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
  const internalHtml = await crawlFetch(ctx.surface, internalChecked.href, undefined, { onRequest: ctx.countRequest });
  // F5: a contagem REAL da truncagem (slice de cards e teto de botões) é
  // feita na leitura abaixo e decidida no fim da função.
  const obra = { title, year };
  const entries: SeriesReleaseEntry[] = [];
  // Dedupe ENTRE passadas: hashes (`h:`) e assinaturas de pack (`s:`) das
  // passadas anteriores vêm do progresso — sem isso cada retomada reemitia e
  // re-resolvia o bloco de packs que o site repete em todo card.
  const seenKeys = new Set<string>(Array.isArray(resume?.seen) ? resume!.seen : []);
  const seen = {
    has: (hash: string) => seenKeys.has(`h:${hash}`),
    add: (hash: string) => seenKeys.add(`h:${hash}`),
  };
  let followed = 0;
  let buttons = 0;
  let expiredFails = 0;
  let nonMagnetFails = 0;
  let otherFails = 0;
  let cardsFailed = 0;
  let lastError: unknown = null;

  // F5/Parte B: a contagem da truncagem é sobre os cards QUE FALTAM — o
  // resume pula os `doneCards`, então uma série maior que o teto converge em
  // passes (One Piece: 24 cards, teto 10 → 3 passes), sem recomeçar do zero.
  const allCards = parseSeasonInternal(internalHtml, internalChecked.href);
  const resumeDone = Array.isArray(resume?.doneCards) ? resume!.doneCards : [];
  const remaining = allCards.filter((c) => !resumeDone.includes(c.url));
  const maxCards = Math.max(1, limits.maxCards);
  const cardCapHit = remaining.length > maxCards;
  const cards = remaining.slice(0, maxCards);
  let buttonCapHit = false;
  // Progresso monotônico: `doneCards` só cresce (união com o resume) e o
  // `card.skip` só avança dentro do mesmo card.url — a comparação de avanço
  // no store/crawl-page detecta estagnação e vira `series_stall`.
  const doneCards = new Set<string>(resumeDone);
  let interruptedCard: { url: string; skip: number } | null = null;
  let cardsCompletedThisPass = 0;

  for (const card of cards) {
    if (buttons >= limits.maxButtons) { buttonCapHit = true; break; }
    if (ctx.isAborted?.()) break;
    // F6: card é URL derivada do HTML do site — host de fora é erro
    // diagnosticável NA PORTA (sobe como `blocked_host:<host>`), nunca card
    // "falho" tolerado que esconda o sintoma.
    const cardUrl = ctx.assertSiteUrl(card.url);
    let cardHtml: string;
    try {
      // F3: o custo é por HOP, contado pelo transporte (`onRequest`).
      cardHtml = await crawlFetch(ctx.surface, cardUrl.href, undefined, { onRequest: ctx.countRequest });
    } catch (err: unknown) {
      if (isBlockedHost(err)) throw err;
      cardsFailed += 1;
      lastError = err;
      log.warn(`[crawl] vacatorrent: card falhou (${card.url}):`, log.errorMessage(err));
      continue;
    }
    // Temporada do card: o parser dá a do `temporada-N`; slug com ordinal pt
    // ou indefinido passa pelo slug conservador (null → evidência decide).
    const season = card.season ?? seasonFromCardSlug(card.url);
    // Hoisted para o escopo do card: é a evidência de TÍTULO da regra 3 do
    // roteador (e o realTitle que o releaseTitle usa, como antes).
    const batchTitle = extractBatchTitle(cardHtml) || null;
    const links = ctx.surface.parseDownloadLinks(cardHtml, card.url, {
      season,
      // Pack (batch) publica o título real do pack, que é o que o
      // releaseTitle usa — o bloqueio de pack genérico não se aplica aqui
      // porque a locação é decidida pelo roteador (title × dn), não pelo rótulo.
      ...(card.isBatch ? { realTitle: batchTitle } : {}),
    });
    // Retomada do meio do card: `skip` é o índice do PRÓXIMO botão a seguir.
    const skip = resume?.card && resume.card.url === card.url
      ? Math.max(0, Math.trunc(Number(resume.card.skip) || 0))
      : 0;
    let followedInCard = 0;
    let cardCutByCap = false;
    for (let index = 0; index < links.length; index += 1) {
      const link = links[index];
      if (index < skip) continue; // botões já seguidos numa tentativa anterior
      if (ctx.isAborted?.()) break;
      // Pack já resolvido (mesma qualidade/áudio/tamanho real): a URL do
      // protetor muda por página, então só a assinatura evita seguir a cadeia
      // de novo. Não consome o teto de botões — não há requisição.
      const sig = packSignature(link);
      if (sig && seenKeys.has(sig)) continue;
      if (buttons >= limits.maxButtons) {
        buttonCapHit = true;
        cardCutByCap = true;
        // Checkpoint NO botão onde cortou: a retomada refaz a partir daqui.
        interruptedCard = { url: card.url, skip: index };
        break;
      }
      buttons += 1;
      followedInCard += 1;
      try {
        if (!/^magnet:/i.test(link.url)) ctx.surface.assertAllowedUrl(link.url);
        // F3: magnet: não faz rede (custo 0); cadeia http conta cada hop.
        const finalHtml = await ctx.surface.fetchFollowingAllowed(link.url, workUrl.href, { onRequest: ctx.countRequest });
        followed += 1;
        const magnet = ctx.surface.extractMagnet(finalHtml);
        if (!magnet) continue; // cadeia resolveu mas não há magnet: não inventa
        const hash = ctx.magnetHash(magnet);
        if (sig) seenKeys.add(sig);
        if (hash && seen.has(hash)) continue; // mesmo hash, botão repetido
        if (hash) seen.add(hash);
        // Locação POR EVIDÊNCIA (Parte A): o dn do magnet é conteúdo e vence
        // a página; o card (slug/título/batch) é a evidência de página. Pack
        // de temporada única sai {S, null} — o marcador `ss-ep-num` NÃO vira
        // `E01` fictício; por-episódio real sai {S, E}; sem evidência, raiz.
        const dn = magnetDisplayName({ magnet }) || null;
        const loc = declaredSeriesLocation({
          cardSeason: season,
          cardTitle: card.title,
          isBatch: card.isBatch,
          realTitle: batchTitle,
          dn,
          linkEpisode: link.episode ?? null,
        });
        // `season`/`episode` no link alimentam o seasonOf/episodeOf do
        // releaseTitle (S01 no pack, SxxEyy no episódio real) — é o título
        // que nasce coerente com a locação, em vez do `E01` do bloco.
        const linkWithLoc: ParsedResolverLink = { ...link, season: loc.season, episode: loc.episode };
        entries.push({ release: ctx.releaseToRawItem(obra, linkWithLoc, magnet), request: loc });
      } catch (err: unknown) {
        lastError = err;
        if (isExpired(err)) expiredFails += 1;
        else if (/protector_non_magnet/i.test(err instanceof Error ? err.message : String(err))) nonMagnetFails += 1;
        else otherFails += 1;
        log.warn(`[crawl] vacatorrent: botão de série falhou (${url}):`, log.errorMessage(err));
      }
    }
    // Card concluído (o laço de botões acabou sem teto): checkpoint. Card
    // falho NUNCA entra — a retomada o refaz. Falha de BOTÃO é tolerância de
    // hoje (não atrasa card nem vira partial; limitação documentada).
    if (!cardCutByCap) {
      doneCards.add(card.url);
      cardsCompletedThisPass += 1;
    }
  }

  // Progresso desta passada (união monotônica; `card` só quando o teto de
  // botões cortou no meio de um card).
  const progress: SeriesWorkProgress = {
    v: 1,
    doneCards: [...doneCards],
    ...(interruptedCard ? { card: interruptedCard } : {}),
    totalCards: allCards.length,
    ...(seenKeys.size ? { seen: [...seenKeys].slice(-SEEN_MAX) } : {}),
  };

  // Matriz de retorno (Fase 7 v2). Ordem importa:
  // 1) truncagem (teto de card/botão) OU card falho com ≥1 concluído nesta
  //    passada → `partial` com grupos e progresso — NADA descartado. A
  //    truncagem deixa de ser `error`: trabalho em andamento não é falha de
  //    site (não alimenta errorStreak/pausa automática).
  const truncated = cardCapHit || buttonCapHit;
  if (truncated || (cardsFailed > 0 && cardsCompletedThisPass > 0)) {
    const motivo = truncated
      ? `series_truncated: teto de série atingido (cards ${cards.length}/${allCards.length}, botões ${buttons}/${limits.maxButtons})`
      : `cards_failed: ${cardsFailed} card(s) com falha`;
    return {
      url,
      status: 'partial',
      error: motivo,
      imdb,
      title,
      year,
      type: 'series',
      ...(entries.length ? { groups: groupSeriesReleases(entries, { year: obra.year }) } : {}),
      progress,
    };
  }

  // 2) card falho e NENHUMA card concluída: a causa real sobe (motor retenta
  //    com backoff); o markError do crawl-page preserva o progresso anterior.
  if (cardsFailed > 0) {
    const allButtonsFailed = expiredFails + nonMagnetFails + otherFails === buttons;
    if (!followed && lastError && (buttons === 0 || allButtonsFailed)) {
      throw lastError;
    }
    throw new Error(
      `vacatorrent: série sem magnet — cards com falha `
      + `(${cards.length} card(s), ${cardsFailed} com falha, ${buttons} botão(ões))`
      + (lastError ? `; último erro: ${log.errorMessage(lastError)}` : ''),
    );
  }

  // 3) sem cap e sem falha de card: conclusão. Com releases, `done` + grupos
  //    (como sempre). Sem releases MAS com resume (a leitura secou num passe
  //    anterior): `done` SEM grupos — devolver `no-torrent` aqui apagaria a
  //    contagem e mentiria "sem torrent" sobre uma série já colhida. O
  //    crawl-page preserva a contagem da última visita com gravação.
  if (entries.length) {
    return {
      url,
      status: 'done',
      imdb,
      title,
      year,
      type: 'series',
      groups: groupSeriesReleases(entries, { year: obra.year }),
      progress,
    };
  }
  if (resumeDone.length > 0 || !!resume?.card) {
    return { url, status: 'done', imdb, title, year, type: 'series', progress };
  }
  const terminalFails = expiredFails + nonMagnetFails;
  const allButtonsFailed = expiredFails + nonMagnetFails + otherFails === buttons;
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
