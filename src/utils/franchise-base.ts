// Guarda da OBRA-BASE de franquia pedida por SUBTÍTULO (filme, caminho global).
//
// A guarda reversa de sequência (`matchesTitleStructure`) só enxerga NÚMERO:
// a busca "A Morte Te Dá Parabéns 2" rejeita o filme 1 sem marcador. Quando a
// continuação é nomeada por subtítulo — "Resident Evil: Apocalypse" (2004) —
// o filme 1 ("Resident Evil (2002) 1080p BrRip x264 -YIFY") cobre 2 de 3
// tokens (≥ 0,6), não tem marcador que o denuncie e o ano 2002 cabe no ±2 do
// catálogo. Medido em 2026-09-28: 6 das 7 releases da lista do Apocalypse eram
// do filme de 2002 (YTS 4K, TPB, Tigole…), todas com ⚡.
//
// A regra exige as DUAS evidências juntas, e só elas: falta token
// significativo do nome (o subtítulo) E o título declara UM ano, diferente do
// catálogo. Cada uma sozinha é normal — release que abrevia o subtítulo com o
// ano certo ("Mission Impossible Dead Reckoning 2023") e release do lançamento
// nacional um ano depois com o nome completo ficam. Pack de coleção fica fora
// (a faixa de anos é da coleção; quem decide é a admissão multiobra).
//
// Decisão INTEIRA no núcleo (`adom-core::franchise`, golden contra o TS do
// `esm`): aqui só se monta a entrada. Módulo-folha via `nativeCore`.
import { nativeCore } from './native-core.js';

/** Funções de franquia no `.node` (camelCase do napi-rs). */
type FranchiseCore = {
  franchiseBaseContradictsNapi(
    title: string,
    own: string[] | null,
    name: string,
    catalogYear: string,
  ): boolean;
  franchiseExtensionContradictsNapi(
    title: string,
    own: string[] | null,
    name: string,
    allNames: string[],
    catalogYear: string,
  ): boolean;
};

const core = () => nativeCore<FranchiseCore>();

/** Ano como texto, que é o que o núcleo lê (`String(x ?? '')`, como o TS). */
function yearText(year: number | string | null): string {
  return String(year ?? '');
}

export function franchiseBaseContradicts(
  title: string,
  own: string[] | null,
  name: string,
  year: number | string | null,
): boolean {
  return core().franchiseBaseContradictsNapi(String(title), own, String(name), yearText(year));
}

// Espelho da guarda acima: a busca é pelo nome NU ("Resident Evil", 2026) e a
// release traz um SUBTÍTULO a mais logo depois do nome, sem ano ("Resident
// Evil Vendetta (Full Japanese Audio+EN)(BD 1080p x264 AAC)" — o anime de
// 2017, listado com ⚡ no filme de 2026 em 2026-10-02). Nem o ano nem a
// sequência numérica o denunciam. Travas: só filme com ano de catálogo; título
// com qualquer ano → abstém-se; a palavra seguinte ao nome é ruído de release,
// edição do MESMO filme, pack, número ou palavra de outro nome da obra
// (alias pt/original) → abstém-se.
export function franchiseExtensionContradicts(
  title: string,
  own: string[] | null,
  name: string,
  allNames: readonly string[],
  year: number | string | null,
): boolean {
  return core().franchiseExtensionContradictsNapi(
    String(title),
    own,
    String(name),
    [...allNames],
    yearText(year),
  );
}
