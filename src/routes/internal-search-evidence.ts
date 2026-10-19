// Evidência que o orquestrador Rust ainda não tem como calcular sozinho, anexada
// aos itens que as rotas internas devolvem (`collect`/`index`), na MESMA ordem
// do `stream-builder-pipeline`: prova de ARQUIVO do índice (`applyFileEvidence`)
// e DUAL global com título TMDB pt (`applyPtTitleDual`). O Rust decide o chip,
// o `_dubbed` e a origem BR (`toStremioStream`) por estes campos.
import type { RawItem } from '../../types/domain.js';
import { applyFileEvidence } from '../providers/stream-file-evidence.js';
import { applyPtTitleDual } from '../providers/pt-title-dual.js';
import { raceWithDeadline } from '../utils/deadline.js';

type Titles = { original?: string | null; pt?: string | null; en?: string | null } | null;

/**
 * `titles` é a promessa do `getTitles` (cache de 7 dias, já aquecido pela rota
 * `meta` da mesma busca): espera no máximo até o prazo da rota; sem títulos a
 * tempo, só a prova de arquivo vai — ptTitleDual nunca inventa origem.
 */
export async function enrichForRust(
  items: RawItem[],
  titles: Promise<Titles> | null,
  deadlineAt: number,
): Promise<RawItem[]> {
  const withEvidence = applyFileEvidence(items);
  if (!titles) return withEvidence;
  const resolved = await raceWithDeadline(
    titles.catch(() => null),
    Math.max(0, deadlineAt - Date.now()),
    () => null,
  );
  return resolved ? applyPtTitleDual(withEvidence, { titles: resolved }) : withEvidence;
}
