// Adaptador de raspagem do "Mico Leão Dublado" (Fase 1: filmes; Fase 2: séries).
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
//   mas `GET /catalog/<type>/<id>/genre=<G>/skip=N.json` devolve `metas: []`
//   para TODOS. A descoberta usa PAGINAÇÃO SIMPLES (`skip=N`), que cobre o
//   catálogo inteiro: 3.265 filmes únicos em ~70 páginas e 1.773 séries em 45
//   páginas (o teto de skip de série foi ATINGIDO — pode haver mais). NÃO use
//   gêneros. Tamanho de página VARIÁVEL (14 a 97 metas): o `skip` avança pelo
//   número REAL de metas e a varredura termina na primeira página vazia.
// - Ordem: mais novos primeiro. API rápida e estável (p50 60ms/p95 540ms, 0×
//   429 e 0× 5xx no ritmo de 1 s).
//
// ## Estrutura (teto de 400 linhas/arquivo)
//
// - `mico-shared.ts`: primitivas PURAS (balde de releitura `bucketLastmod`,
//   `parseMicoUrl`), o throttle PRÓPRIO e a leitura de UMA página de catálogo.
// - `mico-series.ts`: descoberta e leitura de SÉRIES (Fase 2 — episódios pela
//   Cinemeta, progresso retomável). Este módulo orquestra: `discover` soma
//   filmes (+ séries quando `opts.series.enabled`) e `fetchWork` roteia por kind.
//
// ## URL sintética e lastmod como balde de releitura
//
// A identidade na fila é uma URL sintética estável
// (`<host do Mico>/crawl/(movie|series)/<tt>/`): o `url_key` (só o caminho)
// sobrevive à troca de host. O catálogo não publica data, então o `lastmod` é
// SINTÉTICO — `bucketLastmod` devolve a data do balde de releitura da obra:
// filmes a cada `MICO_CRAWL_REREAD_DAYS` (14) dias, séries a cada 30 (o acervo
// de série muda mais devagar e cada obra custa várias chamadas de episódio).
//
// ## Ritmo e isolamento
//
// Throttle PRÓPRIO (module-level em `mico-shared.ts`, `MICO_CRAWL_MIN_GAP_MS`):
// o raspador NUNCA reutiliza o breaker da busca ao vivo — o erro do crawler não
// pode abrir o circuito da resposta. Falha de rede vira `throw withRequestCost`
// (o motor faz backoff), nunca exceção crua sem custo e nunca derruba o motor.
import config from '../../config.js';
import { fetchMicoStreams, micoMovieStreamUrl } from '../mico.js';
import type { RawItem } from '../../../types/domain.js';
import type {
  CrawlDiscoverOptions, CrawlDiscovery, CrawlPageKind, CrawlPageOptions, CrawlSite, CrawlWorkResult,
} from '../crawl-types.js';
import { withRequestCost } from './shared.js';
import {
  MOVIE_CATALOG_ID,
  discoverKind, honorRetryAfter, parseMicoUrl, throttle,
} from './mico-shared.js';
import type { KindDiscovery } from './mico-shared.js';
import { discoverSeries, fetchSeriesWork } from './mico-series.js';

// Reexportadas para os testes (que importam de `crawl-sites/mico.js`).
export { bucketLastmod, parseMicoUrl, _resetThrottleForTest } from './mico-shared.js';

const SITE_ID = 'mico';
const SITE_LABEL = 'Mico Leão Dublado';

/** O kind do CAMINHO da URL (`movie`/`series`) para o kind da FILA
 * (`CrawlPageKind`: `movie`/`tv_show`). A identidade na fila de uma série é
 * `tv_show`, mas `parseMicoUrl` lê `series` do caminho — sem o mapa, uma série
 * legítima cairia no "kind divergente". */
function pageKindOf(urlKind: 'movie' | 'series'): CrawlPageKind {
  return urlKind === 'series' ? 'tv_show' : 'movie';
}

/**
 * Descoberta de FILMES (paginação simples do `MicoFilmes`, dedupe por IMDb,
 * `lastmod` = balde de `period` dias). Best-effort por página: falha de UMA
 * página registra em `failures` e segue com passo nominal; falha TOTAL
 * (`totalFailure`) é decidida pelo `discover`.
 */
async function discoverMovies(now: number, period: number): Promise<KindDiscovery> {
  return discoverKind('movie', MOVIE_CATALOG_ID, now, period);
}

/**
 * Fábrica do adaptador. O `discover` IGNORA o `since`: o catálogo inteiro (~20
 * mil obras por tipo em ~450 páginas) é lido no máximo a cada
 * `MICO_CRAWL_FULL_SWEEP_HOURS`, e entre elas a rodada só lê o topo até achar
 * obras já na fila (`discoverKind`). A releitura fica por conta do `lastmod`
 * sintético (balde de releitura) no upsert do store. Séries só entram
 * com `opts.series.enabled` (default seguro: NÃO descobrir `tv_show`).
 */
export function createMicoCrawlSite(): CrawlSite {
  return {
    id: SITE_ID,
    label: SITE_LABEL,

    async discover(_since?: string | null, opts?: CrawlDiscoverOptions): Promise<CrawlDiscovery> {
      const now = Date.now();
      const movie = await discoverMovies(now, config.mico.crawlRereadDays);
      // Falha TOTAL de filme LANÇA (como na Fase 1): sem obra não há descoberta
      // útil e o motor retenta. Catálogo vazio/ilegível é exceção, nunca
      // "vazio e completo" (regra de todos os sites).
      if (movie.totalFailure) {
        throw withRequestCost(
          new Error(`mico: descoberta de filmes falhou (${movie.failures.length} página(s) em erro, ${movie.urls.length} obra(s))`),
          movie.requestCost,
        );
      }
      // Séries (Fase 2) só com `opts.series.enabled`. A falha TOTAL de série
      // NÃO derruba a de filme: marca `tv_show` incompleto (o cursor de série
      // simplesmente não anda) e segue com os filmes descobertos.
      const series = opts?.series?.enabled ? await discoverSeries(now) : null;
      const urls = series ? [...movie.urls, ...series.urls] : movie.urls;
      const failures = series ? [...movie.failures, ...series.failures] : movie.failures;
      const movieComplete = movie.complete;
      const seriesComplete = series ? series.complete : true;
      return {
        urls,
        complete: movieComplete && seriesComplete,
        failures,
        // Sem `opts.series.enabled`, `tv_show` sai `true` sem URLs (fonte não
        // consultada — o cursor de série não anda), como na Fase 1.
        // Rodada incremental não move o cursor: ela só leu o topo do catálogo.
        completeByKind: {
          movie: movie.fullSweep && movieComplete,
          tv_show: series ? series.fullSweep && seriesComplete : true,
        },
        requestCost: movie.requestCost + (series?.requestCost ?? 0),
      };
    },

    async fetchWork(url: string, opts?: CrawlPageOptions): Promise<CrawlWorkResult> {
      const parsed = parseMicoUrl(url);
      if (!parsed) {
        // URL que não é do Mico: erro sem NENHUMA rede (a fila pode ter sido editada).
        return { url, status: 'error', error: `mico: URL inválida: ${url}`, requestCost: 0 };
      }
      const kind = opts?.kind ?? 'movie';
      if (pageKindOf(parsed.kind) !== kind) {
        return {
          url, status: 'error', requestCost: 0,
          error: `mico: kind divergente (url=${parsed.kind}, fila=${kind})`,
        };
      }
      // SÉRIE (Fase 2): episódios pela Cinemeta, groups por locação, progresso
      // retomável. Todo o desenho vive em `mico-series.ts`.
      if (parsed.kind === 'series') {
        return fetchSeriesWork(url, parsed.imdb, opts);
      }

      // FILME: uma chamada a `/stream/movie/<tt>.json`, IMDb pronto.
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
