import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';
import { collectionRoot } from './multiwork-pack.js';
import type { MultiWorkCollection } from '../../types/domain.js';

const API = 'https://api.themoviedb.org/3';

interface EnglishTitleResult {
  /** Título canônico inglês; `null` quando a API respondeu sem ele. */
  title: string | null;
  /** `true` = a API respondeu (ausência é autoritativa); `false` = falha/prazo. */
  ok: boolean;
}

/**
 * Título canônico inglês da obra por uma SEGUNDA consulta `/find` em en-US,
 * dentro do MESMO prazo (`deadlineAt`) da consulta pt-BR. O `/find` em pt-BR
 * devolve o título localizado e o ORIGINAL; quando o original não é inglês
 * (Django Kill: "Se sei vivo spara", italiano), o nome que os trackers globais
 * publicam só existe na variante en-US. Sem ele, um timeout do Cinemeta prendia
 * a busca ao título estrangeiro e perdia os releases em inglês (recall medido
 * 12 vs 43).
 *
 * Extrai SÓ o título canônico de `movie_results`/`tv_results` — o `title` do
 * filme ou `name` da série já localizados em en-US, NUNCA `original_*` (que
 * repetiria o idioma de origem) nem as `alternative_titles`, cujas grafias
 * arbitrárias ("Kill", "Farah") abririam matching genérico.
 *
 * O retorno distingue ausência autoritativa (`ok:true`, `title:null`) de
 * falha/timeout (`ok:false`): só a primeira pode ser cacheada pelo TTL longo —
 * degradação precisa de releitura curta. Fail-open: falha nunca derruba a
 * busca, que segue com pt/original.
 */
async function fetchEnglishTitle(imdbId: string, deadlineAt: number): Promise<EnglishTitleResult> {
  const remaining = deadlineAt - Date.now();
  if (!(remaining > 0)) return { title: null, ok: false };
  try {
    const url = new URL(`${API}/find/${imdbId}`);
    url.searchParams.set('api_key', config.tmdb.apiKey);
    url.searchParams.set('external_source', 'imdb_id');
    url.searchParams.set('language', 'en-US');
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, remaining)),
    });
    if (!res.ok) return { title: null, ok: false };
    const data = await res.json();
    const movie = (data?.movie_results || [])[0];
    const item = movie || (data?.tv_results || [])[0];
    // `title` (filme) / `name` (série) é a grafia en-US — o canônico que os
    // trackers globais publicam. `original_*` seria o idioma de origem (ex.:
    // turco "Adım Farah"), justamente o que não queremos.
    const localized = typeof item?.title === 'string' ? item.title
      : typeof item?.name === 'string' ? item.name : '';
    return { title: localized.trim() || null, ok: true };
  } catch (err) {
    log.warn('[tmdb]', err.message);
    return { title: null, ok: false };
  }
}

// TTL curto para degradação (falha/timeout na busca do título en-US): a
// ausência do canônico inglês NÃO pode congelar pelo TMDB_CACHE_TTL inteiro (7
// dias). O piso de 1s cobre o operador que zerou o TTL transitório — sem ele a
// entrada nem seria gravada e a API voltaria a ser martelada a cada busca.
function enRetryTtl(): number {
  return Math.max(1, Math.min(config.tmdb.cacheTtl, config.tmdb.transientMissTtl));
}

// Requisições concorrentes para o mesmo id compartilham a mesma promise —
// episódios da mesma série disparam várias buscas em paralelo e cada uma
// pagava a chamada ao TMDB.
const inFlight = new Map();

function setMiss(key: string, ttlSeconds?: number) {
  // 0 desliga o cache negativo (operador pode querer sempre perguntar de novo);
  // o TTL padrão é o do miss autoritativo, o transitório passa o próprio.
  const ttl = ttlSeconds ?? config.tmdb.missTtl;
  if (ttl > 0) cache.set(key, { miss: true }, ttl);
}

// Falha TRANSITÓRIA não é "título desconhecido": status 429/5xx, timeout de
// rede e `fetch failed` voltam sozinhos em segundos, enquanto um miss
// autoritativo (200 sem resultado, 404) é decisão estável da API. Confundi-los
// congelou o título pt-BR por TMDB_MISS_TTL inteiro após UM blip — a janela em
// que os indexadores BR eram consultados em inglês e devolviam 0.
function isTransientFailure(status: number) {
  return !status || status === 429 || status >= 500;
}

/**
 * Título pt-BR a partir do IMDb id. É o que destrava os sites BR: eles indexam
 * por "Coringa", não "Joker" — sem isso a busca volta vazia.
 * Retorna { pt, original, en } — o original serve de fallback quando os idiomas
 * coincidem ou quando o site usa o nome de release; o `en` é o título canônico
 * inglês (segunda consulta `/find` en-US) que mantém o recall global quando o
 * Cinemeta não responde.
 *
 * Id sem resultado entra em cache NEGATIVO: sem isso, título que o TMDB não
 * conhece pagava os 5s de timeout em toda busca. Miss expira sozinho, então
 * falha transitória não condena o id para sempre.
 */
async function getTitles(imdbId: string) {
  if (!config.tmdb.apiKey || !imdbId) return null;

  const key = `tmdb:${imdbId}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit.miss) {
      metrics.count('meta.tmdb.miss.served');
      return null;
    }
    // Entrada anterior ao campo `en` — ou ainda carregando o `aliases` removido
    // — é tratada como MISS: o título canônico inglês é justamente o que devolve
    // a busca quando o Cinemeta cai, e o TTL de 7 dias deixaria o conserto
    // parado em todo id já cacheado; o campo arbitrário não pode sobreviver no
    // cache. Custa UMA releitura por id (não é bump de namespace: o formato
    // gravado é o mesmo, aditivo). Se a releitura falhar, a entrada antiga é
    // regravada por allowlist com TTL curto — pt/original sobrevivem e a API
    // não é martelada (ver catch).
    if (hit.en !== undefined && hit.aliases === undefined) return hit;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const deadlineAt = Date.now() + config.tmdb.timeout;
    const url = new URL(`${API}/find/${imdbId}`);
    url.searchParams.set('api_key', config.tmdb.apiKey);
    url.searchParams.set('external_source', 'imdb_id');
    url.searchParams.set('language', 'pt-BR');

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(config.tmdb.timeout),
      });
      if (!res.ok) {
        // Carrega o status no erro para o catch distinguir 404 (autoritativo)
        // de 429/5xx (transitório) — o Coringa da busca BR depende disso.
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const movie = (data.movie_results || [])[0];
      const item = movie || (data.tv_results || [])[0];
      if (!item) {
        setMiss(key);
        return null;
      }

      const original = item.original_title || item.original_name || null;
      const originalLanguage = item.original_language || null;
      // Original não-inglês não carrega o nome que o tracker global publica:
      // segunda consulta `/find` em en-US no MESMO prazo (não estende o
      // orçamento). Não passamos o `id` do item: o `/find` responde a mesma
      // obra pelo imdb id e não depende de tipo (movie/tv) nem de id numérico.
      const enResult = originalLanguage && originalLanguage !== 'en'
        ? await fetchEnglishTitle(imdbId, deadlineAt)
        : null;
      const titles = {
        pt: item.title || item.name || null,
        original,
        // Em obra de original inglês o próprio `original` já é o canônico EN.
        en: originalLanguage === 'en' ? original : enResult?.title ?? null,
        year: (item.release_date || item.first_air_date || '').slice(0, 4) || null,
      };
      // Título não muda e vale o TTL longo SÓ quando a consulta en-US respondeu
      // de verdade. Falha/timeout na busca do canônico é degradação: TTL curto
      // para a próxima busca tentar de novo em vez de congelar por 7 dias.
      if (enResult && !enResult.ok) {
        cache.set(key, titles, enRetryTtl());
      } else {
        cache.set(key, titles, config.tmdb.cacheTtl);
      }
      return titles;
    } catch (err) {
      log.warn('[tmdb]', err.message);
      // Releitura de entrada antiga que falhou: preserva pt/original e regrava
      // com backoff curto. Reconstrói o objeto por allowlist para não persistir
      // campo legado do cache (`aliases`); `en:null` evita a releitura imediata
      // a cada busca.
      if (hit && !hit.miss) {
        const healed = { pt: hit.pt ?? null, original: hit.original ?? null, en: hit.en ?? null, year: hit.year ?? null };
        cache.set(key, healed, enRetryTtl());
        return healed;
      }
      // 404 e 200-sem-resultado são "não conhece" — condenam pelo missTtl
      // cheio. Rede, timeout, 429 e 5xx são transitórios: o id volta a ser
      // perguntado em TMDB_TRANSIENT_MISS_TTL, para um blip não derrubar a
      // cobertura pt-BR (que depende deste nome para os indexadores BR).
      const status = Number(err.status);
      setMiss(key, isTransientFailure(status) ? config.tmdb.transientMissTtl : undefined);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

const COLLECTION_CACHE_PREFIX = 'tmdbc:';

interface JsonResult {
  ok: boolean;
  status: number;
  data: any;
}

async function fetchJson(url: URL, deadlineAt: number): Promise<JsonResult> {
  const remaining = deadlineAt - Date.now();
  if (!(remaining > 0)) return { ok: false, status: 0, data: null };
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, remaining)),
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch (err) {
    log.warn('[tmdb]', err.message);
    return { ok: false, status: 0, data: null };
  }
}

// Distingue resposta AUTORITATIVA (mesmo "não tem coleção", cacheável pelo TTL
// longo) de falha/prazo (TTL curto). Sem isso, um blip de rede congelaria a
// ausência de coleção por 7 dias.
type CollectionRead = { info: MultiWorkCollection | null; ok: boolean };

/**
 * Lê a coleção `belongs_to_collection` do filme e as partes dela. Três saltos
 * sequenciais no MESMO `deadlineAt` (find → movie → collection); cada fetch só
 * usa o que sobrou. Se o `/find` já trouxer `belongs_to_collection` (TMDB
 * detalhado), o salto do `/movie` é poupado. Rede nunca derruba a busca:
 * falha devolve `ok:false` e o chamador segue sem franquia.
 */
async function readCollection(imdbId: string, deadlineAt: number): Promise<CollectionRead> {
  const findUrl = new URL(`${API}/find/${imdbId}`);
  findUrl.searchParams.set('api_key', config.tmdb.apiKey);
  findUrl.searchParams.set('external_source', 'imdb_id');
  findUrl.searchParams.set('language', 'pt-BR');
  const found = await fetchJson(findUrl, deadlineAt);
  if (!found.ok) return { info: null, ok: false };
  const movie = (found.data?.movie_results || [])[0];
  // Série não tem `belongs_to_collection` e a feature é de filme; ausência
  // autoritativa.
  if (!movie?.id) return { info: null, ok: true };

  let collection = movie.belongs_to_collection;
  if (!collection?.id) {
    const detailUrl = new URL(`${API}/movie/${movie.id}`);
    detailUrl.searchParams.set('api_key', config.tmdb.apiKey);
    detailUrl.searchParams.set('language', 'pt-BR');
    const detail = await fetchJson(detailUrl, deadlineAt);
    if (!detail.ok) return { info: null, ok: false };
    collection = detail.data?.belongs_to_collection;
  }
  if (!collection?.id) return { info: null, ok: true };

  const collUrl = new URL(`${API}/collection/${collection.id}`);
  collUrl.searchParams.set('api_key', config.tmdb.apiKey);
  collUrl.searchParams.set('language', 'pt-BR');
  const coll = await fetchJson(collUrl, deadlineAt);
  if (!coll.ok) return { info: null, ok: false };

  const name = String(coll.data?.name || collection.name || '').trim();
  const years: number[] = [...new Set<number>(
    (coll.data?.parts || [])
      .map((part: any) => Number(String(part?.release_date || '').slice(0, 4)))
      .filter((year: number) => year > 1900),
  )];
  const root = collectionRoot(name);
  // "Coleção" de uma obra só (raiz sem evidência ou menos de 2 partes) não é
  // multiobra: admitir seria inventar franquia a partir de título solto.
  if (!root || years.length < 2) return { info: null, ok: true };
  return { info: { name, root, years }, ok: true };
}

const collectionInFlight = new Map<string, Promise<CollectionRead>>();

/**
 * Raiz da coleção multiobra do IMDb id, sob `deadlineAt`. Cacheada pelo TTL
 * longo quando a resposta é autoritativa (inclusive "não tem"), curta quando é
 * falha. Coalescing por id: episódios/buscas concorrentes da mesma obra
 * compartilham a chamada. Fail-open: sem chave, sem rede ou prazo estourado,
 * devolve `null` e a busca segue sem o degrau de franquia.
 */
async function getCollection(imdbId: string, deadlineAt: number): Promise<MultiWorkCollection | null> {
  if (!config.tmdb.apiKey || !imdbId) return null;
  const key = `${COLLECTION_CACHE_PREFIX}${imdbId}`;
  const hit = cache.get(key);
  if (hit) {
    if (hit.miss) return null;
    return (hit.info ?? null) as MultiWorkCollection | null;
  }
  const pending = collectionInFlight.get(key);
  if (pending) return (await pending).info;

  const promise = readCollection(imdbId, deadlineAt)
    .then((read) => {
      if (read.ok) cache.set(key, { info: read.info }, config.tmdb.cacheTtl);
      else cache.set(key, { miss: true }, enRetryTtl());
      return read;
    })
    .finally(() => {
      collectionInFlight.delete(key);
    });
  collectionInFlight.set(key, promise);
  return (await promise).info;
}

export { getTitles, getCollection };
