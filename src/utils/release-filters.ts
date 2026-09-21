import type { RawItem } from '../../types/domain.js';
import { matchesEpisode, seasonCoverageExcludes, parseTitleSeasonEpisode } from './episode-matching.js';
import { titleTokens } from './matching-vocabulary.js';
import { namedSequelContradicts, yearContradicts } from './matching-tokens.js';
import { magnetDisplayName } from './title-normalization.js';
import {
  containsTokenRun,
  franchiseRoots,
  isMultiWorkCollection,
  matchesName,
} from './release-name-matching.js';
import {
  matchesBrTitle,
  matchesEpisodeWorkIdentity,
  matchesGlobalSeriesNoMarker,
  matchesTitleStructure,
} from './release-title-rules.js';
import { admitsMultiWorkPack } from './multiwork-pack.js';
import type { MultiWorkCollection } from '../../types/domain.js';

interface MatchOptions {
  names?: string[];
  year?: number | string | null;
  isSeries?: boolean;
  season?: number | null;
  episode?: number | null;
  allNames?: string[] | null;
  tokens?: string[] | null;
  universeTokens?: string[] | null;
  /** Opt-in multiobra: quando presente, packs da franquia podem ser admitidos. */
  multiWork?: MultiWorkCollection | null;
}

export type RelevanceRejectReason =
  | 'title'
  | 'magnet-year'
  | 'named-sequel'
  | 'episode'
  | 'series-work'
  | 'movie-is-series';

/**
 * Classificação crua compartilhada pelo corte final e pelo gatilho de pack.
 * Usar uma função só impede o fallback de discordar do que buildStreams vai
 * descartar alguns milissegundos depois.
 *
 */
function filterRelevantRaw(
  items: RawItem[] = [],
  { names = [], year = null, isSeries = false, season = null, episode = null, multiWork = null }: MatchOptions = {},
  onRejected?: (item: RawItem, reason: RelevanceRejectReason) => void,
) {
  if (!names.length) return items;
  // Hot path: os tokens do título e o universo de allNames dependem só de
  // strings que se repetem entre itens. Cada item renormalizava o MESMO texto
  // 3-5 vezes (matchesName, matchesBrTitle, matchesTitleStructure,
  // matchesEpisodeWorkIdentity), e o universo de nomes era remontado por item.
  const tokenMemo = new Map();
  const tokensOf = (title: string) => {
    let tokens = tokenMemo.get(title);
    if (!tokens) {
      tokens = titleTokens(title);
      tokenMemo.set(title, tokens);
    }
    return tokens;
  };
  const universe = names.flatMap((n) => titleTokens(n)).filter(Boolean);
  return items.filter((item) => {
    const title = item?.title || item?.Title || '';
    const tokens = tokensOf(title);
    const titleMatches = names.some((name) =>
      item?.isBr
        ? matchesBrTitle(title, name, year, { isSeries, allNames: names, tokens, universeTokens: universe })
        : matchesName(title, name, tokens) &&
          // Série global continua PULANDO prefixo e sequência — o marcador de
          // episódio delimita a obra, e o prefixo de filme mudaria formatos
          // legítimos como "S01E02.From". Mas ficar sem guarda NENHUMA depois
          // do matchesName deixava a série com um portão só: release de filme
          // não carrega marcador de episódio, a checagem de identidade
          // abstém-se, e "Shaun of the Dead (2004)" entrava na lista de
          // "Dead City" com o 0.600 do token repetido. A metade do ANO da
          // matchesTitleStructure fecha exatamente essa lacuna, sem tocar nos
          // formatos que o prefixo protegeria errado.
          (isSeries ? !yearContradicts(tokens, year, true) : matchesTitleStructure(title, name, year, { tokens })) &&
          matchesEpisodeWorkIdentity(title, names, tokens, universe),
    );
    if (!titleMatches) {
      // Opt-in multiobra: o filtro estrito de título do filme isolado nunca
      // casa "Indiana Jones - A Coleção Completa"; a admissão exige raiz
      // contígua (evidência TMDB) E cobertura explícita do ano no título/dn.
      // Admitido, o ano já foi validado aqui — não re-checa o magnet.
      if (!admitsMultiWorkPack(item, { multiWork, year, isSeries, names })) {
        onRejected?.(item, 'title');
        return false;
      }
      return true;
    }
    // Filme: rejeita release de SÉRIE antes do ano e do episódio. O título do
    // post BR muitas vezes não carrega marcador de temporada ("Resident Evil –
    // A Série – 1ª Temporada"), mas o dn= do magnet sim (S01). Sem este veto,
    // a série entra na lista do filme porque o título não tem ano (yearContradicts
    // não corta) e nada rejeita marcador de temporada em filme.
    //
    // Exceção: se o NOME PROCURADO já tiver o mesmo marcador (ex.: "S1m0ne"),
    // o parser lê temporada 1 no nome e a exceção protege o filme legítimo.
    // "Complete" fica de fora: "Complete Collection" de filmes é legítimo.
    if (!isSeries && season == null) {
      const displayText = `${title} ${magnetDisplayName(item)}`;
      // Remove anos E resoluções antes do parse de temporada:
      // "Pack.Coisa.1994.e.2024.DUAL" normaliza para "pack coisa 1994 e 2024
      // dual", e o parser lê "1994 e 2024" como T19 E94 + E20 E24 (temporada 19,
      // episódios 94/20/24). Sem limpar, qualquer pack com dois anos seria
      // rejeitado como série. O mesmo vale para resoluções: "Inception.2010.
      // 1280x720.BluRay" normaliza para "inception 2010 1280x720 bluray", e o
      // parser lê "80x720" como T80 E720. "1920x1080" escapava porque "1920"
      // parece ano e era apagado; "1280x720" e "3840x2160" não escapam.
      const withoutYears = displayText.replace(/(?:19|20)\d{2}/g, ' ').replace(/\d{3,4}x\d{3,4}/gi, ' ');
      const parsed = parseTitleSeasonEpisode(withoutYears);
      const hasSeasonMarker = parsed.seasons.length > 0 || parsed.episodes.length > 0 || parsed.seasonPack;
      // "a série", "the série", "minissérie" — sem o "series" solto, que mata
      // filmes com esse nome ("A Series of Unfortunate Events", "Series 7").
      const SERIES_LABEL_RE = /\b(?:a|the)\s+s[eé]rie\b|\bminiss[eé]rie\b/i;
      const hasSeriesLabel = SERIES_LABEL_RE.test(displayText);
      if (hasSeasonMarker || hasSeriesLabel) {
        // Exceção: o nome procurado NÃO pode ter o mesmo marcador (temporada)
        // OU conter o mesmo rótulo de série (protege "Series of Unfortunate
        // Events" e "S1m0ne").
        const nameParsed = names.some((n) => {
          const cleaned = n.replace(/(?:19|20)\d{2}/g, ' ').replace(/\d{3,4}x\d{3,4}/gi, ' ');
          const np = parseTitleSeasonEpisode(cleaned);
          return np.seasons.length > 0 || np.episodes.length > 0 || np.seasonPack || SERIES_LABEL_RE.test(n);
        });
        if (!nameParsed) {
          onRejected?.(item, 'movie-is-series');
          return false;
        }
      }
    }
    // Filme: sequel nomeada com ano EXATO diferente (Apocalypse 2004 na
    // busca do Resident Evil 2002) e, em seguida, o dn= do magnet. Séries e
    // o ramo admitsMultiWorkPack (return true acima) ficam de fora.
    // Ano nacional ±1 do post BR não é sequela; Apocalypse/Extinction são globais.
    if (!isSeries && season == null) {
      const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
      if (catalogYear && !item?.isBr && namedSequelContradicts(tokens, universe, catalogYear)) {
        onRejected?.(item, 'named-sequel');
        return false;
      }
      if (catalogYear && magnetYearContradicts(item, catalogYear)) {
        onRejected?.(item, 'magnet-year');
        return false;
      }
    }
    // Séries: se o dn= do magnet contradizer a temporada ou episódio pedido, descarta.
    if (isSeries && season != null && magnetSeasonContradicts(item, season, episode)) {
      onRejected?.(item, 'episode');
      return false;
    }
    if (season == null || episode == null) return true;
    if (!matchesEpisode(title, { season, episode })) {
      onRejected?.(item, 'episode');
      return false;
    }
    if (item?.isBr) return true;
    const matchesWork = matchesGlobalSeriesNoMarker(title, tokens, universe);
    if (!matchesWork) onRejected?.(item, 'series-work');
    return matchesWork;
  });
}

/**
 * Ano verdadeiro escondido no magnet: sites BR publicam o post sem ano no
 * título mapeado ("O Corvo The Crow e Dual"), mas o dn= do magnet preserva o
 * nome real da release. Medido no hdrtorrent: o MESMO post entrega magnets de
 * três filmes ("The Crow (2024)", "O Corvo 1994", "O Corvo (2012)") — e os
 * três se chamam "O Corvo" no Brasil, então nenhum filtro de título separa.
 *
 * Um único ano explícito no magnet contradizendo o catálogo além de ±2 é
 * outra obra. Vários anos em FILME viram intervalo: há contradição quando
 * NENHUM ano fica a ±2 do catálogo E o catálogo fica fora do intervalo
 * [min, max]. Assim "Collection 2002 2016" com catálogo 2004 passa (pack
 * contém o filme), mas "Collection 2002 2016" com catálogo 2026 morre.
 * Resolução (1920x1080) não é ano.
 */
function magnetYearContradicts(item: RawItem | null | undefined, catalogYear: number) {
  const source = magnetDisplayName(item);
  if (!source || !catalogYear) return false;
  const cleaned = source.replace(/\d{3,4}x\d{3,4}/gi, ' ');
  const years = [
    ...new Set(
      [...cleaned.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map((m: any) => Number(m[0])),
    ),
  ];
  if (years.length === 0) return false;
  if (years.length === 1) return Math.abs(years[0] - catalogYear) > 2;
  // Vários anos: intervalo [min, max]. Há contradição quando NENHUM ano fica
  // a ±2 do catálogo E o catálogo está fora do intervalo.
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const someNear = years.some((y) => Math.abs(y - catalogYear) <= 2);
  if (someNear) return false;
  return catalogYear < minYear || catalogYear > maxYear;
}

/**
 * Temporada e episódio no dn= do magnet: sites BR publicam posts com título
 * genérico ("Série Dublada Torrent"), mas o dn= do magnet carrega a identificação
 * real do arquivo ("Serie.S02E01..."). Se o dn= excluir a temporada ou apontar
 * para outro episódio, descarta imediatamente na busca fria.
 */
function magnetSeasonContradicts(item: RawItem | null | undefined, season: number, episode: number | null | undefined) {
  const dn = magnetDisplayName(item);
  if (!dn) return false;
  const parsed = parseTitleSeasonEpisode(dn);
  if (seasonCoverageExcludes(parsed, season)) return true;
  if (episode != null && !matchesEpisode(dn, { season, episode })) return true;
  return false;
}

/**
 * Relevância de item do INVENTÁRIO da conta do debrid: o caminho estrito dos
 * indexers, MAIS uma exceção — pack multi-obra da MESMA franquia.
 *
 * A exceção não vale para o caminho dos indexers, de propósito: resultado de
 * tracker é palpite, coisa na conta é escolha do usuário (e já está paga).
 * Medido: "FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR" pronto
 * no debrid e invisível — "filmografia" não é o começo de nenhum nome da
 * obra e a regra de prefixo do filtro estrito o rejeitava.
 *
 * Só para filme (season == null): pack de franquia de série morreria mesmo
 * assim no corte por episódio, e temporada inteira já passa pelo caminho
 * normal ("Lost Girl (2010) S01-S05").
 *
 */
function filterInventoryRelevant(
  items: RawItem[] = [],
  { names = [], season = null, ...matchContext }: MatchOptions = {},
  onRejected?: (item: RawItem, reason: RelevanceRejectReason) => void,
) {
  if (!names.length) return [];
  const reasons = new Map<RawItem, RelevanceRejectReason>();
  const direct = filterRelevantRaw(items, { names, season, ...matchContext }, (item, reason) => {
    reasons.set(item, reason);
  });
  if (season != null) {
    if (onRejected) for (const item of items) if (!direct.includes(item)) onRejected(item, reasons.get(item) || 'title');
    return direct;
  }
  const directSet = new Set(direct);
  const leftovers = items.filter((item) => !directSet.has(item));
  if (!leftovers.length) return direct;
  const roots = franchiseRoots(names);
  if (!roots.length) {
    if (onRejected) for (const item of leftovers) onRejected(item, reasons.get(item) || 'title');
    return direct;
  }
  const extra = leftovers.filter((item) => {
    const title = item?.title || item?.Title || '';
    return isMultiWorkCollection(title) && roots.some((root) => containsTokenRun(title, root));
  });
  if (onRejected) {
    const rescued = new Set(extra);
    for (const item of leftovers) if (!rescued.has(item)) onRejected(item, reasons.get(item) || 'title');
  }
  return extra.length ? [...direct, ...extra] : direct;
}

export {
  filterRelevantRaw,
  filterInventoryRelevant,
  magnetYearContradicts,
  magnetSeasonContradicts,
};
