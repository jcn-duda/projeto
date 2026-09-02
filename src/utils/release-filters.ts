import type { RawItem } from '../../types/domain.js';
import { matchesEpisode } from './episode-matching.js';
import { titleTokens } from './matching-vocabulary.js';
import { yearContradicts } from './matching-tokens.js';
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

interface MatchOptions {
  names?: string[];
  year?: number | string | null;
  isSeries?: boolean;
  season?: number | null;
  episode?: number | null;
  allNames?: string[] | null;
  tokens?: string[] | null;
  universeTokens?: string[] | null;
}

/**
 * Classificação crua compartilhada pelo corte final e pelo gatilho de pack.
 * Usar uma função só impede o fallback de discordar do que buildStreams vai
 * descartar alguns milissegundos depois.
 *
 */
function filterRelevantRaw(
  items: RawItem[] = [],
  { names = [], year = null, isSeries = false, season = null, episode = null }: MatchOptions = {},
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
    if (!titleMatches) return false;
    // Filme: o dn= do magnet carrega o ano verdadeiro quando o título
    // mapeado não traz (e confirma quando traz). Séries ficam de fora — o
    // ano do post delas é o da temporada, com regra própria acima.
    if (!isSeries && season == null) {
      const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
      if (catalogYear && magnetYearContradicts(item, catalogYear)) return false;
    }
    if (season == null || episode == null) return true;
    if (!matchesEpisode(title, { season, episode })) return false;
    if (item?.isBr) return true;
    return matchesGlobalSeriesNoMarker(title, tokens, universe);
  });
}

/**
 * Ano verdadeiro escondido no magnet: sites BR publicam o post sem ano no
 * título mapeado ("O Corvo The Crow e Dual"), mas o dn= do magnet preserva o
 * nome real da release. Medido no hdrtorrent: o MESMO post entrega magnets de
 * três filmes ("The Crow (2024)", "O Corvo 1994", "O Corvo (2012)") — e os
 * três se chamam "O Corvo" no Brasil, então nenhum filtro de título separa.
 * Um único ano explícito no magnet contradizendo o catálogo além de ±2 é
 * outra obra. Vários anos é ambíguo e passa, na mesma régua das regras de
 * título; resolução (1920x1080) não é ano.
 */
function magnetYearContradicts(item: RawItem | null | undefined, catalogYear: number) {
  const raw = String(item?.magnet || item?.MagnetUri || item?.Guid || '');
  if (!raw || !catalogYear) return false;
  // Só analisa o dn= de um magnet real. URLs de protetor de link (http/https)
  // não contêm informação de release — o slug do post pode citar qualquer ano
  // da franquia. Medido no nerdviatorrents: slug "exterminio-2025" mata o filme
  // correto de 2002 porque |2025-2002|=23>2.
  const isMagnet = /^magnet:/i.test(raw.trim());
  let source: string;
  if (isMagnet) {
    // Extrai APENAS o dn= do magnet: é onde a release declara o nome/ano real.
    const dnMatch = raw.match(/[&?]dn=([^&]+)/i);
    source = dnMatch ? dnMatch[1] : '';
  } else {
    // URL de protetor/resolver: sem dn=, sem evidência de ano da release.
    return false;
  }
  if (!source) return false;
  // O dn= viaja percent-encoded ("O%20Corvo%201994"): sem decodificar, o '0'
  // do %20 cola no ano e a fronteira de dígito esconde exatamente o ano
  // verdadeiro que esta guarda procura. '+' é espaço na forma magnet.
  source = source.replace(/\+/g, ' ');
  try {
    source = decodeURIComponent(source);
  } catch {
    /* sequência % malformada: segue com o texto que decodificou até aqui */
  }
  const cleaned = source.replace(/\d{3,4}x\d{3,4}/gi, ' ');
  const years = [
    ...new Set(
      [...cleaned.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)].map((m: any) => Number(m[0])),
    ),
  ];
  return years.length === 1 && Math.abs(years[0] - catalogYear) > 2;
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
) {
  if (!names.length) return [];
  const direct = filterRelevantRaw(items, { names, season, ...matchContext });
  if (season != null) return direct;
  const directSet = new Set(direct);
  const leftovers = items.filter((item) => !directSet.has(item));
  if (!leftovers.length) return direct;
  const roots = franchiseRoots(names);
  if (!roots.length) return direct;
  const extra = leftovers.filter((item) => {
    const title = item?.title || item?.Title || '';
    return isMultiWorkCollection(title) && roots.some((root) => containsTokenRun(title, root));
  });
  return extra.length ? [...direct, ...extra] : direct;
}

export {
  filterRelevantRaw,
  filterInventoryRelevant,
  magnetYearContradicts,
};
