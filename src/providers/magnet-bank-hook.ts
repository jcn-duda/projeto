// Ponte pipeline → banco de magnets vivo.
//
// O `prepareCandidateStreams` tem `antesTitulo` (o que ENTROU no filtro) e
// `raw` (o que SOBREVIVEU), mas o banco só precisa dos hashes — item de CONTA
// (`fromAccount`) e item de FALLBACK (`fromFallback`) ficam de fora: o
// inventário não é acervo do site e a reserva derivada do banco não pode
// realimentá-lo (Etapa 4). A extração de hash vive aqui para o pipeline não
// ganhar linhas (ele opera no teto de 400).
import type { RawItem } from '../../types/domain.js';
import { hashOf, markFilterResult } from '../utils/magnet-bank.js';
import type { WorkCtx } from '../utils/magnet-bank.js';
import { releaseWorkTargets } from '../utils/release-work.js';
import { magnetDisplayName } from '../utils/title-normalization.js';

/** Hashes únicos (não-conta, não-fallback) de uma lista de itens, na ordem. */
function hashesOf(items: readonly RawItem[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || item.fromAccount || item.fromFallback) continue;
    const hash = hashOf(item);
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      out.push(hash);
    }
  }
  return out;
}

/**
 * Obras por hash para o resultado do filtro. Só itens que declaram pack de
 * temporada/série completa geram obra EXTRA (a do pedido é o default do banco).
 * `null` de temporada/episódio vira -1 (PK de `magnet_work`).
 */
function targetsFor(items: readonly RawItem[], ctx: WorkCtx): Map<string, Array<{ season: number; episode: number }>> {
  const out = new Map<string, Array<{ season: number; episode: number }>>();
  const request = { season: ctx.season ?? null, episode: ctx.episode ?? null };
  const toTuple = (t: { season: number | null; episode: number | null }) => ({
    season: t.season == null ? -1 : Math.trunc(t.season),
    episode: t.episode == null ? -1 : Math.trunc(t.episode),
  });
  for (const item of items) {
    if (!item || item.fromAccount || item.fromFallback) continue;
    const hash = hashOf(item);
    if (!hash) continue;
    // MESMO hash pode aparecer com títulos distintos na mesma leva (duplicata
    // entre indexers); a união das obras preserva as duas rotas em vez de a
    // última sobrescrever a primeira.
    const merged = out.get(hash) || [];
    for (const tuple of releaseWorkTargets(String(item.title || item.Title || ''), request, magnetDisplayName(item) || undefined).map(toTuple)) {
      if (!merged.some((t) => t.season === tuple.season && t.episode === tuple.episode)) merged.push(tuple);
    }
    if (merged.length > 1) out.set(hash, merged);
  }
  return out;
}

/**
 * Escreve o resultado do filtro de título na obra: 1 para os sobreviventes, 0
 * para os demais que a captura registrou. Fonte que o Jackett não capturou não
 * tem work e é ignorada pelo banco (sem órfão).
 */
export function markBankFilterOutcome(entered: readonly RawItem[], survivors: readonly RawItem[], ctx: WorkCtx): void {
  const all = hashesOf(entered);
  if (all.length === 0) return;
  markFilterResult(all, hashesOf(survivors), ctx, targetsFor(entered, ctx));
}
