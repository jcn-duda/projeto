// Política do TOTAL de um torrent multi-episódio no TEXTO do stream.
//
// O fallback do Power Movie lê o PRIMEIRO "N GB" de description+title+name
// quando não há `size` nem `behaviorHints.videoSize` (`_resolveStreamSize` em
// E:\POWER-MOVIE). Motivo medido (Jesus S01E01, Apache, 2026-10-07): o post BR
// publica o tamanho no próprio título ("…Temporada Completa 30GB") e o tamanho
// que o Jackett manda é sentinela (1 KB → sem 💾), então nem `size` existia na
// resposta — o chip do app mostrava 30 GB lido do texto. A devolução do
// `fillTorrentTotals` (episode-size.ts) só protegia o total SINTÉTICO do
// serviço; o do tracker (💾 que a anotação não reduziu, ou número no post)
// ficava.
//
// Multi-episódio = pack de temporada (isSeasonPackRelease) ou título que nomeia
// VÁRIOS episódios cobrindo o pedido ("S01.Dub E01-E08", "Capítulo 086 ao 123"
// de novela) — o `isSeasonPackRelease` devolve false nesses títulos justamente
// porque eles nomeiam episódios, mas o torrent também cobre vários, e nenhum
// tamanho do texto é o do episódio. Sem medida do episódio, o total sai da
// linha (os canais que o cliente lê) e segue interno em `_packBytes` (índice do
// autofetch e dedupe de pack). Anotado (`📦 pack`) não entra: o 💾 dele já é o
// episódio, e o `size` publicado vence o fallback de texto.
import type { Stream } from '../../types/domain.js';
import { isSeasonPackRelease, parseTitleSeasonEpisode } from '../utils/format.js';
import { stageTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';

const PACK_MARK = '📦 pack';

// Mesmo padrão do regex do app, incluindo o `\b`, que barra a p de "1080p" e
// token colado; engole o 💾 que sobrou de marca não reduzida. KB/B ficam: o
// app ignora essas unidades no próprio regex (tamanho de .torrent, não de
// vídeo) e apagá-las não mudaria chip nenhum.
const TEXT_SIZE_TOKEN = /\s*(?:💾\s*)?\d+(?:[.,]\d+)?\s*(?:GIB|GB|MIB|MB|TIB|TB)\b/giu;

const UNIT_POWER: Record<string, number> = { MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 };

// Inverso do bytesToSize para um token capturado acima ("30GB", "41.67 GB").
function tokenBytes(token: string): number {
  const match = token.match(/(\d+(?:[.,]\d+)?)\s*(GIB|GB|MIB|MB|TIB|TB)/iu);
  if (!match) return 0;
  const power = UNIT_POWER[match[2].toUpperCase()];
  const n = Number(match[1].replace(',', '.'));
  return power == null || !Number.isFinite(n) ? 0 : Math.round(n * 1024 ** power);
}

function isPack(stream: Stream | null | undefined, season: number): boolean {
  return Boolean(stream?.infoHash) && isSeasonPackRelease(stream as Parameters<typeof isSeasonPackRelease>[0], season);
}

// Título que nomeia VÁRIOS episódios ("S01.Dub E01-E08", "Capítulo 086 ao 123"
// de novela): não é pack de temporada para o `isSeasonPackRelease`, mas o
// torrent cobre vários episódios — nenhum tamanho do texto é o do episódio.
function namesMultipleEpisodes(title: string): boolean {
  return parseTitleSeasonEpisode(title).episodes.length > 1;
}

/**
 * Multi-episódio sem medida do episódio: o total do torrent sai do TEXTO, não
 * só do 💾. Roda ANTES do `fillMissingSizes`: quem perde o 💾 aqui e ganhar
 * lista de arquivos depois sai com o tamanho MEDIDO do episódio.
 */
function dropPackTextTotals<T extends Stream | null>(
  streams: T[],
  { season, episode, trace }: {
    season?: number | null;
    episode?: number | null;
    trace?: StreamTraceState | null;
  },
): T[] {
  if (season == null || episode == null) return streams;
  return streams.map((stream) => {
    if (!stream || typeof stream.title !== 'string' || stream.title.includes(PACK_MARK)) return stream;
    // O 💾 do Torrentio é o tamanho do ARQUIVO escolhido (ver annotatePackSizes):
    // não é total de torrent, não sai.
    if ((stream as { _indexer?: string })._indexer === 'torrentio') return stream;
    const parsedEpisodes = parseTitleSeasonEpisode(stream.title).episodes;
    const multi = isPack(stream, season)
      || (parsedEpisodes.length > 1 && parsedEpisodes.includes(episode));
    if (!multi) return stream;
    const total = Number((stream as { _bytes?: number })._bytes) || tokenBytes(stream.title);
    const title = stream.title.replace(TEXT_SIZE_TOKEN, '');
    const name = typeof stream.name === 'string' ? stream.name.replace(TEXT_SIZE_TOKEN, '') : stream.name;
    if (title === stream.title && name === stream.name) return stream;
    stageTrace(trace, 'episodeSize.packTextDropped', 1);
    return {
      ...stream,
      title,
      name,
      ...(total > 0 ? { _packBytes: total } : {}),
    } as T;
  }) as T[];
}

export { dropPackTextTotals, namesMultipleEpisodes };
