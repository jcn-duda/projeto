// BR-gap: cobertura por pool do índice contra o requisito de dublado BR.
//
// O problema que resolve: o índice guarda releases globais (inglês) que fazem
// `idxPoolCovered` devolver true — a busca se serve do índice e o Jackett vivo
// fica como enriquecimento no tail. Os index-only (ApacheTorrent, redetorrent,
// hdrtorrent), que são justo onde pode morar o dublado titulado em PT, NUNCA
// entram pela busca viva (os filtra `liveIndexers`) nem pelo enriquecimento do
// tail (já está coberto), então o dublado BR dessa obra fica inalcançável para
// sempre. A solução: detectar essa lacuna (`br-gap`) e enfileirar no colhedor —
// que consulta os index-only com orçamento largo — usando o dedupe que já
// existe.
//
// As métricas do ciclo vivem nos pontos que as disparam (busca e colheita);
// aqui só vivem o predicado e a decisão, puros e testáveis.
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';
import type { IndexedRelease } from './release-index.js';

/**
 * "BR dublado comprovado": a release é BR, declara dublado e NÃO foi condenada
 * pela auditoria de áudio (`lied` — o post que prometia PT mas era EN). É a
 * MESMA evidencia que prioriza a fila do colhedor (`brEvidenceRank`) e que mede
 * o sampler F3: tê-la num só lugar evita que os três divergem.
 */
export function hasBrDubbed(releases: readonly IndexedRelease[] | undefined | null): boolean {
  return (releases || []).some((r) => Boolean(r?.isBr) && Boolean(r?.dubbed) && !Boolean(r?.lied));
}

/**
 * Decisão BR-gap: o índice cobre o pool mas NÃO traz BR dublado comprovado, e
 * há index-only configurados (sem eles o colhedor não teria onde buscar a
 * variante BR). Pura — o enqueue é fogo-e-esquece e deduplica por TTL.
 */
export function shouldBrGap(indexed: readonly IndexedRelease[] | undefined | null, indexOnlyConfigured: boolean): boolean {
  return indexOnlyConfigured && !hasBrDubbed(indexed);
}

/**
 * Invalida TODAS as claves `streams:vN` de UMA obra. Quando o índice passa a
 * cobrir BR dublado comprovado, a lista pronta que a busca guardou
 * enquanto não o tinha não pode seguir sendo servida: a próxima abertura deve
 * reconstruir a partir do índice agora completo. Aqui não há índice imdbId→clave,
 * então se varre o L1 (igual que rd-probe/dub-audit) reconhecendo o `id` em
 * `streams:vN:<tipo>:<id>:…` — pode ser `tt123` (filme) ou `tt123:S2:E5`
 * (série); o token `tt\d+` depois do tipo identifica a obra e `:tt1230` não
 * colide com `:tt123` porque se exige limite de seção (`:` ou fim).
 */
export function invalidateStreamsForObra(imdbId: string): number {
  const target = String(imdbId || '').toLowerCase();
  if (!/^tt\d+$/.test(target)) return 0;
  const streamPrefix = prefix('streams');
  let cleared = 0;
  for (const key of cache.keysMatching(streamPrefix)) {
    const rest = key.slice(streamPrefix.length);
    const idToken = rest.match(/^(?:movie|series):(tt\d+)(?::|$)/i)?.[1]?.toLowerCase();
    if (idToken !== target) continue;
    cache.forget(key);
    cleared += 1;
  }
  return cleared;
}
