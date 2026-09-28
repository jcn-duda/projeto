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
import { titleTokens } from './matching-vocabulary.js';
import { nameCoverageTokens, isMultiWorkCollection } from './release-name-matching.js';

const YEAR_RE = /^(?:19|20)\d{2}$/;

export function franchiseBaseContradicts(
  title: string,
  own: string[] | null,
  name: string,
  year: number | string | null,
): boolean {
  const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!catalogYear) return false;
  const tokens = own || titleTokens(title);
  const years = tokens.filter((t) => YEAR_RE.test(t)).map(Number);
  if (years.length !== 1 || years[0] === catalogYear) return false;
  // Ano que é token do NOME ("Blade Runner 2049") não é ano de release.
  const wanted = nameCoverageTokens(name).filter((w) => !YEAR_RE.test(w));
  if (!wanted.some((w) => !tokens.includes(w))) return false;
  return !isMultiWorkCollection(title);
}
