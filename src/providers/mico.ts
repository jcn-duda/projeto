import config from '../config.js';
import type { MatchContext, RawItem } from '../../types/domain.js';
import { looksPtBr, filterRelevantRaw } from '../utils/format.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as indexerStatus from './indexer-status.js';
import { captureItems } from '../utils/magnet-bank.js';

/**
 * Addon público "Mico Leão Dublado V2" como card de indexer VIRTUAL.
 *
 * Aparece no catálogo da /configure ao lado dos cards do Jackett (id `mico`) e
 * obedece a seleção `ji`, a prioridade `ip` e o limite `jl` como qualquer
 * indexer — mas não passa pelo Jackett: o Mico é um addon Stremio, consultado
 * por IMDb, e o Cardigann só manda texto. Por isso o id é retirado de toda
 * lista que vira consulta ao Jackett (`jackettOnly`).
 *
 * O matching dele é fraco (Coringa traz Harley Quinn/South Park; em 48 hashes
 * de 5 obras só ~5 eram acréscimo útil): os itens entram no lote cru ANTES do
 * filtro de relevância — o lixo de outra obra morre lá, como o do Jackett.
 * Falha NUNCA derruba a busca nem a colheita: devolve `[]`.
 */
export const MICO_ID = 'mico';

/** Tira o card virtual de uma lista que vai virar consulta ao Jackett. */
export function jackettOnly<T>(ids: readonly T[]): T[] {
  return ids.filter((id) => String(id).trim().toLowerCase() !== MICO_ID);
}

/** Entrada do catálogo da /configure (mesmo shape dos cards do Jackett). */
export function catalogEntry(): { id: string; label: string; language: string; isBr: boolean; virtual: true } | null {
  if (!config.mico.enabled) return null;
  // `virtual` separa o card da prova de vida do Jackett: catálogo vivo só com
  // ele continua sendo "Jackett sem indexer" no painel.
  return { id: MICO_ID, label: 'Mico Leão Dublado', language: 'pt-BR', isBr: true, virtual: true };
}

export interface SearchArgs {
  type: string;
  imdbId: string;
  season?: number | null;
  episode?: number | null;
  /** Ano de estreia da obra (liga o veto de identidade na captura do banco). */
  year?: number | string | null;
}

interface SearchOptions {
  /** Pinta o card (online/offline). O colhedor passa `false`. */
  recordStatus?: boolean;
  /** Mesma semântica do `jackett.search`: coleta viva zera o `passed_filter`
   * da obra (o build reescreve); a de fundo preserva a última avaliação. */
  resetPassedFilter?: boolean;
  /** Estado vivo da coleta (fallback do acervo): `responded` por consulta. */
  onQueryResult?: (info: { indexer: string; responded: boolean; reason?: 'error' | 'breaker'; relevant?: number }) => void;
  /** Obra da busca: mede quantos itens passam no filtro de título (`relevant`),
   * a mesma régua do Jackett para o "vazio suspeito". */
  matchContext?: MatchContext;
}

const INFO_HASH = /^[0-9a-f]{40}$/i;
const IMDB_ID = /^tt\d{1,10}$/;
const SEEDERS = /👥\s*([\d.,]+)/u;
const SIZE = /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/iu;
const SIZE_MULT: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Primeira linha sem os sufixos `(brazilian, eng)`, `👥 N`, `💾 X GB` e emojis. */
function cleanTitle(firstLine: string): string {
  return firstLine
    .replace(/\s*👥.*$/u, '')
    .replace(/\s*💾.*$/u, '')
    .replace(/\s*\((?:[a-z]+(?:\s*,\s*[a-z]+)*)\)\s*$/i, '')
    // O Mico corta a linha longa no meio do sufixo: "…DUAL-RICKSZ (brazili…".
    .replace(/\s*\([a-z ,]*…\s*$/i, '')
    .replace(/…\s*$/u, '')
    .replace(/\p{Extended_Pictographic}|\u{FE0F}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TRACKER = /^(?:udp|https?|wss?):\/\/[^\s&#]+$/i;

/**
 * Magnet com os trackers que o Mico publica em `sources` (formato do Stremio:
 * `tracker:`/`dht:` prefixados ou a URL crua). SEM `dn=`: o título do Mico é o
 * texto do post, não o nome do torrent, e `dn=` é evidência de arquivo para o
 * resto do pipeline (ano, promessa de dublado). O banco sanitiza e soma o piso.
 */
function magnetOf(hash: string, sources: unknown): string {
  const trackers = new Set<string>();
  for (const raw of Array.isArray(sources) ? sources : []) {
    const url = String(raw || '').trim().replace(/^tracker:/i, '');
    if (TRACKER.test(url)) trackers.add(url);
  }
  return `magnet:?xt=urn:btih:${hash}${[...trackers].map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
}

function mapStream(s: any): RawItem | null {
  const infoHash = String(s?.infoHash || '').trim();
  if (!INFO_HASH.test(infoHash)) return null;
  const full = String(s?.title || '');
  const title = cleanTitle(full.split('\n')[0] || '');
  if (!title) return null;
  const seedMatch = full.match(SEEDERS);
  const seeders = seedMatch ? Number(seedMatch[1].replace(/[.,]/g, '')) : NaN;
  const sizeMatch = full.match(SIZE);
  const size = sizeMatch ? Math.round(Number(sizeMatch[1]) * (SIZE_MULT[sizeMatch[2].toUpperCase()] || 0)) : 0;
  const hash = infoHash.toLowerCase();
  return {
    title,
    infoHash: hash,
    magnet: magnetOf(hash, s?.sources),
    // Sem 👥 a fonte não publicou seeders: 1 é o neutro das fontes BR (0 seria
    // descartado por MIN_SEEDERS antes de qualquer avaliação).
    seeders: Number.isFinite(seeders) ? seeders : 1,
    size: size > 0 ? size : undefined,
    indexer: 'mico',
    isBr: looksPtBr(title) || /\(brazil/i.test(full),
  };
}

let breakerFailures = 0;
let breakerOpenedAt = 0;

function breakerOpen(): boolean {
  if (breakerFailures < config.mico.breakerFailures) return false;
  return Date.now() - breakerOpenedAt < config.mico.breakerCooldown;
}

function noteFailure() {
  breakerFailures += 1;
  if (breakerFailures >= config.mico.breakerFailures) {
    breakerOpenedAt = Date.now();
    if (breakerFailures === config.mico.breakerFailures) log.warn(`[mico] circuito aberto após ${breakerFailures} falha(s) seguidas`);
  }
}

function _resetBreaker() {
  breakerFailures = 0;
  breakerOpenedAt = 0;
}

/**
 * Reparo do diagnóstico (`mico-diag.ts`): zera SÓ o contador de falhas — o
 * `/test-indexer` do Jackett repara do mesmo jeito. `breakerOpen()` exige
 * falhas acumuladas, então isso basta para reabrir o circuito.
 */
function repairBreaker() {
  breakerFailures = 0;
}

/** Valida IMDb id no formato `tt\d{1,10}`. */
function validImdb(tt: string): boolean {
  return IMDB_ID.test(String(tt || ''));
}

/**
 * URL do endpoint de FILME do Mico (`/stream/movie/<tt>.json`); `null` com
 * IMDb inválido. Exportado para o raspador (`crawl-sites/mico.ts`) montar a
 * mesma URL que a busca ao vivo usa.
 */
export function micoMovieStreamUrl(tt: string): string | null {
  if (!validImdb(tt)) return null;
  return `${config.mico.url}/stream/movie/${tt}.json`;
}

/**
 * URL do endpoint de EPISÓDIO (`/stream/series/<tt>:<S>:<E>.json`); `null` com
 * IMDb/temporada/episódio inválidos. Fase 2 do raspador — exportado já na
 * Fase 1 para o contrato ficar completo.
 */
export function micoEpisodeStreamUrl(tt: string, s: number, e: number): string | null {
  if (!validImdb(tt) || !Number.isInteger(s) || !Number.isInteger(e)) return null;
  return `${config.mico.url}/stream/series/${tt}:${s}:${e}.json`;
}

function endpointUrl({ type, imdbId, season, episode }: SearchArgs): string | null {
  if (type === 'movie') return micoMovieStreamUrl(imdbId);
  if (type !== 'series') return null;
  return micoEpisodeStreamUrl(imdbId, season as number, episode as number);
}

/** Erro HTTP do Mico que sobe para o chamador (busca ao vivo OU raspador). */
export interface MicoHttpError extends Error {
  /** Status HTTP (429/5xx) que provocou o erro. */
  status?: number;
  /** `Retry-After` convertido para MILISSEGUNDOS (do header em segundos ou
   * data HTTP); ausente quando o servidor não o mandou. */
  retryAfter?: number;
}

/**
 * `Retry-After` → ms. Aceita delta-segundos (`120`) e data HTTP
 * (`Wed, 21 Oct 2026 07:28:00 GMT`); `null` quando ausente/ilegível.
 * Exportada para o raspador (`crawl-sites/mico-shared.ts`) honrar o mesmo
 * header na leitura de catálogo — SEM ciclo: este módulo é folha w.r.t.
 * `crawl-sites` (não importa nada dali).
 */
export function retryAfterMs(header: string | null | undefined): number | null {
  const raw = String(header ?? '').trim();
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Fetch PURO dos streams de uma URL do Mico: valida HTTP, mapeia (`mapStream`)
 * e deduplica por `infoHash`. SEM `captureItems`, SEM pintar card
 * (`indexerStatus.record`), SEM `onQueryResult`, SEM breaker — é o núcleo
 * compartilhado pela busca ao vivo (`search`, que embrulha a política de
 * card/breaker/banco) e pelo raspador (`crawl-sites/mico.ts`, que embrulha o
 * próprio throttle). O raspador NUNCA reutiliza o breaker daqui.
 *
 * Devolve `{ items, ok }`. `ok` é `true` SÓ para HTTP `200` — é o sinal que o
 * `search` usa para decidir se RESETA o breaker ao vivo. Um `4xx` (exceto 429)
 * devolve `items: []` com `ok: false`: é da obra/requisição, não prova host
 * caído, então é NEUTRO para o circuito (não reseta, não incrementa) — exatamente
 * como o `search` histórico, que retornava `[]` ANTES do `breakerFailures = 0`.
 *
 * Semântica HTTP (a MESMA do `search` histórico):
 *  - `200` → `{ items, ok: true }` (parseia; `items` pode ser `[]`);
 *  - `4xx` exceto `429` → `{ items: [], ok: false }` (não prova host caído);
 *  - `429` ou `5xx` → LANÇA `MicoHttpError` com `status` e `retryAfter` (ms);
 *  - erro de rede/timeout → LANÇA o erro original.
 */
export async function fetchMicoStreams(url: string, timeoutMs: number): Promise<{ items: RawItem[]; ok: boolean }> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    // 4xx (salvo 429) é da obra, não prova host caído: devolve vazio com
    // `ok:false` (o `search` NÃO reseta o breaker; o raspador trata como
    // `no-torrent`). É NEUTRO para o circuito, como no `search` histórico.
    if (res.status < 500 && res.status !== 429) {
      log.warn(`[mico] HTTP ${res.status} para ${url}`);
      return { items: [], ok: false };
    }
    const err: MicoHttpError = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    const retryAfter = retryAfterMs(res.headers?.get?.('Retry-After'));
    if (retryAfter != null) err.retryAfter = retryAfter;
    throw err;
  }
  const data: any = await res.json();
  const raw = Array.isArray(data?.streams) ? data.streams : [];
  const seen = new Set<string>();
  const items: RawItem[] = [];
  for (const item of raw) {
    const parsed = mapStream(item);
    if (!parsed?.infoHash || seen.has(parsed.infoHash)) continue;
    seen.add(parsed.infoHash);
    items.push(parsed);
  }
  return { items, ok: true };
}

/**
 * `recordStatus` pinta o card (online/slow/offline) como a busca viva do
 * Jackett faz; o colhedor passa `false` — medição de fundo não é a da resposta.
 * Tudo que tem hash vai para o banco de magnets vivo ANTES de qualquer filtro,
 * como no Jackett: o acervo guarda o que a fonte devolveu, a lista decide.
 */
async function search(args: SearchArgs, options: SearchOptions = {}): Promise<RawItem[]> {
  const { recordStatus = true, resetPassedFilter = true, onQueryResult, matchContext } = options;
  if (!config.mico.enabled) return [];
  const url = endpointUrl(args);
  // Nada a perguntar (id/episódio inválido) não é falha da fonte; circuito
  // aberto é — o estado vivo precisa saber para a reserva do acervo cobrir.
  if (!url) {
    onQueryResult?.({ indexer: MICO_ID, responded: true });
    return [];
  }
  if (breakerOpen()) {
    onQueryResult?.({ indexer: MICO_ID, responded: false, reason: 'breaker' });
    return [];
  }
  // Contador de consulta REAL (alvo válido, circuito fechado): é o denominador
  // de `mico.error` e de `mico.ms` — sem ele erro e latência não têm base de
  // comparação. Denominador de TODAS as tentativas (busca do usuário, colhedor
  // E diagnóstico), não só de requests de usuário.
  metrics.count('mico.query');
  const started = Date.now();
  const note = (ok: boolean, items: RawItem[] = []) => {
    const ms = Date.now() - started;
    // Latência de TODA tentativa (sucesso e falha): a falha também cobrou tempo.
    metrics.observe('mico.ms', ms);
    if (recordStatus) indexerStatus.record(MICO_ID, { ok, ms, budgetMs: config.mico.timeout, results: items.length });
    if (!ok) {
      onQueryResult?.({ indexer: MICO_ID, responded: false, reason: 'error' });
      return;
    }
    // Relevância só existe com a obra na mão (matchContext): sem ela, bruto
    // não vira "útil" — nem na resposta, nem na métrica.
    const relevant = matchContext?.names?.length ? filterRelevantRaw(items, matchContext).length : undefined;
    if (relevant !== undefined) {
      metrics.count('mico.relevant', relevant);
      metrics.count('mico.discarded', items.length - relevant);
    }
    onQueryResult?.({ indexer: MICO_ID, responded: true, ...(relevant !== undefined ? { relevant } : {}) });
  };
  try {
    const { items: out, ok } = await fetchMicoStreams(url, config.mico.timeout);
    // Só um HTTP 200 prova host vivo e RESETA o circuito. Um 4xx (exceto 429)
    // vem com `ok:false` e `out:[]`: é NEUTRO — não reseta nem incrementa,
    // exatamente como o `search` histórico (que retornava `[]` antes do reset).
    // A métrica `mico.items` também só conta no sucesso: no 4xx o original
    // retornava antes de qualquer efeito colateral, e contar `0` ali seria um
    // evento que nunca existiu (paridade exata de efeitos colaterais).
    // 429/5xx/rede LANÇAM e caem no `catch` abaixo (`noteFailure`).
    if (ok) {
      breakerFailures = 0;
      metrics.count('mico.items', out.length);
    }
    captureItems(out, MICO_ID, {
      imdbId: args.imdbId,
      season: args.season ?? null,
      episode: args.episode ?? null,
      year: args.year ?? null,
      resetPassedFilter,
    });
    note(true, out);
    return out;
  } catch (err: any) {
    noteFailure();
    metrics.count('mico.error');
    note(false);
    log.warn(`[mico] falha na consulta de ${args.imdbId}:`, err?.message || String(err));
    return [];
  }
}

export { search, repairBreaker, _resetBreaker };
