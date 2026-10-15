// Locação de série do Vaca por EVIDÊNCIA REAL (plano Fase 7 v2, Parte A) e
// utilidades puras de roteamento extraídas do `vaca-series.ts` pela catraca de
// linhas. Nada aqui faz rede nem grava: decide EM QUE CHAVE (S/E, S, raiz) a
// release de um botão nasce.
//
// O defeito que motiva o módulo: cards de "todas as temporadas" do Vaca
// (layout `.ss-ep` com slugs `season/stranger-things/`, `-2/`…, arcos de One
// Piece como `east-blue1`) NÃO declaram `temporada-N`. Sem evidência, o card
// ia para a raiz com `link.episode` do marcador `ss-ep-num` injetado no
// título — o `E01` fictício medido no `magnets.db` (9 hashes de Stranger
// Things todos em `(season=-1, episode=-1)`).
//
// Precedência de evidência (dn é CONTEÚDO, card é PÁGINA — dn vence):
//
// | # | Evidência                                        | Resultado
// |---|--------------------------------------------------|---------------------------------------------
// | 1 | `dn` declara (complete/multi/1 temporada/ep.)    | multi/complete → {null,null}; 1S+1E → {S,E}; 1S sem E → {S,null} (episódio limpo — mata o E01)
// | 2 | dn silencioso, título (batch/card) declara       | temporada única → {S, isBatch ? null : linkEpisode}; complete/multi → {null,null}
// | 3 | `dn`/título silenciosos, `cardSeason != null`    | {cardSeason, isBatch ? null : linkEpisode} — regressão exata do caminho `temporada-N`
// | 4 | dn/título silenciosos, card termina em 1-2 díg.  | {S, isBatch ? null : linkEpisode} ("East Blue1"→1; "Show 2020" rejeitado: 4 dígitos)
// | 5 | nada declara                                     | {null,null} — raiz conservadora (= comportamento de hoje)
//
// O parse é SEMPRE `parseTitleSeasonEpisode` (a mesma régua do filtro e do
// índice) — nenhum parse novo aqui.
import type { RawItem } from '../../../types/domain.js';
import { parseTitleSeasonEpisode } from '../../utils/episode-matching.js';
import { releaseWorkTargets } from '../../utils/release-work.js';
import { decodeEntities, magnetDisplayName } from '../../utils/title-normalization.js';
import { liveActionYearContradicts } from '../../utils/matching-tokens.js';
import { repairMangledEntities } from '../../../resolvers/text.js';
import type { CrawlReleaseGroup } from '../crawl-types.js';

/**
 * Decodifica ENTIDADES HTML da evidência ANTES de inferir temporada/agrupar.
 * Os sites BR publicam o ordinal como entidade ("4&ordf; Temporada") e a
 * evidência chega com resíduos: o dn do magnet pode vir duplamente codificado
 * ("&amp;ordf;") e o slug/URL solta a entidade sem o ";" final ("4ordf").
 * Sem decodificar, `parseTitleSeasonEpisode` não lê temporada nenhuma — o pack
 * da 4ª caía na regra do dígito final/raiz e a obra herdava locação errada
 * (TWD: work na S1/S5 em vez da S4, medido em produção 2026-09-27).
 *
 * Duas passadas: a primeira repara ";" ausente (sem tocar "&" solto — "&"
 * seguido de espaço/letra única, como "Tom & Jerry" e "A&B", não é entidade),
 * e `decodeEntities` roda duas vezes porque "&amp;#170;" só vira "ª" na
 * segunda. `decodeEntities` é a MESMA função do resto do pipeline (armadilha
 * do dn percent-decoded: o `%26` já virou "&" antes daqui).
 *
 * EXPORTADA de propósito: o reparo (`scripts/crawl-repair-plan.ts`) usa a
 * MESMA decodificação ao avaliar título×dn — régua única, sem cópia (uma
 * segunda implementação divergiria em silêncio). Dependência numa via só
 * (src → resolvers; `resolvers/text.ts` não importa nada de `src/`).
 */
export function decodeEvidence(text: string): string {
  // Entidades DESTRUÍDAS primeiro ("4ordf" = "4ª" sem o "&", dn real do TWD):
  // sem isso o parse não lê temporada nenhuma e o card impõe a dele.
  const mangled = repairMangledEntities(String(text || ''));
  const repaired = mangled
    .replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]{2,8})(?![a-z0-9;])/gi, '&$1;');
  return decodeEntities(decodeEntities(repaired));
}

export type SeriesLocation = { season: number | null; episode: number | null };

/** Evidência disponível na onda em que a request de UM botão nasce. */
export interface LinkEvidence {
  /** Slug `temporada-N`/ordinal do card (`seasonFromCardSlug`). */
  cardSeason: number | null;
  /** Texto da âncora do card ("Temporada 5", "Stranger Things 4", "East Blue1"). */
  cardTitle: string;
  isBatch: boolean;
  /** Título real do batch (`extractBatchTitle`: "BATCH – Reacher S01"). */
  realTitle: string | null;
  /** Nome REAL do torrent (`magnetDisplayName({ magnet })`), ou null. */
  dn: string | null;
  /** `link.episode` da máquina de episódios (marcador `ss-ep-num`). */
  linkEpisode: number | null;
}

/** Entrada de release com a locação PEDIDA pelo card que a produziu. */
export interface SeriesReleaseEntry {
  release: RawItem;
  request: { season: number | null; episode: number | null };
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
    // Entidade no slug ("%26ordf%3B" → "&ordf;"): decodificar ANTES de casar
    // o ordinal — "4&ordf;-temporada" é a 4ª, não slug desconhecido.
    path = decodeEvidence(decodeURIComponent(new URL(value).pathname)).toLowerCase();
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

type EpisodeParse = ReturnType<typeof parseTitleSeasonEpisode>;

/** Locação que UM parse declara, ou `null` quando ele é silencioso. */
function locationOfParse(p: EpisodeParse): SeriesLocation | null {
  // Série inteira/faixa/multi-temporada: raiz legítima — a release cobre a
  // obra toda e o índice/roteador lidam com isso há sempre.
  if (p.complete || p.seasons.length > 1) return { season: null, episode: null };
  if (p.seasons.length === 1) {
    // Pack de UMA temporada sem episódio único: {S, null} — é aqui que o
    // `E01` fictício morre: o dn prova que é a temporada inteira, então o
    // marcador `ss-ep-num` da página não pode virar episódio do título.
    const episode = p.episodes.length === 1 ? p.episodes[0] : null;
    return { season: p.seasons[0], episode };
  }
  // Temporada nenhuma: silencioso para temporada. Episódios sem estação não
  // existem — tratado como silencioso (a regra seguinte decide).
  return null;
}

/** O parse nega a temporada da página (complete/multi sem temporada)? */
function parseDeclaresRoot(p: EpisodeParse): boolean {
  return p.complete || p.seasons.length > 1;
}

/** Última "palavra" numérica de 1-2 dígitos do título ("East Blue1" → 1). */
function trailingSeasonOf(title: string): number | null {
  const text = String(title || '').trim();
  // Ano tem 4 dígitos: "Show 2020" não é temporada 20.
  if (/\d{3,}\s*$/.test(text)) return null;
  const m = /(?<!\d)(\d{1,2})\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 && n <= 99 ? n : null;
}

/**
 * Onde o botão NASCE (tabela versionada no cabeçalho). Nunca lança: sem
 * evidência nenhuma devolve raiz — o comportamento conservador de hoje.
 */
export function declaredSeriesLocation(e: LinkEvidence): SeriesLocation {
  // Regra 1 — dn é conteúdo: o nome REAL do torrent vence qualquer página.
  // Entidades decodificadas antes do parse ("4&ordf;" vira "4ª" — bug 2).
  const dn = decodeEvidence(String(e.dn || ''));
  if (dn.trim()) {
    const fromDn = locationOfParse(parseTitleSeasonEpisode(dn));
    if (fromDn) return fromDn;
  }
  // Episódio da página: só vale em card POR-EPISÓDIO (batch não tem episódio).
  const pageEpisode = e.isBatch ? null : (e.linkEpisode ?? null);
  // Regra 2 — o RÓTULO do próprio card/batch declara (título que diz outra
  // temporada NÃO pode herdar a do slug: página "temporada-1" do TWD lista
  // cards S1..S9 e a âncora "4ª Temporada" é a evidência certa, medido
  // 2026-09-27). Título que declara complete/multi manda para a raiz;
  // temporada única nomeia S.
  for (const candidate of [e.realTitle, e.cardTitle]) {
    const text = decodeEvidence(String(candidate || ''));
    if (!text.trim()) continue;
    const p = parseTitleSeasonEpisode(text);
    if (parseDeclaresRoot(p)) return { season: null, episode: null };
    if (p.seasons.length === 1) return { season: p.seasons[0], episode: pageEpisode };
  }
  // Regra 3 — slug do card: evidência da PÁGINA, só quando o rótulo é
  // silencioso (regressão exata do caminho `temporada-N`).
  if (e.cardSeason != null) return { season: e.cardSeason, episode: pageEpisode };
  // Regra 4 — última defesa sem dn: dígito final do card ("East Blue1").
  const trailing = trailingSeasonOf(decodeEvidence(e.cardTitle));
  if (trailing != null) return { season: trailing, episode: pageEpisode };
  // Regra 5 — nada declara: raiz conservadora.
  return { season: null, episode: null };
}

/**
 * Agrupa releases por LOCAÇÃO DECLARADA (título × dn, via
 * `releaseWorkTargets` — a MESMA régua do índice e do banco vivo). Uma
 * release por-episódio cobre S/E e a temporada; um pack cobre a temporada;
 * card sem temporada vai para a raiz. O mesmo hash pode aparecer em dois
 * grupos de propósito: o índice faz merge por hash e o banco dedupe por hash.
 *
 * `opts.year` (opcional, ano de estreia da obra da página) liga o veto de
 * identidade por adaptação: post "Live Action" com ano longe da estreia é
 * OUTRA obra (One Piece 2023/2026 sob o anime tt0388629, medido 2026-09-27)
 * e NÃO é agrupado — excluir, nunca remanejar para outro IMDb.
 *
 * `opts.byDeclaredLocation` agrupa pela locação JÁ DECLARADA de cada entrada
 * (o `request`, que quem chama calculou por `declaredSeriesLocation`) em vez de
 * `releaseWorkTargets` (título×dn). Página que AGREGA temporadas precisa
 * disso: o título da release carrega a lista de ordinais do `<h1>` ("Superman &
 * Lois 1ª e 2ª Temporada S01 …"), e o `releaseWorkTargets` lê essa lista como
 * "série multi-temporada" e empurra a linha para a RAIZ ALÉM da temporada
 * declarada (medido com o build de 2026-09-29: o pack S01 saía em `S1` e na
 * raiz). A raiz é exatamente a locação que não pode ser affirmada aqui, então
 * quem tem evidência por LINHA agrupa por ela.
 */
export function groupSeriesReleases(
  entries: readonly SeriesReleaseEntry[],
  opts: { year?: number | string | null; byDeclaredLocation?: boolean } = {},
): CrawlReleaseGroup[] {
  const groups = new Map<string, CrawlReleaseGroup>();
  for (const { release, request } of entries) {
    // Agrupar com a evidência DECODIFICADA: título/dn com entidade crua não
    // declara temporada nenhuma e a release era roteada pela chave do pedido
    // (ou da raiz) em vez da chave que o pack cobre (TWD: S1/S5 em vez de S4).
    const title = decodeEvidence(String(release.title || ''));
    const dn = decodeEvidence(magnetDisplayName(release)) || undefined;
    // Contaminação de identidade (Live Action de outra adaptação): a release
    // sai SEM grupo — excluir, não remanejar (o imdbId certo é prova positiva,
    // que a raspagem não tem). Aqui a obra é série por definição (página tv).
    if (liveActionYearContradicts(`${title} ${dn || ''}`, opts.year)) {
      continue;
    }
    for (const target of (opts.byDeclaredLocation
      ? [request]
      : releaseWorkTargets(title, request, dn))) {
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
