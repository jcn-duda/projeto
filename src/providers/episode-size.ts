import type { Stream } from '../../types/domain.js';
import { isSeasonPackRelease, parseTitleSeasonEpisode, UNKNOWN_QUALITY } from '../utils/format.js';
import { hasFileSizes } from '../debrid/file-sizes.js';
import { rustAnnotateEpisodeSizes } from '../utils/rust-episode-size.js';
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
// Sem nenhuma das duas, o total do torrent NÃO fica na linha: o
// corte do total em texto (no Rust) o tira do texto, que é o último
// canal de que o app Power Movie lê tamanho.
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

// Título que nomeia VÁRIOS episódios ("S01.Dub E01-E08", "Capítulo 086 ao 123"
// de novela): não é pack de temporada para o `isSeasonPackRelease`, mas o
// torrent cobre vários episódios — nenhum tamanho do texto é o do episódio.
function namesMultipleEpisodes(title: string): boolean {
  return parseTitleSeasonEpisode(title).episodes.length > 1;
}

/**
 * Hashes que o memo ainda não conhece — pack da temporada, item sem 💾 e item
 * sem resolução: é a
 * lista que a checagem de cache recebe para ler arquivos na mesma passada.
 * Episódio avulso COM 💾 fica de fora: o total dele já é o do episódio.
 */
function packHashesMissingFiles(streams: Array<Stream | null>, season: number | null | undefined): string[] {
  const out = new Set<string>();
  for (const stream of streams) {
    // Hash ausente viraria a string "undefined" na fila de leitura do debrid.
    if (!stream || !stream.infoHash) continue;
    // Em filme, o "pack" é a coleção de várias obras marcada no título.
    // Faixa multi-episódio nomeada ("S01.Dub E01-E08", capítulos de novela)
    // também pede a lista: o tamanho dela é o total da faixa, e o episódio só
    // se mede com os arquivos.
    const pack = season == null
      ? isMultiWorkPack(stream)
      : isPack(stream, season) || namesMultipleEpisodes(String(stream.title || ''));
    // Sem 💾 também pede a lista: é a única fonte do tamanho desse item. Sem
    // resolução no título também: o nome do arquivo é a fonte dela
    // (`probed-quality.ts`) — "S01.Dub E01-E08" de 10 GB saía sem resolução.
    const noQuality = stream._quality === UNKNOWN_QUALITY;
    if (!pack && !lacksSize(stream) && !noQuality) continue;
    const hash = String(stream.infoHash).toLowerCase();
    if (!hasFileSizes(hash)) out.add(hash);
  }
  return [...out];
}

type AnnotateOptions = {
  season?: number | null;
  episode?: number | null;
  meta?: EpisodeMeta;
  work?: WorkHintInput;
  /** Hashes com checagem conhecida: liga o dedupe de pack repetido. */
  cached?: ReadonlySet<string> | null;
  /** Aceito pelo contrato; o Rust não emite os eventos `episodeSize.*`. */
  trace?: StreamTraceState | null;
  /**
   * Passada da anotação: `build` é a de antes do debrid e `debrid` a de depois.
   * O Rust anota o lote que recebe e não distingue as passadas; o campo segue
   * no contrato do oráculo (`test/helpers/pipeline-oracle`).
   */
  stage?: 'build' | 'debrid';
};

/**
 * Tamanho do episódio/filme em pack e o 💾 de quem veio sem tamanho, no Rust
 * (`rust-episode-size.ts`): o Node só lê os caches `fsz`/`tsz`.
 */
function annotateEpisodeSizes<T extends Stream | null>(streams: T[], options: AnnotateOptions = {}): T[] {
  return rustAnnotateEpisodeSizes(streams, options) as T[];
}

export {
  annotateEpisodeSizes, packHashesMissingFiles, streamTitleBytes, streamSizeLabel,
};
