// Primitivas COMPARTILHADAS do adaptador de raspagem do "Mico Leão Dublado"
// (filmes em `mico.ts`, séries em `mico-series.ts`). Vive num módulo próprio
// para que os dois adaptadores importem daqui sem formar ciclo (mico →
// mico-series → mico-shared; mico → mico-shared) e para caber no teto de 400
// linhas/arquivo depois que as séries entraram (Fase 2).
//
// Nada aqui grava banco nem decide quando rodar: são funções PURAS (balde de
// releitura, parse de URL sintética), o throttle PRÓPRIO do raspador e a
// leitura de UMA página de catálogo. O raspador NUNCA reutiliza o breaker da
// busca ao vivo (`../mico.ts`): o erro do crawler não pode abrir o circuito da
// resposta — o throttle é isolado, module-level, daqui.
import config from '../../config.js';
import * as log from '../../utils/logger.js';
import * as store from '../../utils/crawl-store.js';
import { retryAfterMs } from '../mico.js';
import type { CrawlDiscoverOptions, DiscoveredUrl } from '../crawl-types.js';

/** id do catálogo de FILMES do Mico (paginação simples; gênero está quebrado). */
export const MOVIE_CATALOG_ID = 'MicoFilmes';
/** id do catálogo de SÉRIES do Mico (mesma paginação simples; gênero quebrado). */
export const SERIES_CATALOG_ID = 'MicoSeries';

const IMDB_RE = /^tt\d{1,10}$/;
/** Passo do `skip`: o da API é um índice BRUTO e `metas.length` NÃO o mede (a
 * página volta deduplicada: 12 a 98 metas no começo, 50 depois). Avançar por
 * `metas.length` parava em ~380 obras de ~20 mil. Abaixo de `STRIDE_SWITCH` as
 * janelas se sobrepõem e o passo curto não deixa buraco (passo 10 achou 953
 * filmes onde o 50 achou 933); acima, a página é fixa em 50. */
export const STRIDE_SWITCH = 1000;
export function strideAt(skip: number): number {
  return skip < STRIDE_SWITCH ? 25 : 50;
}
const DAY_MS = 86_400_000;

/** Hash determinístico de string (FNV-1a 32 bits) — sem dependência externa. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Número do dia (desde o epoch) → `YYYY-MM-DD` (UTC). */
function isoDay(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Data ISO (`YYYY-MM-DD`) do início do balde de releitura da obra: o dia em que
 * o ciclo atual da obra começou. PURA (exportada para teste).
 *
 * Fórmula: `phase = fnv1a(tt) % period` (0..period-1) fixa o dia do ciclo em
 * que a obra "vira"; `cycle = floor((dayIndex - phase) / period)` conta quantos
 * períodos já se passaram desde o epoch alinhado à fase; o lastmod é o dia
 * `cycle*period + phase`. Propriedades (testadas em `crawl-mico.test.ts`):
 *  1. ESTÁVEL dentro do período: `period` dias consecutivos → mesmo lastmod;
 *  2. MUDA no período seguinte: avançando `period` dias, o lastmod muda;
 *  3. ESPALHA as obras: num dado dia, ~1/`period` do catálogo "vira" (a fase é
 *     o hash do IMDb, então só as obras com `phase == dia mod period` renovam);
 *  4. MÁXIMO MONOTÔNICO: cada lastmod é não-decrescente em `now`, logo o `max`
 *     do catálogo não anda para trás (o cursor `advanceCursors` exige isso).
 *
 * Filmes usam `MICO_CRAWL_REREAD_DAYS` (default 14); séries usam um período
 * MAIS LONGO (30 dias — o acervo de série muda mais devagar e a obra custa
 * várias chamadas de episódio).
 */
export function bucketLastmod(tt: string, now: number, periodDays = 14): string {
  const period = Math.max(1, Math.trunc(periodDays) || 14);
  const dayIndex = Math.floor(now / DAY_MS);
  const phase = fnv1a(String(tt)) % period;
  const cycle = Math.floor((dayIndex - phase) / period);
  return isoDay(cycle * period + phase);
}

/**
 * URL sintética → `{kind, imdb}`. PURA (exportada para teste). Valida host ===
 * `config.mico.url` e caminho `/crawl/(movie|series)/(tt\d{1,10})/`; qualquer
 * outra coisa é `null` (a fila pode ter sido editada — defesa em profundidade).
 */
export function parseMicoUrl(url: string): { kind: 'movie' | 'series'; imdb: string } | null {
  let parsed: URL;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  let base: URL;
  try { base = new URL(config.mico.url); } catch { return null; }
  if (parsed.host !== base.host) return null;
  const m = /^\/crawl\/(movie|series)\/(tt\d{1,10})\/$/.exec(parsed.pathname);
  if (!m) return null;
  return { kind: m[1] as 'movie' | 'series', imdb: m[2] };
}

/** Monta a URL sintética estável de uma obra (identidade na fila). */
export function syntheticUrl(kind: 'movie' | 'series', tt: string): string {
  return `${config.mico.url}/crawl/${kind}/${tt}/`;
}

// --- Throttle PRÓPRIO do raspador (module-level) -----------------------------
//
// Serializa as chamadas ao Mico com um intervalo mínimo (`crawlMinGapMs`) e
// honra `Retry-After` de um 429 adiando a próxima. NÃO toca o breaker da busca
// ao vivo: é uma cadeia de promessas + marca d'água de tempo, isolada aqui.
// Compartilhado por filme e série (é a MESMA API do Mico).
let throttleChain: Promise<void> = Promise.resolve();
let lastCallAt = 0;
/** Epoch ms até o qual a próxima chamada fica suspensa (429 + Retry-After). */
let notBefore = 0;

function minGap(): number {
  return Math.max(0, config.mico.crawlMinGapMs ?? 0);
}

/** Espera o intervalo mínimo (e o `Retry-After`) antes da próxima chamada. */
export function throttle(): Promise<void> {
  const run = throttleChain.then(async () => {
    const now = Date.now();
    const waitGap = lastCallAt === 0 ? 0 : Math.max(0, minGap() - (now - lastCallAt));
    const waitRetry = Math.max(0, notBefore - now);
    const delay = Math.max(waitGap, waitRetry);
    if (delay > 0) await new Promise((r) => { setTimeout(r, delay); });
    lastCallAt = Date.now();
  });
  // A cadeia continua mesmo se uma chamada falhar (o erro sobe pelo `run`).
  throttleChain = run.catch(() => {});
  return run;
}

/** Um 429 com `Retry-After` adia a próxima chamada do raspador. */
export function honorRetryAfter(err: unknown): void {
  const e = err as { status?: number; retryAfter?: number } | null;
  if (e?.status === 429 && typeof e.retryAfter === 'number' && e.retryAfter > 0) {
    notBefore = Math.max(notBefore, Date.now() + e.retryAfter);
  }
}

/** Reset do throttle (só teste: isola o estado module-level entre casos). */
export function _resetThrottleForTest(): void {
  throttleChain = Promise.resolve();
  lastCallAt = 0;
  notBefore = 0;
}

/** Uma página do catálogo: `{ count, ids }` (count = metas.length, tamanho real). */
export interface CatalogPage {
  /** Nº REAL de metas retornadas (avança o `skip`, que é de tamanho variável). */
  count: number;
  /** IMDb ids válidos da página (dedupe por obra é feito pelo chamador). */
  ids: string[];
}

/**
 * Busca UMA página do catálogo (`/catalog/<type>/<catalogId>/skip=N.json`) com
 * throttle. Lança em 429/5xx/rede. O `skip` avança pelo número REAL de metas
 * (tamanho de página é VARIÁVEL — 14 a 97 na Fase 0), não por passo fixo.
 */
export async function fetchCatalogPage(
  type: 'movie' | 'series',
  catalogId: string,
  skip: number,
): Promise<CatalogPage> {
  const url = `${config.mico.url}/catalog/${type}/${catalogId}/skip=${skip}.json`;
  await throttle();
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(config.mico.timeout),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number; retryAfter?: number };
    err.status = res.status;
    // Anexa o `Retry-After` (ms) quando presente: os loops de descoberta chamam
    // `honorRetryAfter(err)` e adiam a próxima página num 429, em vez de
    // martelar a API só com o `minGap`. Reusa o parser da busca ao vivo
    // (`../mico.ts`, folha — sem ciclo de import).
    const ra = retryAfterMs(res.headers?.get?.('Retry-After'));
    if (ra != null) err.retryAfter = ra;
    throw err;
  }
  const data: any = await res.json();
  const metas: any[] = Array.isArray(data?.metas) ? data.metas : [];
  const ids: string[] = [];
  for (const m of metas) {
    const id = String(m?.id || '').trim();
    if (IMDB_RE.test(id)) ids.push(id);
  }
  return { count: metas.length, ids };
}

/**
 * Resultado de UMA descoberta por kind (filme OU série), antes do merge no
 * `discover`. `totalFailure` distingue a falha TOTAL (primeira página caiu ou
 * nenhuma obra) — que LANÇA com `withRequestCost` — da falha de UMA página
 * (best-effort: `complete:false`, segue varrendo).
 */
export interface KindDiscovery {
  urls: DiscoveredUrl[];
  failures: string[];
  /** Sem falhas E com ao menos uma obra. */
  complete: boolean;
  /** Custo REAL em requisições (páginas de catálogo lidas). */
  requestCost: number;
  /** Primeira página caiu OU nenhuma obra descoberta (catálogo vazio/ilegível). */
  totalFailure: boolean;
  /** Varredura do catálogo inteiro (`false` = rodada incremental). Só a completa move o cursor. */
  fullSweep: boolean;
}

/** Resultado da varredura paginada de UM catálogo (filme ou série). */
export interface CatalogWalk {
  /** IMDb ids únicos, na ordem em que apareceram. */
  ids: string[];
  failures: string[];
  /** Páginas lidas (inclui reconsultas) — o custo real em requisições. */
  pages: number;
  firstPageFailed: boolean;
  /** Saiu por `crawlEndAfterEmpties` vazias seguidas (e não pelo teto de páginas). */
  sawEnd: boolean;
  /** Rodada incremental parou em páginas seguidas só com obras conhecidas. */
  stoppedAtKnown: boolean;
}

/** Rodada incremental: `isKnown` diz se a obra já está na fila. */
export interface WalkOptions {
  isKnown?: (tt: string) => boolean;
}

/**
 * Varre o catálogo com passo fixo (`strideAt`), reconsultando página vazia e
 * tolerando falha de UMA página (best-effort: registra e segue). O fim é um
 * fato observado — vazias seguidas, já reconsultadas —, nunca a primeira vazia.
 */
export async function walkCatalog(
  type: 'movie' | 'series',
  catalogId: string,
  opts: WalkOptions = {},
): Promise<CatalogWalk> {
  const maxPages = config.mico.crawlMaxPages;
  const ids: string[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];
  let skip = 0;
  let pages = 0;
  let firstPageFailed = false;
  let emptyRun = 0;
  let sawEnd = false;
  let knownRun = 0;
  let stoppedAtKnown = false;

  while (pages < maxPages) {
    let catalog: CatalogPage | null = null;
    let failed = false;
    for (let attempt = 0; attempt <= config.mico.crawlEmptyRetries && pages < maxPages; attempt += 1) {
      pages += 1;
      try {
        catalog = await fetchCatalogPage(type, catalogId, skip);
      } catch (err) {
        failures.push(`${type} skip=${skip}: ${log.errorMessage(err)}`);
        if (pages === 1) firstPageFailed = true;
        // 429 com Retry-After adia a próxima chamada (o throttle a honra).
        honorRetryAfter(err);
        failed = true;
        break;
      }
      if (catalog.count > 0) break;
    }
    if (!failed && catalog) {
      if (catalog.count === 0) {
        emptyRun += 1;
        if (emptyRun >= config.mico.crawlEndAfterEmpties) { sawEnd = true; break; }
      } else {
        emptyRun = 0;
        for (const tt of catalog.ids) {
          if (seen.has(tt)) continue;
          seen.add(tt);
          ids.push(tt);
        }
        // Incremental: o catálogo vem do mais novo para o mais antigo, então
        // páginas seguidas sem obra nova marcam onde a rodada anterior chegou.
        const allKnown = Boolean(opts.isKnown) && catalog.ids.length > 0
          && catalog.ids.every((tt) => opts.isKnown!(tt));
        knownRun = allKnown ? knownRun + 1 : 0;
        if (knownRun >= config.mico.crawlKnownPagesToStop) { stoppedAtKnown = true; break; }
      }
    }
    skip += strideAt(skip);
  }
  return { ids, failures, pages, firstPageFailed, sawEnd, stoppedAtKnown };
}

/** id do site na fila (o mesmo do adaptador em `mico.ts`). */
const SITE_ID = 'mico';
const HOUR_MS = 3_600_000;

/**
 * Descoberta de UM tipo. A varredura completa custa ~50 min na VPS (2 a 2,7 s
 * por página + o intervalo mínimo, medido em 2026-10-06) e rodava a cada
 * rodada incremental de 60 min: o Mico passava o tempo redescobrindo e a fila
 * de séries não andava (8.803 vencidas). Agora a completa roda no máximo a cada
 * `crawlFullSweepHours`; entre elas a rodada lê do topo e para em páginas só
 * com obras já na fila. Só a completa que viu o fim grava a hora; truncada ou
 * com falha, a próxima rodada tenta a completa de novo.
 */
export async function discoverKind(
  kind: 'movie' | 'series',
  catalogId: string,
  now: number,
  periodDays: number,
  opts: Pick<CrawlDiscoverOptions, 'noPersist'> = {},
): Promise<KindDiscovery> {
  const stateKey = `full-sweep:${kind}`;
  const lastFull = Number(store.engine().getState(SITE_ID, stateKey) || 0);
  const fullSweep = !(now - lastFull < config.mico.crawlFullSweepHours * HOUR_MS);
  const isKnown = fullSweep
    ? undefined
    : (tt: string) => store.engine().getUrl(SITE_ID, syntheticUrl(kind, tt)) != null;
  const walk = await walkCatalog(kind, catalogId, { isKnown });
  const queueKind = kind === 'series' ? 'tv_show' as const : 'movie' as const;
  const urls: DiscoveredUrl[] = walk.ids.map((tt) => (
    { url: syntheticUrl(kind, tt), lastmod: bucketLastmod(tt, now, periodDays), kind: queueKind }
  ));
  // Saída pelo TETO sem o fim observado = descoberta TRUNCADA: NÃO é `complete`,
  // senão viraria cursor/cobertura indevida (alinha com o listing-discover).
  const totalFailure = walk.firstPageFailed || urls.length === 0;
  const complete = walk.failures.length === 0 && urls.length > 0 && (walk.sawEnd || walk.stoppedAtKnown);
  // Observação (sonda): `noPersist` mantém a escolha normal full/incremental e
  // as marcações (complete/completeByKind/custo), mas NÃO grava o cursor — a
  // sonda nunca altera `crawl_state`; o `--write` dela autoriza só o veredito.
  if (fullSweep && complete && walk.sawEnd && !opts.noPersist) {
    store.engine().setState(SITE_ID, stateKey, String(now));
  }
  return { urls, failures: walk.failures, complete, requestCost: walk.pages, totalFailure, fullSweep };
}
