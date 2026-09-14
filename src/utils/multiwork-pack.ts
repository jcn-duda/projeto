import type { MultiWorkCollection, RawItem } from '../../types/domain.js';
import { titleTokens, LEADING_ARTICLES } from './matching-vocabulary.js';
import { franchiseRoot, isMultiWorkCollection, containsTokenRun } from './release-name-matching.js';

// Admissão OPT-IN de packs multiobra BR (BR_MULTIWORK_PACKS). O pack de coleção
// ("Indiana Jones - A Coleção Completa 1981-2008") é o único lugar onde o
// dublado BR de um filme isolado às vezes existe — e ele NUNCA casa o filtro
// estrito de título do filme ("Indiana Jones e os Caçadores da Arca Perdida").
// Em vez de afrouxar o filtro de título (heurística solta que readmite
// homônimo), a admissão exige evidência FORTE:
//
// 1. a raiz da franquia vem do `belongs_to_collection` do TMDB (autoridade),
//    não de cortar o título do filme;
// 2. o título precisa ser coleção reconhecida (`isMultiWorkCollection`);
// 3. a raiz tem que aparecer no título como sequência CONTÍGUA de tokens;
// 4. o título ou o `dn=` do magnet precisa DECLARAR cobertura do ano do filme
//    (ano exato ou faixa que o inclui).
//
// Sem todas, o pack não é admitido. Tudo é puro; o contexto (`multiWork`) só
// existe quando o opt-in está ligado, há debrid ativo, é filme e o ano é
// conhecido — as demais condições de admissão vivem aqui.

// Palavras que descrevem o EMPACOTAMENTO no NOME da coleção do TMDB, não a
// franquia: "Indiana Jones (Coleção)" / "Trilogia Indiana Jones" precisam virar
// a raiz "indiana jones". Lista fechada e conservadora: artigos e preposições
// são PRESERVADOS (a raiz precisa ser contígua ao título, e o pack publica o
// nome inteiro — "o senhor dos aneis"). "saga" entra porque, sozinha, só
// aparece como wrapper de coleção; se a remoção esvaziar a raiz, a admissão
// falha fechada.
const COLLECTION_NOISE = new Set(
  (
    'colecao coletanea trilogia duologia quadrilogia pentalogia antologia ' +
    'filmografia filmography trilogy quadrilogy duology tetralogy anthology ' +
    'boxset box collection saga completo completa completos completas'
  ).split(' '),
);

/**
 * Tokens normalizados da RAÍZ da coleção. Corta subtítulo/marcador de sequência
 * com o mesmo `franchiseRoot` do resto do pipeline e remove só as palavras de
 * empacotamento. O(s) artigo(s) inicial(is) saem porque o pack publica o nome
 * com ou sem ele ("O Senhor dos Anéis" × "Senhor dos Anéis"). Menos de dois
 * tokens significativos = sem evidência de franquia ('' — admissão negada).
 */
function collectionRootTokens(name: string): string[] {
  const head = franchiseRoot(String(name || ''));
  const tokens = titleTokens(head).filter((token) => !COLLECTION_NOISE.has(token));
  while (tokens.length && LEADING_ARTICLES.has(tokens[0])) tokens.shift();
  return tokens.length >= 2 ? tokens : [];
}

/** Raiz da coleção como string normalizada (tokens contíguos), ou ''. */
function collectionRoot(name: string): string {
  return collectionRootTokens(name).join(' ');
}

/**
 * O texto DECLARA cobertura do ano? A FAIXA exige conter o ano de verdade
 * ("1981-2008" cobre 1981; "2000-2008" NÃO cobre) — sem folga nas bordas, é
 * evidência de cobertura e não de proximidade. O ANO AVULSO mantém a tolerância
 * de ±2 do `yearContradicts`: lançamento BR pode escorregar um ano, e o ano do
 * post costuma ser o da edição. Resolução (1920x1080) não é ano.
 */
function coversYear(text: string, catalogYear: number | string | null | undefined): boolean {
  const year = Number(String(catalogYear ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!year) return false;
  let rest = String(text || '').replace(/\d{3,4}x\d{3,4}/gi, ' ');
  const ranges: Array<[number, number]> = [];
  rest = rest.replace(
    /(?<!\d)((?:19|20)\d{2})\s*(?:[-–—~]|\b(?:de|a|até|ate|to)\b)\s*((?:19|20)\d{2})(?!\d)/gi,
    (_match, a, b) => {
      ranges.push([Number(a), Number(b)]);
      return ' ';
    },
  );
  for (const [a, b] of ranges) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (year >= lo && year <= hi) return true;
  }
  const singles = [...rest.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number(m[1]));
  return singles.some((single) => Math.abs(single - year) <= 2);
}

/**
 * Texto onde a cobertura de ano pode ser declarada: o título do post e, quando
 * há magnet real, o `dn=` decodificado (o nome verdadeiro da release). URL de
 * protetor de link não tem `dn=` e não carrega evidência de release.
 */
function packYearSource(item: RawItem | null | undefined): string {
  const title = String(item?.title || item?.Title || '');
  const raw = String(item?.magnet || item?.MagnetUri || '');
  if (!/^magnet:/i.test(raw.trim())) return title;
  const dn = raw.match(/[&?]dn=([^&]+)/i);
  if (!dn) return title;
  let decoded = dn[1].replace(/\+/g, ' ');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* sequência % malformada: segue com o texto já decodificado */
  }
  return `${title} ${decoded}`;
}

export interface MultiWorkAdmissionContext {
  multiWork?: MultiWorkCollection | null;
  year?: number | string | null;
  isSeries?: boolean;
  /** Nomes da obra: sem eles o play não monta a dica (`w`) e o `pickFile`
   * cairia no maior arquivo — admissão negada. */
  names?: string[];
}

/**
 * Admite o item como pack multiobra da franquia. Recebe o contexto já decidido
 * pelo chamador (opt-in ligado + debrid ativo + ano conhecido ⇒ `multiWork`
 * presente); aqui ficam as condições que não dependem de rede: filme, nomes
 * válidos, coleção reconhecida, raiz contígua (2+ tokens) e cobertura
 * explícita do ano.
 */
function admitsMultiWorkPack(
  item: RawItem | null | undefined,
  { multiWork, year, isSeries = false, names = [] }: MultiWorkAdmissionContext = {},
): boolean {
  if (!multiWork || !multiWork.root || isSeries) return false;
  // Sem nomes não há dica de obra: o /resolve não teria como escolher o filme
  // dentro da coleção e cairia no maior arquivo (o filme errado).
  if (!names.length) return false;
  const catalogYear = Number(String(year ?? '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!catalogYear) return false;
  const title = String(item?.title || item?.Title || '');
  if (!isMultiWorkCollection(title)) return false;
  if (!containsTokenRun(title, multiWork.root)) return false;
  return coversYear(packYearSource(item), catalogYear);
}

export {
  collectionRoot,
  collectionRootTokens,
  coversYear,
  packYearSource,
  admitsMultiWorkPack,
  COLLECTION_NOISE,
};
