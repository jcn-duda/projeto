// BR-gap: cobertura por pool do índice contra o requisito de dublado BR.
//
// O problema que resolve: o índice guarda releases globais (inglês) que fazem
// `idxPoolCovered` devolver true — a busca se serve do índice e o Jackett vivo
// fica como enriquecimento no tail. Os index-only (ApacheTorrent Cardigann,
// Rede Torrent e 1337x), que são justo onde pode morar o dublado titulado em PT, NUNCA
// entram pela busca viva (os filtra `liveIndexers`) nem pelo enriquecimento do
// tail (já está coberto), então o dublado BR dessa obra fica inalcançável para
// sempre. A solução: detectar essa lacuna (`br-gap`) e enfileirar no colhedor —
// que consulta os index-only com orçamento largo — usando o dedupe que já
// existe.
//
// As métricas do ciclo vivem nos pontos que as disparam (busca e colheita);
// aqui só vivem os predicados de evidência e o pedido de invalidação. A decisão
// do gap e a transição de faixa são do colhedor nativo.
import { invalidateNativeStreamsForObra } from './streams-store-native.js';
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
 * Invalida a lista pronta de UMA obra no store NATIVO (`data/streams.db`).
 *
 * Até o F4.4a isto varria o L1 do Node atrás de `streams:vN:<tipo>:<id>:…`.
 * Desde o corte ninguém escreve esse namespace no L1 (`RUST_OWNED` em
 * `cache-keys.ts`) e a varredura virou morta — percorria um Map que nunca
 * recebia a chave. O dono de execução do SWR é o gateway, então o pedido vai
 * pela ponte administrativa (a mesma do `/clear-cache`); a segmentação do id
 * (`tt123` ≠ `tt1230`) mora no `adom-store::streams`, do lado que apaga.
 *
 * Devolve `true` quando o pedido foi enfileirado, `false` quando nem havia o
 * que pedir (imdbId fora do contrato, ponte em backoff). Não é contagem de
 * entradas invalidadas: este processo não tem mais esse número.
 */
export function invalidateStreamsForObra(imdbId: string): boolean {
  const target = String(imdbId || '').toLowerCase();
  if (!/^tt\d+$/.test(target)) return false;
  // Fire-and-forget por contrato: o `/resolve` é síncrono e não pode esperar
  // o DELETE do gateway; a próxima abertura que chegar depois já reconstrói.
  return invalidateNativeStreamsForObra(target);
}
