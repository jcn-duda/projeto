import type { Stream } from '../../types/domain.js';
import { bytesToSize, isSeasonPackRelease, parseTitleSeasonEpisode } from '../utils/format.js';
import { pickFile } from '../debrid/file-selector.js';
import { peekFileSizes, hasFileSizes } from '../debrid/file-sizes.js';

// Tamanho do EPISÓDIO numa release que é pack da temporada. O tracker publica
// só o total ("41.67 GB" de oito episódios em 4K), e a linha do stream dizia
// isso ao lado de uma escolha que toca UM episódio.
//
// Duas fontes, em ordem de confiança:
//   1. exato — a lista de arquivos do hash já vista por algum debrid
//      (`file-sizes.ts`) e o mesmo `pickFile` do play escolhendo o episódio;
//   2. média — total do pack ÷ episódios da temporada no Cinemeta, marcada
//      como "(média)" para não passar por medida.
//
// O marcador `💾` continua seguido só de número e unidade: é por ele que o
// Stremio e o Power Movie montam o chip de tamanho. O total do pack vai num
// marcador separado. `_size` não muda — o filtro de tamanho máximo segue
// valendo para o download inteiro.

type EpisodeMeta = { episodes?: Record<string, number> } | null | undefined;
type PackCandidate = Parameters<typeof isSeasonPackRelease>[0];

const SIZE_MARK = /💾 (\d+(?:\.\d+)? (?:B|KB|MB|GB|TB))/u;
const PACK_MARK = '📦 pack';

function isPack(stream: Stream | null | undefined, season: number): boolean {
  return Boolean(stream?.infoHash) && isSeasonPackRelease(stream as PackCandidate, season);
}

/**
 * Hashes de pack da temporada que o memo ainda não conhece: é a lista que a
 * checagem de cache recebe para ler arquivos na mesma passada (só pack, para
 * não gastar chamada em episódio avulso, cujo total já é o do episódio).
 */
function packHashesMissingFiles(streams: Array<Stream | null>, season: number | null | undefined): string[] {
  if (season == null) return [];
  const out = new Set<string>();
  for (const stream of streams) {
    if (!stream || !isPack(stream, season)) continue;
    const hash = String(stream.infoHash).toLowerCase();
    if (!hasFileSizes(hash)) out.add(hash);
  }
  return [...out];
}

// Episódios que o pack cobre. "S01 S04"/"S01-S04" soma as temporadas do
// intervalo e "Complete Series" soma todas: dividir 70 GB de quatro temporadas
// pelos 24 episódios da primeira triplicava a média. Faltando a contagem de
// alguma temporada coberta, não há média honesta (0).
function episodesCovered(title: string, season: number, meta: EpisodeMeta): number {
  const bySeason = meta?.episodes || {};
  const { seasons, complete } = parseTitleSeasonEpisode(title);
  let wanted = [season];
  if (seasons.length > 1) {
    const low = Math.min(...seasons);
    wanted = Array.from({ length: Math.max(...seasons) - low + 1 }, (_, i) => low + i);
  } else if (complete && !seasons.length) {
    wanted = Object.keys(bySeason).map(Number);
  }
  let total = 0;
  for (const s of wanted) {
    const n = Number(bySeason[String(s)]) || 0;
    if (!n) return 0;
    total += n;
  }
  return total;
}

function exactEpisodeBytes(infoHash: string, season: number, episode: number): number {
  const files = peekFileSizes(infoHash);
  if (!files) return 0;
  try {
    return Number(pickFile(files, { season, episode })?.size) || 0;
  } catch {
    // Pack sem o episódio ou com arquivos ambíguos: a média ainda informa, e o
    // play continua decidindo o arquivo com as mesmas regras.
    return 0;
  }
}

function annotateEpisodeSizes<T extends Stream | null>(
  streams: T[],
  { season, episode, meta }: { season?: number | null; episode?: number | null; meta?: EpisodeMeta } = {},
): T[] {
  if (season == null || episode == null) return streams;
  return streams.map((stream) => {
    if (!stream || typeof stream.title !== 'string' || stream.title.includes(PACK_MARK)) return stream;
    if (!isPack(stream, season)) return stream;
    const match = stream.title.match(SIZE_MARK);
    if (!match) return stream;
    const packBytes = Number((stream as { _size?: number })._size) || 0;
    const exact = exactEpisodeBytes(String(stream.infoHash), season, episode);
    const count = exact ? 0 : episodesCovered(stream.title, season, meta);
    const bytes = exact || (count > 1 && packBytes > 0 ? Math.round(packBytes / count) : 0);
    // Pack de um arquivo só (ou medida maior que o total) não tem o que mostrar.
    if (!bytes || (packBytes > 0 && bytes >= packBytes)) return stream;
    const label = bytesToSize(bytes);
    if (!label) return stream;
    const note = exact ? '' : ' (média)';
    const title = stream.title.replace(SIZE_MARK, `💾 ${label} ${PACK_MARK} ${match[1]}${note}`);
    return { ...stream, title };
  }) as T[];
}

export { annotateEpisodeSizes, packHashesMissingFiles };
