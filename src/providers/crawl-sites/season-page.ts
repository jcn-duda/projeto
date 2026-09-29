// Páginas de SÉRIE dos WordPress BR, na MESMA régua do Vaca
// (`declaredSeriesLocation` + `groupSeriesReleases`) — nenhuma regra nova. São
// duas formas, porque o dado nasce em lugares diferentes:
//
//   - `seasonPageGroups`: página que declara UMA temporada no post
//     (NerdFilmes, TorrentDosFilmes, ComandoTorrents). A temporada vem do
//     `<h1>`/slug e o botão decide o resto.
//   - `seriesRowGroups`: página que AGREGA temporadas (RedeTorrent, medido em
//     2026-09-29 em 12 páginas reais / 79 linhas). A temporada vem da LINHA
//     (`dn=` do magnet, com a coluna `S0N` do post como reserva) e o `<h1>` —
//     que lista ordinais — não é temporada de ninguém.
//
// Medido em 2026-09-28 (8 posts de temporada por site): o `dn=` do magnet
// declara episódio ou pack em 92 de 97 botões no TorrentDosFilmes e em 49 de
// 50 no ComandoTorrents, e nunca contradiz a temporada do post. No NerdFilmes
// o `dn=` vinha cortado no primeiro espaço (consertado no extrator) e o
// episódio está no rótulo do botão ("Lanternas 1ª Temporada E01 [1080p
// DUBLADO]"), que o profile já põe no título da release. Precedência: o `dn`
// (conteúdo) vence o rótulo, que vence a temporada da página — e o post que
// diz "E01" com magnet de temporada COMPLETA vai para a temporada, não para o
// episódio (medido: "Minhas Aventuras com o Superman 2ª Temporada E01 [1080p
// LEGENDADO]" com `dn=My.Adventures.with.Superman.S02.COMPLETE`).
import type { RawItem } from '../../../types/domain.js';
import { parseTitleSeasonEpisode } from '../../utils/episode-matching.js';
import { magnetDisplayName } from '../../utils/title-normalization.js';
import type { CrawlReleaseGroup } from '../crawl-types.js';
import {
  declaredSeriesLocation, decodeEvidence, groupSeriesReleases, type SeriesReleaseEntry,
} from './vaca-series-locate.js';

/**
 * Uma LINHA de release de página que agrega temporadas. `rowSeason` é a coluna
 * de temporada que o `parsePostLinks` leu na linha (`S0N`); o `dn=` do magnet
 * — que é conteúdo — vence ela, e é por isso que os dois entram juntos.
 */
export interface SeriesRow {
  release: RawItem;
  rowSeason: number | null;
}

/** Temporada ÚNICA que o texto declara; `null` se nenhuma ou mais de uma. */
function singleSeason(text: string): number | null {
  const parsed = parseTitleSeasonEpisode(decodeEvidence(text));
  return parsed.seasons.length === 1 && !parsed.complete ? parsed.seasons[0] : null;
}

/**
 * Temporada do POST: o `<h1>` primeiro ("Better Call Saul 4ª Temporada"), o
 * slug como reserva (`/kingdom-1a-temporada-720phdtv-2014-…/` — o `<h1>` do
 * TorrentDosFilmes às vezes é só "Kingdom"). `null` quando nenhum dos dois
 * declara UMA temporada: aí só o `dn`/rótulo de cada botão decide.
 */
export function pageSeasonOf(h1: string, url: string): number | null {
  const fromTitle = singleSeason(h1);
  if (fromTitle != null) return fromTitle;
  let slug = '';
  try {
    slug = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  return singleSeason(slug.replace(/[-_/]+/g, ' '));
}

/**
 * Grupos por locação dos botões de UMA página de temporada. O episódio do
 * rótulo sai do título da release (o profile já o escreve), e o `dn` real do
 * magnet decide antes dele. O veto de adaptação (`year`) fica desligado: o ano
 * do post de temporada é o da TEMPORADA, não o da estreia que ele espera.
 */
export function seasonPageGroups(
  releases: readonly RawItem[],
  page: { season: number | null; title: string },
): CrawlReleaseGroup[] {
  const entries = releases.map((release) => {
    const request = declaredSeriesLocation({
      cardSeason: page.season,
      cardTitle: page.title,
      isBatch: false,
      realTitle: null,
      dn: magnetDisplayName(release) || null,
      linkEpisode: labelEpisode(String(release.title || ''), page.season),
    });
    return { release, request };
  });
  // Botão cujo `dn` declara temporada: agrupa pela locação JÁ decidida acima
  // (`byDeclaredLocation`, `dn` > rótulo > post). Sem isso o
  // `releaseWorkTargets` recalculava pelo título da release e, no empate de
  // especificidade título × `dn`, ficava com o TÍTULO — que aqui é o rótulo do
  // site com a temporada do POST. Medido em 2026-09-29 (NerdFilmes): "Euphoria
  // 2ª Temporada E00" com `dn=Euphoria.Us.S01E00.Especial` ia para S2E0; o
  // mesmo valia para qualquer episódio de outra temporada no post (dn S01E03 →
  // S2E3). Sem `dn` que declare, o caminho é o de antes: o rótulo pode trazer a
  // PRÓPRIA temporada ("Lanternas 1ª Temporada E03"), e a locação decidida só
  // guarda o episódio dele.
  const byDn = entries.filter((e) => dnDeclaresSeason(e.release));
  const rest = entries.filter((e) => !dnDeclaresSeason(e.release));
  return mergeGroups([
    ...groupSeriesReleases(byDn, { year: null, byDeclaredLocation: true }),
    ...groupSeriesReleases(rest, { year: null }),
  ]);
}

function dnDeclaresSeason(release: RawItem): boolean {
  const dn = magnetDisplayName(release);
  return Boolean(dn) && parseTitleSeasonEpisode(decodeEvidence(dn)).seasons.length > 0;
}

/** Junta grupos da mesma locação, na ordem do `groupSeriesReleases` (raiz por último). */
function mergeGroups(groups: CrawlReleaseGroup[]): CrawlReleaseGroup[] {
  const byKey = new Map<string, CrawlReleaseGroup>();
  for (const g of groups) {
    const key = `${g.season ?? -1}:${g.episode ?? -1}`;
    const into = byKey.get(key);
    if (into) into.releases.push(...g.releases);
    else byKey.set(key, { season: g.season, episode: g.episode, releases: [...g.releases] });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.season == null && b.season != null) return 1;
    if (b.season == null && a.season != null) return -1;
    if (a.season !== b.season) return (a.season ?? 0) - (b.season ?? 0);
    return (a.episode ?? -1) - (b.episode ?? -1);
  });
}

/**
 * Grupos por locação das LINHAS de uma página que AGREGA temporadas — o caso do
 * RedeTorrent, onde um post `/series/` lista as temporadas todas ("Community
 * (2009) 1ª 2ª 3ª 4ª 5ª 6ª Temporada", 7 linhas) e o `<h1>` NÃO é a temporada
 * de ninguém. Por isso o `cardTitle` vai VAZIO de propósito: a lista de
 * ordinais do título mandaria tudo para a raiz.
 *
 * Evidência por linha, na precedência da régua do Vaca: o `dn=` do magnet (que
 * é conteúdo) vence a coluna `S0N` que o `parsePostLinks` lê. Medido em
 * 2026-09-29 em 12 páginas reais (79 linhas): `dn=` declara em 77, a coluna
 * `S0N` em 1, nenhuma evidência em 1, contradição entre as duas em 0.
 *
 * Linha SEM evidência nenhuma é DESCARTADA, não vai para a raiz: a raiz é a
 * locação que este módulo não pode afirmar, e o agrupamento é por
 * `byDeclaredLocation` (o `releaseWorkTargets` leria a lista de ordinais do
 * `<h1>` que o profile copia para o título da release e devolveria a linha na
 * raiz ALÉM da temporada — ver `vaca-series-locate.ts`).
 */
export function seriesRowGroups(rows: readonly SeriesRow[]): CrawlReleaseGroup[] {
  const entries: SeriesReleaseEntry[] = [];
  for (const { release, rowSeason } of rows) {
    const request = declaredSeriesLocation({
      cardSeason: rowSeason,
      cardTitle: '',
      isBatch: false,
      realTitle: null,
      dn: magnetDisplayName(release) || null,
      linkEpisode: null,
    });
    // `locationOfParse` devolve `{null, null}` junto quando nada declara.
    if (request.season == null) continue;
    entries.push({ release, request });
  }
  // Veto de identidade desligado pelo mesmo motivo do `seasonPageGroups`: o ano
  // da página aqui é o da ÚLTIMA temporada publicada, não o da estreia.
  return groupSeriesReleases(entries, { year: null, byDeclaredLocation: true });
}

/**
 * Episódio do RÓTULO do botão. O ComandoTorrents tira a temporada do título da
 * release ("The Boys E01 [1080p WEB-DL DUBLADO]") e um "E01" solto não é
 * episódio sem temporada: sem ler com a temporada do POST, o botão de UM
 * episódio caía no grupo da temporada inteira — e aparecia como pack para todo
 * episódio dela, com o play dos outros quebrando. Lido junto da temporada da
 * página, só vale se o parse devolver essa MESMA temporada e um episódio.
 */
function labelEpisode(title: string, pageSeason: number | null): number | null {
  const own = parseTitleSeasonEpisode(decodeEvidence(title));
  if (own.episodes.length === 1) return own.episodes[0];
  if (pageSeason == null || own.seasons.length > 0 || own.complete) return null;
  const withSeason = parseTitleSeasonEpisode(decodeEvidence(`${pageSeason}ª Temporada ${title}`));
  const sameSeason = withSeason.seasons.length === 1 && withSeason.seasons[0] === pageSeason;
  return sameSeason && withSeason.episodes.length === 1 ? withSeason.episodes[0] : null;
}
