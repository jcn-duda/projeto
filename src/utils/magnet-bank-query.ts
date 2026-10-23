// Consultas em LOTE do banco de magnets por obra. Extraído de `magnet-bank.ts`
// pela catraca de 400 linhas: uma query de works por alvo + UMA query de
// magnets para todos os hashes, com corte cedo. Quem consome hoje é a sonda
// dirigida do autofetch (`bankHasBrRow`); o fallback 📦 da busca é do Rust.
import { readEngine, isOpen } from './magnet-bank.js';
import type { MagnetRow, WorkRow } from './magnet-bank.js';
import { workTuple } from './magnet-bank-merge.js';

/**
 * Obras a consultar para o pedido. Filme: só a raiz (season/episode nulos).
 * Série: episódio pedido, pack da temporada e série completa — o pack achado
 * numa busca de episódio fica recuperável para os demais (release-work.ts).
 */
export function obraTargets(type: string, season: number | null, episode: number | null) {
  if (type === 'movie' || season == null) return [{ season: null, episode: null }];
  const out: Array<{ season: number | null; episode: number | null }> = [];
  if (episode != null) out.push({ season, episode });
  out.push({ season, episode: null });
  out.push({ season: null, episode: null });
  return out;
}

const clampLimit = (limit: number): number => Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100));

/** Obras de VÁRIOS alvos (episódio/pack/série) com magnets numa leitura em lote. */
export function worksForObraMany(
  imdb: string,
  targets: ReadonlyArray<{ season: number | null; episode: number | null }>,
  limitPerTarget: number,
  maxTotal = Number.POSITIVE_INFINITY,
  indexers?: readonly string[],
): Array<{ work: WorkRow; magnet: MagnetRow | null }> {
  const e = readEngine();
  if (!e) return [];
  const works: WorkRow[] = [];
  for (const target of targets) {
    if (works.length >= maxTotal) break;
    const ep = workTuple({ season: target.season, episode: target.episode });
    works.push(...e.listWorksByObra(String(imdb || ''), ep.season, ep.episode, clampLimit(limitPerTarget), indexers));
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
