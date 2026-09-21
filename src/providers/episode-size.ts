import type { Stream } from '../../types/domain.js';
import { bytesToSize, isSeasonPackRelease, parseTitleSeasonEpisode } from '../utils/format.js';
import { pickFile } from '../debrid/file-selector.js';
import { peekFileSizes, hasFileSizes } from '../debrid/file-sizes.js';
import { stageTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';

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
// O marcador `💾` continua seguido só de número e unidade, e o total do pack
// vai num marcador separado. `_size` não muda — o filtro de tamanho máximo
// segue valendo para o download inteiro.
//
// O Power Movie NÃO lê o `💾`: o chip sai de `json.size`, depois de
// `behaviorHints.videoSize`, e por último do PRIMEIRO "N GB" do texto
// (`_resolveStreamSize` em E:\POWER-MOVIE). Em pack BR o primeiro número é o do
// nome do post ("[1080p DUBLADO 12.41 GB]"), e o chip mostrava o pack inteiro ao
// lado de um `💾 1.55 GB` correto (True Detective S01E01, 2026-09-20). Por isso
// `streamSizeLabel` expõe o rótulo do `💾` para a resposta publicar em `size`.

type EpisodeMeta = { episodes?: Record<string, number> } | null | undefined;
type PackCandidate = Parameters<typeof isSeasonPackRelease>[0];

const SIZE_MARK = /💾 (\d+(?:\.\d+)? (?:B|KB|MB|GB|TB))/u;
const PACK_MARK = '📦 pack';
const UNIT_POWER: Record<string, number> = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };

// Inverso do bytesToSize para o rótulo capturado pelo SIZE_MARK ("5.20 GB").
function parseSizeLabel(label: string): number {
  const [value, unit] = label.split(' ');
  const power = UNIT_POWER[unit];
  const n = Number(value);
  return power == null || !Number.isFinite(n) ? 0 : Math.round(n * 1024 ** power);
}

const PACK_TOTAL_MARK = /📦 pack (\d+(?:\.\d+)? (?:B|KB|MB|GB|TB))/u;

/**
 * Tamanho do DOWNLOAD que o título do stream anuncia, para quem recebe o
 * stream depois do sortAndLimit (que apaga `_size`). Em pack anotado o 💾 já é
 * o episódio; o total fica no "📦 pack".
 */
function streamTitleBytes(title: unknown): number {
  const text = String(title || '');
  const match = text.match(PACK_TOTAL_MARK) || text.match(SIZE_MARK);
  return match ? parseSizeLabel(match[1]) : 0;
}

/**
 * Rótulo do `💾` ("1.55 GB") para o campo `size` da resposta. Só MB/GB/TB: o
 * tracker às vezes publica o tamanho do .torrent ("65.95 KB" num 1080p) e o
 * app, que ignora KB no próprio regex, hoje não mostra chip nenhum ali —
 * publicar o KB trocaria "sem tamanho" por um tamanho errado.
 */
function streamSizeLabel(title: unknown): string | null {
  const match = String(title || '').match(SIZE_MARK);
  if (!match || !/ (?:MB|GB|TB)$/.test(match[1])) return null;
  return match[1];
}

function isPack(stream: Stream | null | undefined, season: number): boolean {
  return Boolean(stream?.infoHash) && isSeasonPackRelease(stream as PackCandidate, season);
}

function isMultiWorkPack(stream: Stream | null | undefined): boolean {
  return Boolean(stream?.infoHash) && Boolean((stream as { _multiWork?: boolean })._multiWork);
}

type WorkHintInput = { n: string[]; y: number | null } | null | undefined;

// Stream que chegou sem 💾: o indexer não publicou tamanho (o Torrentdosfilmes
// carimba 1024 bytes em post "opção 2", e o `UNKNOWN_SIZE_MAX` descarta).
// O magnet não carrega tamanho; só o debrid que já tem o hash sabe.
const SEEDER_MARK = /👤 ~?\d*/u;

function lacksSize(stream: Stream | null | undefined): boolean {
  return Boolean(stream?.infoHash) && typeof stream?.title === 'string'
    && !SIZE_MARK.test(stream.title) && SEEDER_MARK.test(stream.title);
}

/**
 * Preenche o 💾 de quem veio sem tamanho, com o arquivo que o play tocaria
 * (mesmo `pickFile`). Só medida exata: sem lista de arquivos, segue sem 💾.
 * `_size` não muda — o filtro de tamanho já tratou o item como desconhecido.
 */
function fillMissingSizes<T extends Stream | null>(
  streams: T[],
  { season, episode, work, trace }: {
    season?: number | null; episode?: number | null; work?: WorkHintInput; trace?: StreamTraceState | null;
  },
): T[] {
  return streams.map((stream) => {
    if (!stream || !lacksSize(stream)) return stream;
    const multiWork = season == null && isMultiWorkPack(stream);
    // Coleção sem a obra marcada: o maior arquivo não é o filme pedido.
    if (multiWork && !work?.n?.length) return stream;
    const files = peekFileSizes(String(stream.infoHash));
    if (!files) return stream;
    let bytes = 0;
    try {
      const hint = season != null
        ? { season, episode }
        : multiWork && work?.n?.length
          ? { work: { names: work.n, year: work.y, pack: true } }
          : {};
      bytes = Number(pickFile(files, hint)?.size) || 0;
    } catch {
      bytes = 0;
    }
    const label = bytes ? bytesToSize(bytes) : '';
    if (!label) { stageTrace(trace, 'episodeSize.skip.fill-pick-failed', 1); return stream; }
    stageTrace(trace, 'episodeSize.filled', 1);
    return { ...stream, title: String(stream.title).replace(SEEDER_MARK, (seeds) => `${seeds} 💾 ${label}`) };
  }) as T[];
}

// Filme dentro de coleção ("FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS", 22.45 GB
// em Star Trek 2009, 2026-09-13). Só a medida exata vale: filmes de uma coleção
// não têm tamanhos parecidos, então não existe média honesta. O arquivo é o que
// o /resolve tocaria — pickFile com a dica da obra marcada como pack.
function annotateMovieSizes<T extends Stream | null>(streams: T[], work: WorkHintInput, trace?: StreamTraceState | null): T[] {
  if (!work?.n?.length) return streams;
  const skip = (reason: string) => stageTrace(trace, `episodeSize.skip.movie-${reason}`, 1);
  return streams.map((stream) => {
    if (!stream || typeof stream.title !== 'string' || stream.title.includes(PACK_MARK)) return stream;
    if ((stream as { _packBytes?: number })._packBytes) return stream;
    if (!isMultiWorkPack(stream)) return stream;
    if ((stream as { _indexer?: string })._indexer === 'torrentio') { skip('per-file-size'); return stream; }
    const match = stream.title.match(SIZE_MARK);
    if (!match) { skip('no-size-mark'); return stream; }
    const files = peekFileSizes(String(stream.infoHash));
    if (!files) { skip('no-files'); return stream; }
    let bytes = 0;
    try {
      bytes = Number(pickFile(files, { work: { names: work.n, year: work.y, pack: true } })?.size) || 0;
    } catch {
      // Coleção sem arquivo casando a obra: o play decide (e falha explícito).
      bytes = 0;
    }
    if (!bytes) { skip('pick-failed'); return stream; }
    const packBytes = Number((stream as { _size?: number })._size) || parseSizeLabel(match[1]);
    if (packBytes > 0 && bytes >= packBytes) { skip('not-smaller'); return stream; }
    const label = bytesToSize(bytes);
    if (!label) { skip('no-label'); return stream; }
    stageTrace(trace, 'episodeSize.movie.exact', 1);
    // Filme marca só o FILME: quem escolhe um filme numa coleção quer o tamanho
    // dele, e o total da coleção na linha fazia o cliente (Power Movie) mostrar
    // 22.45 GB no chip. O total segue em `_packBytes`, interno, para quem
    // precisa do tamanho do download (índice do autofetch).
    return {
      ...stream,
      title: stream.title.replace(SIZE_MARK, `💾 ${label}`),
      _packBytes: packBytes,
    };
  }) as T[];
}

/**
 * Hashes que o memo ainda não conhece — pack da temporada e item sem 💾: é a
 * lista que a checagem de cache recebe para ler arquivos na mesma passada.
 * Episódio avulso COM 💾 fica de fora: o total dele já é o do episódio.
 */
function packHashesMissingFiles(streams: Array<Stream | null>, season: number | null | undefined): string[] {
  const out = new Set<string>();
  for (const stream of streams) {
    if (!stream) continue;
    // Em filme, o "pack" é a coleção de várias obras marcada no título.
    const pack = season == null ? isMultiWorkPack(stream) : isPack(stream, season);
    // Sem 💾 também pede a lista: é a única fonte do tamanho desse item.
    if (!pack && !lacksSize(stream)) continue;
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

function annotatePackSizes<T extends Stream | null>(
  streams: T[],
  {
    season, episode, meta, work, trace,
  }: {
    season?: number | null;
    episode?: number | null;
    meta?: EpisodeMeta;
    work?: WorkHintInput;
    trace?: StreamTraceState | null;
  } = {},
): T[] {
  if (season == null) return annotateMovieSizes(streams, work, trace);
  if (episode == null) return streams;
  // Por que um pack ficou sem o tamanho do episódio, no funil do stream-trace:
  // "sem 💾", sem contagem de episódios, medida maior que o pack… Sem isso a
  // ausência da anotação na lista não diz qual regra a segurou.
  const skip = (reason: string) => stageTrace(trace, `episodeSize.skip.${reason}`, 1);
  return streams.map((stream) => {
    if (!stream || typeof stream.title !== 'string' || stream.title.includes(PACK_MARK)) return stream;
    if (!isPack(stream, season)) return stream;
    // O Torrentio já responde por episódio: o 💾 dele é o tamanho do ARQUIVO
    // escolhido, não do torrent. Quando o nome do arquivo não traz SxxEyy
    // ("01 Adim Farah.avi"), o título parece pack e a média dividiria um
    // episódio de 1.36 GB pelos episódios da temporada.
    if ((stream as { _indexer?: string })._indexer === 'torrentio') { skip('per-file-size'); return stream; }
    const match = stream.title.match(SIZE_MARK);
    if (!match) { skip('no-size-mark'); return stream; }
    // `_size` não chega aqui: o sortAndLimit apaga `_seeders`/`_size` dos
    // candidatos antes do debrid, e a média caía sempre em "no-pack-size"
    // (medido em My Name Is Earl S01E01, 2026-09-13). O total que o próprio
    // título anuncia é a mesma medida, arredondada em duas casas.
    const packBytes = Number((stream as { _size?: number })._size) || parseSizeLabel(match[1]);
    const exact = exactEpisodeBytes(String(stream.infoHash), season, episode);
    const count = exact ? 0 : episodesCovered(stream.title, season, meta);
    if (!exact && !packBytes) { skip('no-pack-size'); return stream; }
    if (!exact && count <= 1) { skip('no-episode-count'); return stream; }
    const bytes = exact || Math.round(packBytes / count);
    // Pack de um arquivo só (ou medida maior que o total) não tem o que mostrar.
    if (packBytes > 0 && bytes >= packBytes) { skip(exact ? 'exact-not-smaller' : 'avg-not-smaller'); return stream; }
    const label = bytesToSize(bytes);
    if (!label) { skip('no-label'); return stream; }
    stageTrace(trace, exact ? 'episodeSize.exact' : 'episodeSize.average', 1);
    const note = exact ? '' : ' (média)';
    const title = stream.title.replace(SIZE_MARK, `💾 ${label} ${PACK_MARK} ${match[1]}${note}`);
    return { ...stream, title };
  }) as T[];
}

type AnnotateOptions = Parameters<typeof annotatePackSizes>[1];

/** Tamanho do episódio/filme em pack, e o 💾 de quem veio sem tamanho. */
function annotateEpisodeSizes<T extends Stream | null>(streams: T[], options: AnnotateOptions = {}): T[] {
  const { season, episode } = options;
  const out = annotatePackSizes(streams, options);
  // Série sem episódio não tem arquivo único para medir.
  if (season != null && episode == null) return out;
  return fillMissingSizes(out, options);
}

export { annotateEpisodeSizes, packHashesMissingFiles, streamTitleBytes, streamSizeLabel };
