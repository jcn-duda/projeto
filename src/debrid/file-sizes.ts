import config from '../config.js';
import { VIDEO_EXT, SAMPLE, isSiteAd } from './file-selector.js';
import type { DebridFile } from './file-selector.js';

// Arquivos de vídeo (caminho + tamanho) por hash, para mostrar o tamanho do
// EPISÓDIO dentro de um pack de temporada — o release só publica o total.
//
// Todo debrid alimenta pelo mesmo ponto: o play (`recordFileEvidence`, que os
// cinco adapters chamam com a lista do torrent) e, na busca, as checagens que
// sabem ler arquivos (TorBox com `list_files`, AllDebrid pelo id do magnet
// pronto). O conteúdo de um hash não muda, então não há TTL, só teto (LRU).
//
// Fica em memória de propósito: um namespace persistente somaria cota acima do
// teto global do cache (ver `cache-quotas.ts`). Depois de um restart a lista
// volta no próximo play ou na próxima checagem que ler arquivos; até lá a
// listagem usa a estimativa pela contagem de episódios.

type SizedFile = { path: string; size: number };

const memo = new Map<string, SizedFile[]>();

function recordFileSizes(infoHash: string, files: DebridFile[] | null | undefined) {
  const hash = String(infoHash || '').toLowerCase();
  if (!hash || !Array.isArray(files)) return;
  const videos = files
    .map((file) => ({ path: String(file?.path || ''), size: Number(file?.size) || 0 }))
    .filter((file) => file.size > 0 && VIDEO_EXT.test(file.path) && !SAMPLE.test(file.path) && !isSiteAd(file.path));
  if (videos.length === 0) return;
  // Reinserir move para o fim: o Map preserva ordem de inserção, e a cabeça é
  // o menos usado recentemente.
  memo.delete(hash);
  memo.set(hash, videos);
  const max = Math.max(1, Math.trunc(config.debrid.fileSizesMax) || 1);
  while (memo.size > max) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

function peekFileSizes(infoHash: string): SizedFile[] | null {
  return memo.get(String(infoHash || '').toLowerCase()) || null;
}

function hasFileSizes(infoHash: string) {
  return memo.has(String(infoHash || '').toLowerCase());
}

function clearFileSizes() {
  memo.clear();
}

export { recordFileSizes, peekFileSizes, hasFileSizes, clearFileSizes };
export type { SizedFile };
