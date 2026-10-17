import type { MultiWorkCollection, RawItem } from '../../types/domain.js';
import { nativeCore } from './native-core.js';

// Admissão de packs multiobra BR (BR_MULTIWORK_PACKS, nativo por padrão; `false`
// é o kill-switch). O pack de coleção
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
// existe quando a feature está ativa (default true; `false` é o kill-switch),
// há debrid ativo, é filme e o ano é conhecido — as demais condições de
// admissão vivem aqui.
//
// Decisão INTEIRA no núcleo (`adom-core::multiwork_pack`, golden contra o TS
// do `esm`): aqui se resolvem os campos `RawItem` (`title || Title`,
// `magnet || MagnetUri`) e a raiz da coleção. Módulo-folha via `nativeCore`.

// Palavras que descrevem o EMPACOTAMENTO no NOME da coleção do TMDB, não a
// franquia: "Indiana Jones (Coleção)" / "Trilogia Indiana Jones" precisam virar
// a raiz "indiana jones". Lista fechada e conservadora: artigos e preposições
// são PRESERVADOS (a raiz precisa ser contígua ao título, e o pack publica o
// nome inteiro — "o senhor dos aneis"). "saga" entra porque, sozinha, só
// aparece como wrapper de coleção; se a remoção esvaziar a raiz, a admissão
// falha fechada. Espelhada em `adom_core::multiwork_pack::COLLECTION_NOISE`
// (golden); exportada aqui porque é o contrato antigo do módulo.
const COLLECTION_NOISE = new Set(
  (
    'colecao coletanea trilogia duologia quadrilogia pentalogia antologia ' +
    'filmografia filmography trilogy quadrilogy duology tetralogy anthology ' +
    'boxset box collection saga completo completa completos completas'
  ).split(' '),
);

/** Funções de pack multiobra no `.node` (camelCase do napi-rs). */
type MultiWorkCore = {
  collectionRootTokensNapi(name: string): string[];
  collectionRootNapi(name: string): string;
  coversYearNapi(text: string, catalogYear: string): boolean;
  packYearSourceNapi(title: string, magnet: string): string;
  admitsMultiWorkPackNapi(
    title: string,
    magnet: string,
    multiWorkRoot: string | null,
    year: string,
    isSeries: boolean,
    names: string[],
  ): boolean;
};

const core = () => nativeCore<MultiWorkCore>();

/**
 * Tokens normalizados da RAÍZ da coleção. Corta subtítulo/marcador de sequência
 * com o mesmo `franchiseRoot` do resto do pipeline e remove só as palavras de
 * empacotamento. Menos de dois tokens significativos = sem evidência de
 * franquia (`[]` — admissão negada).
 */
function collectionRootTokens(name: string): string[] {
  return core().collectionRootTokensNapi(String(name ?? ''));
}

/** Raiz da coleção como string normalizada (tokens contíguos), ou ''. */
function collectionRoot(name: string): string {
  return core().collectionRootNapi(String(name ?? ''));
}

/**
 * O texto DECLARA cobertura do ano? A FAIXA exige conter o ano de verdade
 * ("1981-2008" cobre 1981; "2000-2008" NÃO cobre); o ANO AVULSO mantém a
 * tolerância de ±2. Resolução (1920x1080) não é ano.
 */
function coversYear(text: string, catalogYear: number | string | null | undefined): boolean {
  return core().coversYearNapi(String(text ?? ''), String(catalogYear ?? ''));
}

/**
 * Texto onde a cobertura de ano pode ser declarada: o título do post e, quando
 * há magnet real, o `dn=` decodificado. URL de protetor de link não tem `dn=`
 * e não carrega evidência de release.
 */
function packYearSource(item: RawItem | null | undefined): string {
  const title = String(item?.title || item?.Title || '');
  const magnet = String(item?.magnet || item?.MagnetUri || '');
  return core().packYearSourceNapi(title, magnet);
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
 * pelo chamador (feature ativa + debrid ativo + ano conhecido ⇒ `multiWork`
 * presente); aqui ficam as condições que não dependem de rede: filme, nomes
 * válidos, coleção reconhecida, raiz contígua (2+ tokens) e cobertura
 * explícita do ano.
 */
function admitsMultiWorkPack(
  item: RawItem | null | undefined,
  { multiWork, year, isSeries = false, names = [] }: MultiWorkAdmissionContext = {},
): boolean {
  const title = String(item?.title || item?.Title || '');
  const magnet = String(item?.magnet || item?.MagnetUri || '');
  return core().admitsMultiWorkPackNapi(
    title,
    magnet,
    multiWork?.root || null,
    String(year ?? ''),
    isSeries,
    names,
  );
}

export {
  collectionRoot,
  collectionRootTokens,
  coversYear,
  packYearSource,
  admitsMultiWorkPack,
  COLLECTION_NOISE,
};
