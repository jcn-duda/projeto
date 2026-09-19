// Consultas em LOTE do banco de magnets para o fallback (Etapa 4). Extraído de
// `magnet-bank.ts` pela catraca de 400 linhas: `findByWork` fazia getMagnet por
// linha (N+1) no caminho da resposta; aqui uma query de works por alvo + UMA
// query de magnets/fontes para todos os hashes, com corte cedo.
import { readEngine, isOpen } from './magnet-bank.js';
import type { MagnetRow, SourceRow, WorkRow } from './magnet-bank.js';
import { workTuple } from './magnet-bank-merge.js';

const clampLimit = (limit: number): number => Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));

/** Obras de VÁRIOS alvos (episódio/pack/série) com magnets numa leitura em lote. */
export function worksForObraMany(
  imdb: string,
  targets: ReadonlyArray<{ season: number | null; episode: number | null }>,
  limitPerTarget: number,
  maxTotal = Number.POSITIVE_INFINITY,
): Array<{ work: WorkRow; magnet: MagnetRow | null }> {
  const e = readEngine();
  if (!e) return [];
  const works: WorkRow[] = [];
  for (const target of targets) {
    if (works.length >= maxTotal) break;
    const ep = workTuple({ season: target.season, episode: target.episode });
    works.push(...e.listWorksByObra(String(imdb || ''), ep.season, ep.episode, clampLimit(limitPerTarget)));
  }
  const magnets = new Map(e.listMagnetsMany(works.map((w) => w.hash)).map((m) => [m.hash, m]));
  return works.map((work) => ({ work, magnet: magnets.get(work.hash) ?? null }));
}

/**
 * O acervo tem linha `is_br=1` de QUALQUER alvo da obra? É a evidência de
 * plausibilidade da sonda dirigida: o BR que o corte do índice expulsou ainda
 * vive no `magnets.db` e a colheita é o único caminho de volta. Leitura pura —
 * engine fechado devolve `false` sem abrir arquivo (fail-open); `lied` NÃO é
 * excluído (paridade com `hasBrEvidence`, que também não julga a marca).
 */
export function bankHasBrRow(
  imdb: string,
  targets: ReadonlyArray<{ season: number | null; episode: number | null }>,
): boolean {
  if (!isOpen()) return false;
  try {
    return worksForObraMany(imdb, targets, 200, 300).some(({ magnet }) => Number(magnet?.isBr) === 1);
  } catch {
    return false;
  }
}

/** Fontes de VÁRIOS hashes em UMA consulta, agrupadas por hash. */
export function sourcesForMany(hashes: readonly string[]): Map<string, SourceRow[]> {
  const out = new Map<string, SourceRow[]>();
  const e = readEngine();
  if (!e) return out;
  for (const row of e.listSourcesMany(hashes)) {
    const list = out.get(row.hash);
    if (list) list.push(row);
    else out.set(row.hash, [row]);
  }
  return out;
}
