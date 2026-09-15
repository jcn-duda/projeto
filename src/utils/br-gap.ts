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

function isBrDubbed(release: IndexedRelease | undefined | null): boolean {
  return release?.source !== 'autofetch'
    && Boolean(release?.isBr)
    && Boolean(release?.dubbed)
    && !Boolean(release?.lied);
}

/**
 * "BR dublado comprovado": a release é BR, declara dublado e NÃO foi condenada
 * pela auditoria de áudio (`lied` — o post que prometia PT mas era EN). É a
 * MESMA evidencia que prioriza a fila do colhedor (`brEvidenceRank`) e que mede
 * o sampler F3: tê-la num só lugar evita que os três divergem.
 */
export function hasBrDubbed(releases: readonly IndexedRelease[] | undefined | null): boolean {
  return (releases || []).some(isBrDubbed);
}

/**
 * Evidência PÚBLICA de origem BR na obra, mesmo que legendada ou sem a faixa
 * alvo. É o gate de plausibilidade da sonda dirigida (Fase 4): só faz sentido
 * varrer os index-only BR quando o índice já provou que essa obra TEM release
 * BR — numa obra sem vestígio nenhum, a ausência de dublado é o esperado e a
 * sonda viraria crawl eterno sem poder provar nada. Entrada `source:'autofetch'`
 * não conta: submissão do Chupim é visibilidade, não cobertura.
 */
export function hasBrEvidence(releases: readonly IndexedRelease[] | undefined | null): boolean {
  return (releases || []).some((r) => r?.source !== 'autofetch' && Boolean(r?.isBr));
}

/**
 * Releases BR dubladas que a execução da sonda ACRESCENTOU ao índice — a prova
 * que `found` exige. `hasBrDubbed(after)` sozinho condena a sonda por BR ANTIGO
 * que já estava lá antes dela rodar: uma release BR de 0 seeders no índice
 * antigo fazia uma resposta vazia finalizar `found` e barrava seeds para
 * sempre. Aqui só o delta por hash conta.
 */
export function newBrDubbedReleases(
  before: readonly IndexedRelease[] | undefined | null,
  after: readonly IndexedRelease[] | undefined | null,
): IndexedRelease[] {
  const prior = new Set((before || []).map((r) => String(r?.hash || '').toLowerCase()).filter(Boolean));
  return (after || []).filter((r) => {
    const hash = String(r?.hash || '').toLowerCase();
    return hash.length > 0 && !prior.has(hash) && isBrDubbed(r);
  });
}

/**
 * `found` VIÁVEL da sonda: a evidência nova precisa estar tocável. Fontes BR
 * usam `seeders: 1` como placeholder (nunca 0 — 0 já seria descartado por
 * MIN_SEEDERS), então `seeders > 0` é o piso mínimo de viabilidade. No probe de
 * UPGRADE exige-se ainda a faixa alvo (1080p): uma BR nova em 720p não fecha o
 * upgrade que a sonda foi pedir.
 */
export function probeFoundViable(
  before: readonly IndexedRelease[] | undefined | null,
  after: readonly IndexedRelease[] | undefined | null,
  { requireQuality }: { requireQuality?: string } = {},
): boolean {
  return newBrDubbedReleases(before, after).some((r) => {
    if (!(Number(r?.seeders) > 0)) return false;
    if (requireQuality && String(r?.quality || '').toLowerCase() !== requireQuality.toLowerCase()) return false;
    return true;
  });
}

// Alvo de upgrade do BR-gap: 1080p, a faixa dominante do catálogo e membro do
// mesmo conjunto de faixas-alvo do Chupim (`AUTOFETCH_TARGET_QUALITIES`). Faixas
// inferiores CONHECIDAS que justificam o upgrade; "sem resolução" (o "não sei"
// dos sites BR) NÃO está na lista — sem faixa conhecida não há lacuna provada,
// e abrir gap nela seria crawl eterno do colhedor sem evidência.
export const BR_GAP_TARGET_QUALITY = '1080p';
const BR_GAP_LOWER_QUALITIES = ['720p', '480p', 'sd'];

/** BR dublado comprovado na faixa de qualidade pedida (exata). */
export function hasBrDubbedAtQuality(
  releases: readonly IndexedRelease[] | undefined | null,
  quality: string,
): boolean {
  return (releases || []).some((r) =>
    isBrDubbed(r) && String(r?.quality || '').toLowerCase() === quality.toLowerCase());
}

/**
 * Upgrade: já há BR dublado comprovado, mas só em faixa CONHECIDA inferior à
 * alvo — o colhedor pode buscar a 1080p nos index-only. Exige prova positiva de
 * faixa inferior: release BR sem resolução declarada não abre (evita re-colher
 * a obra para sempre sem nunca poder provar o upgrade); 2160p presente também
 * não abre (faixa superior já cobre o alvo).
 */
export function hasBrDubbedBelowTarget(releases: readonly IndexedRelease[] | undefined | null): boolean {
  const list = releases || [];
  if (hasBrDubbedAtQuality(list, BR_GAP_TARGET_QUALITY)) return false;
  // Uma fonte BR 4K já cobre o objetivo de upgrade. Sem esta guarda, somar uma
  // 720p à mesma obra reabriria a lacuna que a 2160p havia fechado.
  if (hasBrDubbedAtQuality(list, '2160p')) return false;
  return list.some((r) => isBrDubbed(r)
    && BR_GAP_LOWER_QUALITIES.includes(String(r?.quality || '').toLowerCase()));
}

/**
 * Decisão BR-gap: o índice cobre o pool e, ou NÃO traz BR dublado comprovado
 * (lacuna total — comportamento original), ou só traz BR dublado em faixa
 * conhecida inferior à 1080p (upgrade — tt0107953: 720p Dual no índice, Dual
 * 1080p no RedeTorrent index-only). Em ambos os casos exige index-only
 * configurados (sem eles o colhedor não teria onde buscar). Pura — o enqueue é
 * fogo-e-esquece e deduplica por TTL.
 */
export function shouldBrGap(indexed: readonly IndexedRelease[] | undefined | null, indexOnlyConfigured: boolean): boolean {
  if (!indexOnlyConfigured) return false;
  return !hasBrDubbed(indexed) || hasBrDubbedBelowTarget(indexed);
}

/**
 * Transição do índice entre duas leituras, para o colhedor invalidar streams
 * prontos: `br` = ganhou BR dublado comprovado que não tinha; `upgrade` = já
 * tinha BR dublado, mas só abaixo da faixa alvo, e agora tem a alvo (1080p).
 * Em ambos a lista `streams:vN` construída antes não pode ser servida até o TTL.
 */
export function brTransition(
  before: readonly IndexedRelease[] | undefined | null,
  after: readonly IndexedRelease[] | undefined | null,
): 'none' | 'br' | 'upgrade' {
  const beforeHasBr = hasBrDubbed(before);
  if (!beforeHasBr && hasBrDubbed(after)) return 'br';
  if (beforeHasBr && !hasBrDubbedAtQuality(before, BR_GAP_TARGET_QUALITY)
    && hasBrDubbedAtQuality(after, BR_GAP_TARGET_QUALITY)) return 'upgrade';
  return 'none';
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
