import { BLUDV_DEFAULT_URL, num } from './helpers.js';

// Fábricas (não objetos prontos): módulo ESM é cacheado, e cada re-avaliação
// do compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Fontes de busca paralelas ao Jackett e metadados (título pt-BR / catálogo).
export const prowlarr = () => ({
  url: (process.env.PROWLARR_URL || 'http://127.0.0.1:9696').replace(/\/$/, ''),
  apiKey: process.env.PROWLARR_API_KEY || '',
});

// Pool GLOBAL Torrentio (Fase 1). Consulta a API pública do serviço — sem
// config nem credencial — para trazer releases já indexadas no acervo global.
// `url` é só o host canônico; a fonte pode ser desligada por instalação via
// o toggle na página. Nenhuma chave do usuário sai do processo.
export const torrentio = () => ({
  enabled: String(process.env.TORRENTIO_ENABLED || 'true') === 'true',
  url: (process.env.TORRENTIO_URL || 'https://torrentio.strem.fun').replace(/\/$/, ''),
  timeout: Math.max(1, num(process.env.TORRENTIO_TIMEOUT_MS, 1500)),
  breakerFailures: Math.max(1, Math.trunc(num(process.env.TORRENTIO_BREAKER_FAILURES, 3))),
  breakerCooldown: Math.max(0, num(process.env.TORRENTIO_BREAKER_COOLDOWN_MS, 5 * 60_000)),
});

export const tmdb = () => ({
  apiKey: process.env.TMDB_API_KEY || '',
  timeout: num(process.env.TMDB_TIMEOUT_MS, 5000),
  cacheTtl: num(process.env.TMDB_CACHE_TTL, 604800), // 7 dias
  // TTL do cache NEGATIVO (id que devolveu nada/erro). Sem ele, título
  // desconhecido bate na API a cada busca; TTL curto porque falha pode ser
  // transitória. 0 desliga o cache de miss.
  missTtl: num(process.env.TMDB_MISS_TTL, 300),
  // TTL do cache NEGATIVO para FALHA TRANSITÓRIA (rede/timeout/429/5xx),
  // separado do miss autoritativo: um `fetch failed` isolado não pode congelar
  // o título pt-BR por TMDB_MISS_TTL inteiro — nessa janela os indexadores BR
  // são consultados em inglês e devolvem 0. 0 desliga o transitório (a busca
  // seguinte consulta novamente a API).
  transientMissTtl: num(process.env.TMDB_TRANSIENT_MISS_TTL, 30),
});

export const cinemeta = () => ({
  // O Cinemeta roda antes da coleta. Deixá-lo esperar o teto inteiro do
  // cliente consumiria o deadline sem sequer consultar os indexers; após
  // este prazo a busca degrada para o título do TMDB ou para o IMDb id.
  timeout: num(process.env.CINEMETA_TIMEOUT_MS, 2500),
  // Cache negativo, mesmo racional do TMDB: id inexistente não pode custar
  // 2,5s de rede em toda busca. 0 desliga.
  missTtl: num(process.env.CINEMETA_MISS_TTL, 300),
  // Cache negativo TRANSITÓRIO — mesma regra do TMDB_TRANSIENT_MISS_TTL: falha
  // de rede/429/5xx não é "id desconhecido" e não pode congelar a meta (e, com
  // ela, o ano) por minutos.
  transientMissTtl: num(process.env.CINEMETA_TRANSIENT_MISS_TTL, 30),
});

export const bludv = () => ({
  enabled: String(process.env.BLUDV_ENABLED || 'false') === 'true',
  // Mesmo default do resolvedor. O alias antigo (bludv.net) divergia do
  // primário: sem BLUDV_URL no .env, o scraper direto e o resolvedor
  // embutido buscavam em sites diferentes.
  baseUrl: (process.env.BLUDV_URL || BLUDV_DEFAULT_URL).replace(/\/$/, ''),
  dubbedOnly: String(process.env.BLUDV_DUBBED_ONLY || 'true') === 'true',
  maxPosts: num(process.env.BLUDV_MAX_POSTS, 3),
  maxLinksPerPost: num(process.env.BLUDV_MAX_LINKS, 12),
  concurrency: num(process.env.BLUDV_CONCURRENCY, 6),
  timeout: num(process.env.BLUDV_TIMEOUT_MS, 8000),
});
