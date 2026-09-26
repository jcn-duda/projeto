// Busca de obra no TMDB por TÍTULO (não por IMDb id) — a metade que faltava
// para a identificação da raspagem (plano "Raspagem total", Fase 2). O
// `getTitles` do tmdb.ts resolve título a PARTIR de um IMDb id; a página de
// site BR sem IMDb ancorado precisa do caminho INVERSO: título + ano → obra
// → IMDb. Módulo irmão de propósito: o tmdb.ts já vive perto da catraca de
// 400 linhas e importar os helpers dele daqui criaria ciclo (tmdb → aqui →
// tmdb), então fetch/TTL são locais e o `tmdb.ts` só reexporta.
//
// Segurança do casamento (contrato da Fase 2, não negociável): obra errada é
// pior que obra nenhuma. A QUERY NÃO LEVA O ANO — o ano que o site publica é
// o do lançamento (frequentemente o ano BR, ±1 do ano primário do TMDB), e
// filtrar pela data EXATA na API esconderia a obra certa justamente nos
// casos de homônimo em que a identificação importa. O ano entra como filtro
// LOCAL de tolerância ±1 sobre os candidatos, e candidato SEM ano legível
// quando a página TEM ano é descartado, não aceito. Nome estrito e
// ambiguidade são decisão do `crawl-identify` — nunca desta camada.
//
// CONTRATO DE PRAZO — background-only, inegociável: este módulo NÃO tem
// `deadlineAt` e não deve ter. Cada chamada usa `AbortSignal.timeout` fixo
// (TMDB_TIMEOUT_MS) e o `identifyWork` encadeia DUAS chamadas em sequência
// (busca + external_ids) — até ~2× o teto. Isso só cabe FORA da resposta: o
// consumidor é o motor da raspagem (fundo, Fase 3). Colar esta camada no
// caminho de busca ao vivo é bug de orçamento (invariante 1) — lá o que vale
// é o `getTitles` do tmdb.ts, que aceita `deadlineAt`. Nenhum knob de prazo
// próprio: o teto é o TMDB_TIMEOUT_MS que já existe.
import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';
import { normalizeTitle } from './title-normalization.js';

const API = 'https://api.themoviedb.org/3';

/** Tipo da obra, no vocabulário do crawler (`CrawlWorkResult.type`). */
export type SearchWorkType = 'movie' | 'series';

/** Um candidato do TMDB já reduzido ao que o casamento usa. */
export interface TmdbSearchHit {
  tmdbId: number;
  /** Título localizado (consulta em pt-BR): `title` no filme, `name` na série. */
  title: string;
  /** Título original na língua de origem, conforme o TMDB. */
  originalTitle: string;
  /** Ano do lançamento/estreia (4 dígitos); `null` quando a data não veio. */
  year: number | null;
}

export interface TmdbSearchResult {
  /** `false` = falha/sem chave: indisponível, que é DIFERENTE de "não existe". */
  ok: boolean;
  hits: TmdbSearchHit[];
}

export interface ExternalImdbResult {
  ok: boolean;
  /** IMDb id (`tt…`) da obra; `null` quando a obra não tem (com `ok:true`). */
  imdb: string | null;
}

/** Tolerância de ano do casamento: o site publica ano de lançamento/BR. */
const YEAR_TOLERANCE = 1;

// Mesma régua do tmdb.ts: degradação não pode congelar pelo TTL longo.
function retryTtl(): number {
  return Math.max(1, Math.min(config.tmdb.cacheTtl, config.tmdb.transientMissTtl));
}

async function fetchJson(url: URL): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.tmdb.timeout),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    log.warn('[tmdb-search]', err.message);
    return { ok: false, status: 0, data: null };
  }
}

/** Chave do cache compartilhada por grafia: acento/caixa/pontuação não
 * mudam a busca (mesma normalização do filtro de título do addon). */
function searchCacheKey(type: SearchWorkType, title: string): string {
  const norm = normalizeTitle(title);
  return `tmdb:search:${type}:${norm || 'vazio'}`;
}

/** Resultado cru da API → candidato; item sem id ou sem NENHUM título sai. */
function toHit(item: any): TmdbSearchHit | null {
  const id = Number(item?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const localized = typeof item?.title === 'string' ? item.title
    : typeof item?.name === 'string' ? item.name : '';
  const original = typeof item?.original_title === 'string' ? item.original_title
    : typeof item?.original_name === 'string' ? item.original_name : '';
  if (!localized.trim() && !original.trim()) return null;
  const yearNum = Number(String(item?.release_date || item?.first_air_date || '').slice(0, 4));
  return {
    tmdbId: id,
    title: localized.trim(),
    originalTitle: original.trim(),
    // Ano absurdo (data vazia/corrompida) é "sem ano": o filtro decide.
    year: yearNum >= 1900 && yearNum <= 2100 ? yearNum : null,
  };
}

/** Filtro LOCAL de ano ±1. Aqui, página SEM ano deixa tudo passar — mas a
 * camada de identificação (`identifyWork`) recusa página sem ano ANTES de
 * buscar (`pagina-sem-ano`), então este ramo só é alcançado por quem chama a
 * utilidade diretamente. Candidato sem ano com ano conhecido na página é
 * DESCARTADO: não dá para conferir. */
export function yearWithinTolerance(hitYear: number | null, pageYear: number | null | undefined): boolean {
  const page = Number(pageYear);
  if (!Number.isFinite(page) || page <= 0) return true;
  if (hitYear == null) return false;
  return Math.abs(hitYear - page) <= YEAR_TOLERANCE;
}

const searchInFlight = new Map<string, Promise<TmdbSearchResult>>();

function searchPath(type: SearchWorkType): string {
  return type === 'series' ? 'tv' : 'movie';
}

async function fetchSearch(type: SearchWorkType, title: string): Promise<TmdbSearchResult> {
  const url = new URL(`${API}/search/${searchPath(type)}`);
  url.searchParams.set('api_key', config.tmdb.apiKey);
  url.searchParams.set('query', title);
  // pt-BR: o candidato precisa carregar o título LOCALIZADO para casar com a
  // página BR (o original vem junto no resultado e casa o caminho EN/original).
  url.searchParams.set('language', 'pt-BR');
  url.searchParams.set('include_adult', 'false');
  const raw = await fetchJson(url);
  if (!raw.ok) return { ok: false, hits: [] };
  const hits = (Array.isArray(raw.data?.results) ? raw.data.results : [])
    .map(toHit)
    .filter((hit: TmdbSearchHit | null): hit is TmdbSearchHit => hit !== null);
  return { ok: true, hits };
}

/**
 * Busca a obra por título (opcionalmente discriminada pelo ano da página).
 * Uma consulta de rede por título (cacheada e coalescida — a fila do motor
 * vai reprocessar grafias repetidas); o filtro de ano ±1 é aplicado DEPOIS do
 * cache, então entradas compartilhadas entre chamadas com anos diferentes
 * continuam corretas. Falha devolve `ok:false` — chamar de "sem resultado"
 * condenaria obra identificável por um blip de rede.
 *
 * Background-only: sem deadline, ver o contrato no cabeçalho do módulo.
 */
async function searchByTitle(
  type: SearchWorkType,
  title: string,
  year?: number | null,
): Promise<TmdbSearchResult> {
  if (!config.tmdb.apiKey || !String(title || '').trim()) {
    return { ok: false, hits: [] };
  }
  const key = searchCacheKey(type, title);
  const cached = cache.get(key);
  if (cached) {
    metrics.count(cached.ok ? 'meta.tmdbsearch.hit.served' : 'meta.tmdbsearch.fail.served');
    const base: TmdbSearchResult = { ok: Boolean(cached.ok), hits: Array.isArray(cached.hits) ? cached.hits : [] };
    return { ...base, hits: base.hits.filter((hit) => yearWithinTolerance(hit.year, year)) };
  }
  const pending = searchInFlight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<TmdbSearchResult> => {
    const result = await fetchSearch(type, title);
    if (result.ok) {
      // Busca vazia autoritativa usa o MISS do TMDB (`missTtl` / TMDB_MISS_TTL,
      // default 300s) — o MESMO knob do cache negativo do módulo, sem knob
      // próprio: o TMDB ganha obras o tempo todo e a página raspada é
      // permanente, então o vazio não pode congelar pelo TTL de 7 dias; o
      // default curto é o que limita a martelada do backlog do motor (uma
      // releitura por título a cada 5 min, não por URL processada). `0`
      // desliga de verdade aqui, como no resto do cache: ttl<=0 não é gravado.
      cache.set(key, result, result.hits.length ? config.tmdb.cacheTtl : config.tmdb.missTtl);
      metrics.count('meta.tmdbsearch.fetched');
    } else {
      cache.set(key, result, retryTtl());
    }
    return {
      ...result,
      hits: result.hits.filter((hit) => yearWithinTolerance(hit.year, year)),
    };
  })().finally(() => {
    searchInFlight.delete(key);
  });

  searchInFlight.set(key, promise);
  return promise;
}

// O id numérico do TMDB colide entre movie e tv (são espaços distintos), então
// o tipo vai na chave — cache de external_ids nunca pode cruzar tipos.
const extInFlight = new Map<string, Promise<ExternalImdbResult>>();

async function fetchExternalImdb(tmdbId: number, type: SearchWorkType): Promise<ExternalImdbResult> {
  const url = new URL(`${API}/${searchPath(type)}/${tmdbId}/external_ids`);
  url.searchParams.set('api_key', config.tmdb.apiKey);
  const raw = await fetchJson(url);
  if (!raw.ok) return { ok: false, imdb: null };
  // Só o formato canônico serve: a fila inteira do motor anda sobre `tt…`.
  const imdb = typeof raw.data?.imdb_id === 'string' && /^tt\d{5,}$/.test(raw.data.imdb_id)
    ? raw.data.imdb_id
    : null;
  return { ok: true, imdb };
}

/**
 * IMDb id da obra pelo id numérico do TMDB. `ok:false` é falha (o chamador
 * pode retentar); `ok:true, imdb:null` é a obra SEM IMDb no TMDB (estado
 * próprio — vale para o painel, não para retry infinito). Cacheada nos dois
 * sentidos: o id numérico não muda e a obra não ganha IMDb que já tinha.
 */
async function externalImdbId(tmdbId: number, type: SearchWorkType): Promise<ExternalImdbResult> {
  if (!config.tmdb.apiKey || !Number.isFinite(tmdbId) || tmdbId <= 0) {
    return { ok: false, imdb: null };
  }
  const key = `tmdb:ext:${type}:${tmdbId}`;
  const cached = cache.get(key);
  if (cached) {
    return { ok: Boolean(cached.ok), imdb: typeof cached.imdb === 'string' ? cached.imdb : null };
  }
  const pending = extInFlight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<ExternalImdbResult> => {
    const result = await fetchExternalImdb(tmdbId, type);
    cache.set(key, result, result.ok ? config.tmdb.cacheTtl : retryTtl());
    return result;
  })().finally(() => {
    extInFlight.delete(key);
  });

  extInFlight.set(key, promise);
  return promise;
}

export { searchByTitle, externalImdbId };
