// Adaptador de raspagem do "Mico Leão Dublado" (Fase 1: SÓ filmes).
//
// ## O que o Mico é (e por que este adaptador é diferente dos outros oito)
//
// O Mico NÃO é um site nem um card do Jackett: é um addon Stremio público
// (`src/providers/mico.ts`, card virtual id `mico`), consultado por IMDb. É o
// NONO site do motor de raspagem e o único cuja "página de obra" é uma chamada
// de API JSON, não HTML — e o único que devolve o IMDb PRONTO (o `crawl-page`
// pula a identificação por TMDB/Cinemeta, a parte mais cara e frágil dos outros
// sites). Por isso o `title`/`year` que este adaptador devolve são SÓ
// diagnóstico: o recorder monta o contexto pelo IMDb (ver `crawl-recorder.ts`).
//
// ## Medição da Fase 0 que o desenho obedece (2026-10-02, API ao vivo)
//
// - O FILTRO DE GÊNERO ESTÁ QUEBRADO: o `/manifest.json` declara 17 gêneros,
//   mas `GET /catalog/movie/MicoFilmes/genre=<G>/skip=N.json` devolve
//   `metas: []` para TODOS. A descoberta usa PAGINAÇÃO SIMPLES
//   (`/catalog/movie/MicoFilmes/skip=N.json`), que cobre o catálogo inteiro:
//   3.265 filmes únicos em ~70 páginas (skip final ~3.475). NÃO use gêneros.
// - Tamanho de página VARIÁVEL (14 a 97 metas, não é fixo em 40): o `skip`
//   avança pelo número REAL de metas retornadas, e a varredura termina na
//   primeira página vazia (teto de segurança de 200 páginas).
// - Ordem: mais novos primeiro. API rápida e estável (p50 60ms/p95 540ms, 0×
//   429 e 0× 5xx no ritmo de 1 s). Séries ficam para a Fase 2 (o adaptador não
//   emite `tv_show`; `completeByKind.tv_show` sai `true` sem URLs).
//
// ## URL sintética e lastmod como balde de releitura
//
// A identidade na fila é uma URL sintética estável
// (`<host do Mico>/crawl/movie/<tt>/`): o `url_key` (só o caminho) sobrevive à
// troca de host. O catálogo não publica data, então o `lastmod` é SINTÉTICO —
// `bucketLastmod` devolve a data do balde de releitura da obra: cada obra é
// relida a cada `MICO_CRAWL_REREAD_DAYS` dias, e ~1/N do catálogo "vira" por
// dia (espalhado pelo hash do IMDb), sem um pico de reenfileiramento único.
//
// ## Ritmo e isolamento
//
// Throttle PRÓPRIO (module-level, `MICO_CRAWL_MIN_GAP_MS`): o raspador NUNCA
// reutiliza o breaker da busca ao vivo — o erro do crawler não pode abrir o
// circuito da resposta. Falha de rede vira `throw withRequestCost` (o motor faz
// backoff), nunca exceção crua sem custo e nunca derruba o motor.
import config from '../../config.js';
import * as log from '../../utils/logger.js';
import { fetchMicoStreams, micoMovieStreamUrl } from '../mico.js';
import type { RawItem } from '../../../types/domain.js';
import type {
  CrawlDiscoverOptions, CrawlDiscovery, CrawlPageOptions, CrawlSite, CrawlWorkResult, DiscoveredUrl,
} from '../crawl-types.js';
import { withRequestCost } from './shared.js';

const SITE_ID = 'mico';
const SITE_LABEL = 'Mico Leão Dublado';
/** id do catálogo de filmes do Mico (o de séries, `MicoSeries`, é Fase 2). */
const CATALOG_ID = 'MicoFilmes';
const IMDB_RE = /^tt\d{1,10}$/;
/** Teto de segurança de páginas por rodada de descoberta (o catálogo tem ~70). */
const MAX_PAGES = 200;
/** Passo nominal do `skip` quando UMA página falha (best-effort, tamanho médio). */
const NOMINAL_PAGE = 40;
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
function syntheticUrl(kind: 'movie' | 'series', tt: string): string {
  return `${config.mico.url}/crawl/${kind}/${tt}/`;
}

// --- Throttle PRÓPRIO do raspador (module-level) -----------------------------
//
// Serializa as chamadas ao Mico com um intervalo mínimo (`crawlMinGapMs`) e
// honra `Retry-After` de um 429 adiando a próxima. NÃO toca o breaker da busca
// ao vivo: é uma cadeia de promessas + marca d'água de tempo, isolada aqui.
let throttleChain: Promise<void> = Promise.resolve();
let lastCallAt = 0;
/** Epoch ms até o qual a próxima chamada fica suspensa (429 + Retry-After). */
let notBefore = 0;

function minGap(): number {
  return Math.max(0, config.mico.crawlMinGapMs ?? 0);
}

/** Espera o intervalo mínimo (e o `Retry-After`) antes da próxima chamada. */
function throttle(): Promise<void> {
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
function honorRetryAfter(err: unknown): void {
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

/** Uma página do catálogo de filmes: `{ count, ids }` (count = metas.length). */
interface CatalogPage {
  /** Nº REAL de metas retornadas (avança o `skip`, que é de tamanho variável). */
  count: number;
  /** IMDb ids válidos da página (dedupe por obra é feito pelo chamador). */
  ids: string[];
}

/** Busca UMA página do catálogo (com throttle). Lança em 429/5xx/rede. */
async function fetchCatalogPage(skip: number): Promise<CatalogPage> {
  const url = `${config.mico.url}/catalog/movie/${CATALOG_ID}/skip=${skip}.json`;
  await throttle();
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(config.mico.timeout),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number; retryAfter?: number };
    err.status = res.status;
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
 * Fábrica do adaptador. O `discover` IGNORA o `since` (lê o catálogo inteiro —
 * são ~70 páginas pequenas); o corte incremental fica por conta do `lastmod`
 * sintético (balde de releitura) no upsert do store.
 */
export function createMicoCrawlSite(): CrawlSite {
  return {
    id: SITE_ID,
    label: SITE_LABEL,

    async discover(_since?: string | null, _opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      const now = Date.now();
      const period = config.mico.crawlRereadDays;
      const urls: DiscoveredUrl[] = [];
      const failures: string[] = [];
      const seen = new Set<string>();
      let skip = 0;
      let pages = 0;
      let firstPageFailed = false;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        pages += 1;
        let catalog: CatalogPage;
        try {
          catalog = await fetchCatalogPage(skip);
        } catch (err) {
          // Falha de UMA página (429/5xx/rede): best-effort — registra, marca
          // incompleto e CONTINUA varrendo com um passo nominal.
          failures.push(`skip=${skip}: ${log.errorMessage(err)}`);
          if (page === 0) firstPageFailed = true;
          skip += NOMINAL_PAGE;
          continue;
        }
        // Página vazia = fim do catálogo (paginação simples cobre tudo).
        if (catalog.count === 0) break;
        for (const tt of catalog.ids) {
          if (seen.has(tt)) continue;
          seen.add(tt);
          urls.push({
            url: syntheticUrl('movie', tt),
            lastmod: bucketLastmod(tt, now, period),
            kind: 'movie',
          });
        }
        skip += catalog.count;
      }

      // Falha TOTAL: primeira página caiu OU nenhuma obra descoberta (catálogo
      // vazio/ilegível é exceção, nunca "vazio e completo").
      if (firstPageFailed || urls.length === 0) {
        throw withRequestCost(
          new Error(`mico: descoberta falhou (${failures.length} página(s) em erro, ${urls.length} obra(s))`),
          pages,
        );
      }
      const complete = failures.length === 0 && urls.length > 0;
      return {
        urls,
        complete,
        failures,
        // Fase 1 não emite série: `tv_show` sai `true` sem URLs (o cursor de
        // série simplesmente não anda).
        completeByKind: { movie: complete, tv_show: true },
        requestCost: pages,
      };
    },

    async fetchWork(url: string, opts?: CrawlPageOptions): Promise<CrawlWorkResult> {
      const parsed = parseMicoUrl(url);
      if (!parsed) {
        // URL que não é do Mico: erro sem NENHUMA rede (a fila pode ter sido editada).
        return { url, status: 'error', error: `mico: URL inválida: ${url}`, requestCost: 0 };
      }
      const kind = opts?.kind ?? 'movie';
      if (parsed.kind !== kind) {
        return {
          url, status: 'error', requestCost: 0,
          error: `mico: kind divergente (url=${parsed.kind}, fila=${kind})`,
        };
      }
      if (parsed.kind !== 'movie') {
        // Fase 1: séries não são raspadas (o discover não as emite).
        return { url, status: 'error', error: 'mico: séries ficam para a Fase 2', requestCost: 0 };
      }

      const tt = parsed.imdb;
      const streamUrl = micoMovieStreamUrl(tt);
      if (!streamUrl) {
        return { url, status: 'error', error: `mico: IMDb inválido ${tt}`, requestCost: 0 };
      }
      await throttle();
      let items: RawItem[];
      try {
        // `fetchMicoStreams` devolve `{ items, ok }`; o raspador usa só `items`
        // e ignora o `ok` (que é sinal do breaker AO VIVO, nunca reutilizado
        // aqui). Um 4xx vem com `items:[]` → cai no `no-torrent` abaixo, sem
        // lançar. Só 429/5xx/rede LANÇAM (catch → backoff do motor).
        ({ items } = await fetchMicoStreams(streamUrl, config.mico.timeout));
      } catch (err) {
        // 429/5xx/rede: honra o Retry-After e sobe com o custo medido (o motor
        // faz o backoff). NUNCA exceção crua sem custo.
        honorRetryAfter(err);
        throw withRequestCost(err, 1);
      }
      if (!items.length) {
        // Sem stream (~87% da amostra): o próximo balde de releitura relê.
        return { url, status: 'no-torrent', imdb: tt, requestCost: 1 };
      }
      // `title` do 1º release é só diagnóstico — o recorder usa Cinemeta/TMDB
      // pelo IMDb pronto. NÃO faz rede extra para preenchê-lo.
      const first = items[0];
      return {
        url,
        status: 'done',
        imdb: tt,
        type: 'movie',
        releases: items,
        requestCost: 1,
        ...(first?.title ? { title: String(first.title) } : {}),
      };
    },
  };
}

/**
 * Instância de produção. O registry chama este export sem argumentos. A entrada
 * SÓ existe com `config.mico.enabled`: desligado, a fábrica lança e o
 * `ensureSite('mico')` devolve `null` (o card some, como na busca ao vivo).
 */
export function micoCrawlSite(): CrawlSite {
  if (!config.mico.enabled) {
    throw new Error('mico: fonte desligada (MICO_ENABLED=false) — raspagem indisponível');
  }
  return createMicoCrawlSite();
}
