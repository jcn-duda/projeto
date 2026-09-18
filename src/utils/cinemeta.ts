import config from '../config.js';
import * as cache from './cache.js';
import * as metrics from './metrics.js';
import * as log from './logger.js';

// Requisições concorrentes para o mesmo id compartilham a mesma promise —
// o Stremio dispara buscas duplicadas (episódios da mesma série) e sem isso
// cada uma pagava a chamada ao Cinemeta.
const inFlight = new Map();

function setMiss(key: string, ttlSeconds?: number) {
  // 0 desliga o cache negativo (operador pode querer sempre perguntar de novo);
  // o TTL padrão é o do miss autoritativo, o transitório passa o próprio.
  const ttl = ttlSeconds ?? config.cinemeta.missTtl;
  if (ttl > 0) cache.set(key, { miss: true }, ttl);
}

// Falha TRANSITÓRIA (429/5xx, timeout, `fetch failed`) não é "id desconhecido"
// — mesma regra do TMDB: não pode congelar a meta (e o ano) por minutos.
function isTransientFailure(status: number) {
  return !status || status === 429 || status >= 500;
}

// Episódios por temporada, sem especiais (temporada 0): base da média de
// tamanho do episódio num pack de temporada. Série sem `videos` fica `{}`.
function episodesBySeason(videos: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(videos)) return out;
  for (const video of videos) {
    const season = Number((video as { season?: unknown })?.season);
    if (!Number.isInteger(season) || season <= 0) continue;
    out[String(season)] = (out[String(season)] || 0) + 1;
  }
  return out;
}

/**
 * Data real de exibição POR EPISÓDIO, chaveada `temporada:episodio` (`released`
 * com fallback em `firstAired`); vazio quando o Cinemeta não publica data.
 * A janela instantânea só tem o ANO da série em `meta`, e a estreia de uma
 * série antiga não representa o episódio novo — sem este mapa, um E05 recente
 * de série de 2020 escapava do teto curto.
 */
function episodeAiredDates(videos: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(videos)) return out;
  for (const video of videos) {
    const v = video as { season?: unknown; episode?: unknown; number?: unknown; released?: unknown; firstAired?: unknown };
    const season = Number(v?.season);
    const episode = Number(v?.episode ?? v?.number);
    // Mesmo corte do `episodesBySeason`: especiais (temporada 0) ficam fora.
    if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(episode)) continue;
    const released = typeof v.released === 'string' && v.released ? v.released : '';
    const firstAired = typeof v.firstAired === 'string' && v.firstAired ? v.firstAired : '';
    const date = released || firstAired;
    if (date) out[`${season}:${episode}`] = date;
  }
  return out;
}

/** Campo `episodeAired` só entra quando há data — o contrato antigo (meta de
 * série sem vídeos) continua idêntico ao que os deepEqual das suítes esperam. */
function airedField(videos: unknown): { episodeAired: Record<string, string> } | Record<string, never> {
  const aired = episodeAiredDates(videos);
  return Object.keys(aired).length > 0 ? { episodeAired: aired } : {};
}

/**
 * Marca INTERNA de formato da meta gravada. Entrada gravada pela versão
 * anterior (sem a marca) é reconsultada UMA vez: o deploy que passa a gravar
 * `released`/`firstAired`/`episodeAired` não pode servir por até 24h o
 * metadado velho SEM datas, senão a janela instantânea fica cega no primeiro
 * dia. A marca precisa SERIALIZAR no L2 (por isso é enumerável), mas é
 * removida antes de entregar a quem chama — o shape público e os `deepEqual`
 * das suítes continuam idênticos ao de antes.
 */
const META_SCHEMA = 2;
const META_SCHEMA_FIELD = '__metaV';

function withoutSchema<T>(meta: T): T {
  const value = meta as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || !(META_SCHEMA_FIELD in value)) return meta;
  const { [META_SCHEMA_FIELD]: _ignored, ...rest } = value;
  return rest as T;
}

/**
 * Resolve título/ano a partir do IMDb id via Cinemeta (API pública do ecossistema Stremio).
 *
 * Id sem meta (404 ou corpo sem `meta`) entra em cache NEGATIVO: sem isso,
 * título desconhecido pagava os 2,5s de timeout em toda busca. Falha
 * transitória se resolve sozinha quando o miss expira.
 */
async function getMeta(type: string, imdbId: string) {
  const key = `meta:${type}:${imdbId}`;
  const cached = cache.get(key);
  if (cached) {
    if (cached.miss) {
      metrics.count('meta.cinemeta.miss.served');
      return null;
    }
    // Formato corrente E (série) com a contagem de episódios: serve do cache.
    // Sem a marca é entrada antiga → uma releitura; sem `episodes` (série)
    // também, senão a estimativa de tamanho no pack não nasce.
    const current = cached[META_SCHEMA_FIELD] === META_SCHEMA;
    if (current && !(type === 'series' && cached.episodes === undefined)) return withoutSchema(cached);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    const kind = type === 'series' ? 'series' : 'movie';
    const url = `https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'stremio-adom/1.0' },
        signal: AbortSignal.timeout(config.cinemeta.timeout),
      });
      if (!res.ok) {
        // Carrega o status no erro: 404 é autoritativo (id desconhecido), 429/
        // 5xx é transitório — o catch decide o TTL do miss negativo.
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const meta = data?.meta
        ? {
            name: data.meta.name || data.meta.title,
            year: data.meta.year || (data.meta.releaseInfo || '').slice(0, 4),
            type: data.meta.type || kind,
            ...(kind === 'series' ? { episodes: episodesBySeason(data.meta.videos) } : {}),
            // Datas REAIS do payload (o Cinemeta publica as duas): a janela
            // instantânea do banco precisa delas para o teto de lançamento
            // recente — só o ANO deixava um lançamento de dezembro visto em
            // janeiro escapar do teto curto. Campo ausente não entra (a
            // heurística do ano continua valendo como sinal grosseiro).
            ...(typeof data.meta.released === 'string' && data.meta.released
              ? { released: data.meta.released } : {}),
            ...(typeof data.meta.firstAired === 'string' && data.meta.firstAired
              ? { firstAired: data.meta.firstAired } : {}),
            // Série: a data do EPISÓDIO (não a estreia da série), consumida
            // pelo `matchContext` para o teto de episódio recente.
            ...(kind === 'series' ? airedField(data.meta.videos) : {}),
          }
        : null;
      if (meta) cache.set(key, { ...meta, [META_SCHEMA_FIELD]: META_SCHEMA }, 86400);
      // Atualização de meta antiga sem resposta útil: fica a gravada, não um miss.
      else if (cached && !cached.miss) return withoutSchema(cached);
      else setMiss(key);
      return meta;
    } catch (err) {
      log.warn('[cinemeta]', err.message);
      // Falhou só a atualização da meta antiga (marca de formato/contagem):
      // a gravada continua valendo — trocá-la por um miss apagaria nome e ano
      // da busca por uma informação que é só de exibição.
      if (cached && !cached.miss) return withoutSchema(cached);
      // 404 (e o corpo sem `meta`) é "não conhece" — missTtl cheio. Rede,
      // timeout, 429 e 5xx são transitórios — CINEMETA_TRANSIENT_MISS_TTL.
      const status = Number(err.status);
      setMiss(key, isTransientFailure(status) ? config.cinemeta.transientMissTtl : undefined);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

export { getMeta };
