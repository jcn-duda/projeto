// Pack que repete, byte a byte, o arquivo de uma release avulsa da MESMA lista.
// Star Trek Beyond (2026-09-24): "FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS"
// (24 GB) tocaria `13 - … Sem Fronteiras - 2016.mp4` com 2.389.448.021 bytes, o
// mesmo tamanho exato do torrent avulso "Star Trek Sem Fronteiras 2016 Bluray
// 1080p Dublado - TPF" — duas linhas para o mesmo arquivo. Medido nos 178 packs
// com lista de arquivos: 22 vídeos com avulso de tamanho idêntico, todos o
// mesmo arquivo (mesmo episódio e grupo).
//
// As travas (nenhuma afrouxa sem medir de novo):
// - byte EXATO, nunca o rótulo arredondado — dois encodes não empatam em bytes;
// - o pack só sai com o arquivo escolhido medido (`fsz` + o mesmo `pickFile`
//   do play); sem medida dos dois lados, nada muda;
// - some o PACK, nunca o avulso, e só quando o avulso está tão pronto quanto
//   ele (⚡ no avulso, ou nenhum dos dois ⚡): não se troca play instantâneo
//   por download;
// - só roda com a checagem de cache conhecida (`cached` não nulo).
import type { Stream } from '../../types/domain.js';
import { pickFile } from '../debrid/file-selector.js';
import { peekFileSizes } from '../debrid/file-sizes.js';
import { dropTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import * as metrics from '../utils/metrics.js';

const VIDEO_RE = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg)$/i;

type WorkHint = { n: string[]; y: number | null } | null | undefined;
type Options = {
  season?: number | null;
  episode?: number | null;
  work?: WorkHint;
  trace?: StreamTraceState | null;
  cached: ReadonlySet<string>;
};

type Measured = { stream: Stream; hash: string; bytes: number; pack: boolean };

/** Bytes do arquivo que o play tocaria, e se o torrent é um pack (2+ vídeos). */
function measure(stream: Stream, { season, episode, work }: Omit<Options, 'trace' | 'cached'>): Measured | null {
  if (!stream?.infoHash) return null;
  const hash = String(stream.infoHash).toLowerCase();
  const files = peekFileSizes(hash);
  const videos = files ? files.filter((f: { path?: string }) => VIDEO_RE.test(String(f.path || ''))) : [];
  if (files && videos.length >= 2) {
    try {
      const hint = season != null
        ? { season, episode }
        : work?.n?.length ? { work: { names: work.n, year: work.y, pack: true } } : {};
      const bytes = Number(pickFile(files, hint)?.size) || 0;
      return bytes > 0 ? { stream, hash, bytes, pack: true } : null;
    } catch {
      return null;
    }
  }
  if (videos.length === 1) return { stream, hash, bytes: Number(videos[0].size) || 0, pack: false };
  // Sem lista de arquivos: o total do torrent só vale como tamanho do vídeo
  // para release avulsa — um pack sem lista nunca é medido.
  const bytes = Number((stream as { _bytes?: number })._bytes) || 0;
  return bytes > 0 ? { stream, hash, bytes, pack: false } : null;
}

export function dropDuplicatePackFiles<T extends Stream | null>(streams: T[], options: Options): T[] {
  const { cached, trace, ...hint } = options;
  const measured = streams.map((s) => (s ? measure(s, hint) : null));
  const singles = new Map<number, Measured[]>();
  for (const m of measured) {
    if (m && !m.pack) singles.set(m.bytes, [...(singles.get(m.bytes) || []), m]);
  }
  const drop = new Set<Stream>();
  for (const m of measured) {
    if (!m?.pack) continue;
    const twin = (singles.get(m.bytes) || []).find((s) => s.hash !== m.hash
      && (cached.has(s.hash) || !cached.has(m.hash)));
    if (twin) drop.add(m.stream);
  }
  if (drop.size === 0) return streams;
  for (const stream of drop) dropTrace(trace, stream, 'duplicate-file');
  metrics.count('search.duplicatePack.dropped', drop.size);
  return streams.filter((s) => !s || !drop.has(s));
}
