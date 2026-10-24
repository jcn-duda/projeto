// Banco de magnets vivo — LEITURA (extraída da fachada `magnet-bank.ts` pela
// catraca de 400 linhas). São os helpers SÍNCRONOS por hash/obra/fonte que
// alimentam o play, o fallback da Etapa 4 e o painel.
//
// `readEngine` respeita o kill-switch: com o banco DESLIGADO devolve null em
// vez de criar o SQLite à toa (status/consulta numa instância com a captura
// desligada não paga disco). A fachada reexporta tudo daqui, então o contrato
// público de `magnet-bank.js` não muda.
import config from '../config.js';
import { currentEngine, engine } from './magnet-bank-rows.js';
import type { Engine, MagnetRow, SourceRow, WorkRow } from './magnet-bank-rows.js';
import { workTuple } from './magnet-bank-merge.js';

const normHash = (hash: string): string => String(hash || '').toLowerCase();
const clampLimit = (limit: number): number => Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));

/** Engine para LEITURA: reusa o aberto; se ainda não há, abre — mas com o banco
 * desligado devolve null (ver cabeçalho). */
export function readEngine(): Engine | null {
  const open = currentEngine();
  if (open) return open;
  if (!config.magnetBank?.enabled) return null;
  return engine();
}

/** Armazenamento JÁ aberto, SEM abrir nada (a via instantânea não cria o arquivo). */
export function isOpen(): boolean { return currentEngine() !== null; }

/** Lookup síncrono por hash (PK). Alimenta o play na Etapa 3. */
export function lookup(hash: string): MagnetRow | null {
  return readEngine()?.getMagnet(normHash(hash)) ?? null;
}

export function sourcesFor(hash: string): SourceRow[] {
  return readEngine()?.listSources(normHash(hash)) ?? [];
}

export function worksFor(hash: string): WorkRow[] {
  return readEngine()?.listWorks(normHash(hash)) ?? [];
}

/** Obras indexadas para (imdb, season, episode) — prepara a consulta do fallback. */
export function findByWork(imdb: string, season: number | null, episode: number | null, limit = 100): Array<{ work: WorkRow; magnet: MagnetRow | null }> {
  const e = readEngine();
  if (!e) return [];
  const ep = workTuple({ season, episode });
  return e.listWorksByObra(String(imdb || ''), ep.season, ep.episode, clampLimit(limit))
    .map((work) => ({ work, magnet: e.getMagnet(work.hash) }));
}

/** Fontes de um indexer (mais recentes primeiro) — prepara a consulta do fallback. */
export function findByIndexer(indexer: string, limit = 100): Array<{ source: SourceRow; magnet: MagnetRow | null }> {
  const e = readEngine();
  if (!e) return [];
  return e.listSourcesByIndexer(String(indexer || '').toLowerCase(), clampLimit(limit))
    .map((source) => ({ source, magnet: e.getMagnet(source.hash) }));
}