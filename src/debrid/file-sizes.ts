import { prefix } from '../utils/cache-keys.js';
import { kvClearPrefix, kvPeek, kvSet } from '../utils/native-kv.js';
import { VIDEO_EXT, SAMPLE, isSiteAd } from './file-selector.js';
import type { DebridFile } from './file-selector.js';

// Arquivos de vídeo (caminho + tamanho) por hash, para mostrar o tamanho do
// EPISÓDIO dentro de um pack de temporada, ou do FILME dentro de uma coleção —
// o release só publica o total.
//
// Todo debrid alimenta pelo mesmo ponto: o play (`recordFileEvidence`, que os
// cinco adapters chamam com a lista do torrent) e, na busca, as checagens que
// sabem ler arquivos (TorBox com `list_files`, AllDebrid pelo id do magnet
// pronto).
//
// Persistido no KV nativo (`fsz`/`tsz` em `cache.db`), o MESMO que o gateway
// lê na montagem da lista do `/stream`: a checagem nativa grava pelo próprio
// Rust e o Node só lê e grava pela ponte `native-kv`, sem L1 — um L1 aqui
// deixaria a lista do gateway atrás da evidência nova. Antes ficava só em
// memória e cada restart zerava a lista: a primeira abertura de cada título
// depois do restart voltava a mostrar o total do pack. Medido em Star Trek
// (2009), 2026-09-14: três restarts do container no dia, e a FILMOGRAFIA saía
// com 22.45 GB até a checagem reler os arquivos. O conteúdo de um hash não
// muda; o TTL só impede que hash esquecido ocupe a cota para sempre. Ponte
// indisponível: a leitura vira vazio/0 e a gravação não acontece (o próximo
// pack relê o arquivo).
const FILE_SIZES_TTL_SECONDS = 30 * 86400;

// `link` só quando o serviço entrega o link do arquivo na lista (AllDebrid): é
// por ele que a medição do cabeçalho (`video-quality.ts`) desbloqueia o vídeo.
type SizedFile = { path: string; size: number; link?: string };

const keyOf = (infoHash: string) => `${prefix('fsz')}${String(infoHash || '').toLowerCase()}`;

function recordFileSizes(infoHash: string, files: DebridFile[] | null | undefined) {
  const hash = String(infoHash || '').toLowerCase();
  if (!hash || !Array.isArray(files)) return;
  const videos = files
    .map((file): SizedFile => ({
      path: String(file?.path || ''),
      size: Number(file?.size) || 0,
      ...(typeof file?.link === 'string' && file.link ? { link: file.link } : {}),
    }))
    .filter((file) => file.size > 0 && VIDEO_EXT.test(file.path) && !SAMPLE.test(file.path) && !isSiteAd(file.path));
  if (videos.length === 0) return;
  // Regravar renova o TTL (o `kvSet` substitui a linha inteira).
  kvSet(keyOf(hash), videos, FILE_SIZES_TTL_SECONDS);
}

// Leitura sem efeito colateral: a anotação consulta todo pack de toda busca, e
// a leitura pela ponte não conta como uso do cache.
function peekFileSizes(infoHash: string): SizedFile[] | null {
  if (!infoHash) return null;
  const value = kvPeek(keyOf(infoHash));
  const list = Array.isArray(value) && value.length > 0 ? (value as SizedFile[]) : null;
  return list;
}

function hasFileSizes(infoHash: string) {
  return peekFileSizes(infoHash) !== null;
}

function clearFileSizes() {
  kvClearPrefix(prefix('fsz'));
  kvClearPrefix(prefix('tsz'));
}

// Tamanho TOTAL do torrent (`tsz`), sem lista de arquivos. O Premiumize devolve
// no `/cache/check` um `filesize` por hash que é o torrent inteiro — medido em
// True Detective S01, 2026-09-20: o pack de 8 episódios veio 12.41 GB, igual ao
// total do tracker, e as releases de um episódio vieram com o tamanho do
// episódio (617.8 MB, 4.22 GB). Serve para dar 💾 a quem o tracker não deu
// tamanho (ou deu o do .torrent, em KB); a média por episódio do pack continua
// a cargo do `episode-size`. Namespace próprio: no `fsz` o `pickFile` leria o
// total como um arquivo só.
const totalKeyOf = (infoHash: string) => `${prefix('tsz')}${String(infoHash || '').toLowerCase()}`;

function recordTorrentTotal(infoHash: string, bytes: unknown) {
  const hash = String(infoHash || '').toLowerCase();
  const size = Number(bytes) || 0;
  if (!hash || size <= 0) return;
  kvSet(totalKeyOf(hash), size, FILE_SIZES_TTL_SECONDS);
}

function peekTorrentTotal(infoHash: string): number {
  if (!infoHash) return 0;
  return Number(kvPeek(totalKeyOf(infoHash))) || 0;
}

export {
  recordFileSizes, peekFileSizes, hasFileSizes, clearFileSizes, recordTorrentTotal, peekTorrentTotal,
};
export type { SizedFile };
