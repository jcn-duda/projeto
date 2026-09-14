import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
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
// Persistido no namespace `fsz` do cache (L1 + cache.db), com cota própria em
// `cache-quotas.ts`. Antes ficava só em memória e cada restart zerava a lista:
// a primeira abertura de cada título depois do restart voltava a mostrar o
// total do pack. Medido em Star Trek (2009), 2026-09-14: três restarts do
// container no dia, e a FILMOGRAFIA saía com 22.45 GB até a checagem reler os
// arquivos. O conteúdo de um hash não muda; o TTL só impede que hash esquecido
// ocupe a cota para sempre.
const FILE_SIZES_TTL_SECONDS = 30 * 86400;

type SizedFile = { path: string; size: number };

const keyOf = (infoHash: string) => `${prefix('fsz')}${String(infoHash || '').toLowerCase()}`;

function recordFileSizes(infoHash: string, files: DebridFile[] | null | undefined) {
  const hash = String(infoHash || '').toLowerCase();
  if (!hash || !Array.isArray(files)) return;
  const videos = files
    .map((file) => ({ path: String(file?.path || ''), size: Number(file?.size) || 0 }))
    .filter((file) => file.size > 0 && VIDEO_EXT.test(file.path) && !SAMPLE.test(file.path) && !isSiteAd(file.path));
  if (videos.length === 0) return;
  // Regravar renova o TTL e move a entrada para o fim do LRU do namespace.
  cache.set(keyOf(hash), videos, FILE_SIZES_TTL_SECONDS);
}

// Leitura sem efeito colateral: sem promover o LRU nem contar hit/miss — a
// anotação consulta todo pack de toda busca, e isso não é uso do cache.
function peekFileSizes(infoHash: string): SizedFile[] | null {
  if (!infoHash) return null;
  const value = cache.peek(keyOf(infoHash));
  return Array.isArray(value) && value.length > 0 ? (value as SizedFile[]) : null;
}

function hasFileSizes(infoHash: string) {
  return peekFileSizes(infoHash) !== null;
}

function clearFileSizes() {
  cache.clearNamespace('fsz');
}

export { recordFileSizes, peekFileSizes, hasFileSizes, clearFileSizes, FILE_SIZES_TTL_SECONDS };
export type { SizedFile };
