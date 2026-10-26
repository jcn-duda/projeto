/**
 * Efeitos do play que o adaptador TypeScript grava no próprio processo e que o
 * Rust devolve no JSON do `POST /debrid/link` para o Node aplicar (o L1 —
 * `davail`, tamanhos e prova de áudio/resolução — mora aqui):
 *   - `unavailable: true` → `noteUnavailable` (davail=0 pela janela do
 *     availNegTtl): o histórico não pinta ⚡ no hash que o play acabou de
 *     provar frio. O Rust só manda quando o frio passou pela MESMA guarda do
 *     delete (magnet protegido segue baixando e não é negativo).
 *   - `files` → `recordFileEvidence`: tamanho do episódio, resolução e rótulo
 *     de áudio que a busca seguinte e o audit de dublagem leem.
 *
 * Import dinâmico DE PROPÓSITO (mesmo motivo do `alldebrid-play.ts`): o
 * estático fecharia o ciclo cache-check → registry → rust-remote. Best-effort:
 * falha de anotação nunca derruba o play.
 */
import * as log from '../utils/logger.js';
import type { DebridFile } from './common.js';

/** Só `{path, size}` válidos: o corpo vem de outro processo. */
function takePlayFiles(value: unknown): DebridFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: DebridFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const { path, size } = item as { path?: unknown; size?: unknown };
    if (typeof path !== 'string' || !path) continue;
    const bytes = Number(size);
    files.push({ path, size: Number.isFinite(bytes) ? bytes : 0, link: '' });
  }
  return files;
}

export async function applyPlayEffects(
  adapterId: string,
  apiKey: string,
  infoHash: string,
  body: unknown,
): Promise<void> {
  if (!body || typeof body !== 'object') return;
  const { unavailable, files } = body as { unavailable?: unknown; files?: unknown };
  const list = takePlayFiles(files);
  if (list) {
    try {
      const { recordFileEvidence } = await import('./audio-audit.js');
      recordFileEvidence(infoHash, list);
    } catch (err) {
      log.warn('[debrid] não consegui gravar a prova do play do Rust:', log.errorMessage(err));
    }
  }
  if (unavailable === true) {
    try {
      const { noteUnavailable } = await import('./cache-check.js');
      noteUnavailable(adapterId, apiKey, infoHash);
    } catch (err) {
      log.warn('[debrid] não consegui anotar davail=0 do play do Rust:', log.errorMessage(err));
    }
  }
}
