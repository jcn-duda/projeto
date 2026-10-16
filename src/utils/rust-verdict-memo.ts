/**
 * Memória dos vereditos do lote Rust (`evaluateReleases`) para `RUST_CORE=on`.
 *
 * O napi por chamada é ~2× mais lento que o TS (travessia de string), então o
 * Rust decide em LOTE: `rust-shadow.ts` manda as releases da coleta numa única
 * chamada e grava aqui o veredito de cada uma. As funções do TS
 * (`hasPtSigns`, `brOriginMark`, `parseTitleSeasonEpisode`, `matchesBrTitle`,
 * `extractInfoHash`, `magnetDisplayName`, `isSafeDownloadUrl`) consultam esta
 * memória primeiro e só calculam no TS quando a entrada não está nela.
 *
 * As chaves são a ENTRADA exata de cada função, e as funções são puras: um
 * acerto devolve o que o Rust calculou para aquela mesma entrada, uma falta
 * cai no TS. Nunca há resposta de outra entrada. Sem módulos do projeto além
 * de métricas: as funções de base importam daqui sem ciclo.
 */
import * as metrics from './metrics.js';

export type TitleVerdict = {
  hasPtSigns: boolean;
  brOriginMark: boolean;
  seasons: number[];
  episodes: number[];
  complete: boolean;
  seasonPack: boolean;
};

// Teto por mapa: uma coleta grande tem centenas de releases × nomes; ao
// encher, zera (os vereditos voltam na próxima coleta).
const MAX_ENTRIES = 50_000;

/** Item bruto como os filtros o recebem (só os campos que o lote lê). */
export type PrimeItem = { title?: string; Title?: string; magnet?: string; MagnetUri?: string; Guid?: string; isBr?: boolean };
export type VerdictPrimer = (
  items: readonly PrimeItem[],
  names: readonly string[],
  year: number | string | null | undefined,
  isSeries: boolean,
) => void;

let enabled = false;
let primer: VerdictPrimer | null = null;
const byTitle = new Map<string, TitleVerdict>();
const byMagnet = new Map<string, { infoHash: string | null; displayName: string }>();
const byLink = new Map<string, boolean>();
const byBrTitle = new Map<string, boolean>();

function put<V>(map: Map<string, V>, key: string, value: V) {
  if (map.size >= MAX_ENTRIES) map.clear();
  map.set(key, value);
}

function look<V>(map: Map<string, V>, key: string): V | undefined {
  if (!enabled) return undefined;
  const v = map.get(key);
  metrics.count(v === undefined ? 'rust.batch.miss' : 'rust.batch.hit');
  return v;
}

/** Chave do `matchesBrTitle`: tudo que muda o veredito (tokens são derivados). */
export function brTitleKey(
  title: string,
  name: string,
  year: number | string | null | undefined,
  isSeries: boolean,
  allNames: readonly string[] | null | undefined,
): string {
  return [title, name, year == null ? '' : String(year), isSeries ? '1' : '0', (allNames || []).join('\u0001')].join('\u0000');
}

/**
 * Liga a consulta com o preparador do lote (só o boot com `RUST_CORE=on`,
 * via `rust-shadow.ts`); null desliga e esvazia.
 */
export function installVerdictPrimer(p: VerdictPrimer | null): void {
  primer = p;
  enabled = Boolean(p);
  if (!p) clearVerdictMemo();
}

/**
 * Chamado pelo filtro de relevância com o lote que ele vai julgar: o Rust
 * calcula os vereditos numa chamada e o filtro os lê pelas funções de base.
 * Erro do lote vira métrica; o filtro segue no TS para o que faltar.
 */
export function primeVerdicts(
  items: readonly PrimeItem[],
  names: readonly string[],
  year: number | string | null | undefined,
  isSeries: boolean,
): void {
  if (!primer || items.length === 0 || names.length === 0) return;
  try {
    primer(items, names, year, isSeries);
  } catch {
    metrics.count('rust.batch.error');
  }
}

export function verdictMemoEnabled(): boolean {
  return enabled;
}

export function clearVerdictMemo(): void {
  byTitle.clear();
  byMagnet.clear();
  byLink.clear();
  byBrTitle.clear();
}

export function rememberTitle(title: string, v: TitleVerdict): void {
  put(byTitle, title, v);
}

export function rememberMagnet(magnet: string, infoHash: string | null, displayName: string): void {
  if (magnet) put(byMagnet, magnet, { infoHash, displayName });
}

export function rememberLink(link: string, safe: boolean): void {
  if (link) put(byLink, link, safe);
}

export function rememberBrTitle(key: string, matches: boolean): void {
  put(byBrTitle, key, matches);
}

export function titleVerdict(title: string): TitleVerdict | undefined {
  return look(byTitle, title);
}

export function magnetVerdict(magnet: string): { infoHash: string | null; displayName: string } | undefined {
  return magnet ? look(byMagnet, magnet) : undefined;
}

export function linkVerdict(link: string): boolean | undefined {
  return link ? look(byLink, link) : undefined;
}

/** O lote já calculou esta chave? Sem métrica: é o preparador perguntando. */
export function knownBrTitle(key: string): boolean {
  return enabled && byBrTitle.has(key);
}

export function brTitleVerdict(key: string): boolean | undefined {
  return look(byBrTitle, key);
}
