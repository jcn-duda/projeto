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
  // Só o PADRÃO da instalação: com false a fonte segue disponível (o toggle da
  // página liga por instalação), mas instalação nova nasce sem ela. Decisão do
  // operador (2026-09-24): lista padrão só com Jackett.
  defaultOn: String(process.env.TORRENTIO_DEFAULT || 'false') === 'true',
  url: (process.env.TORRENTIO_URL || 'https://torrentio.strem.fun').replace(/\/$/, ''),
  timeout: Math.max(1, num(process.env.TORRENTIO_TIMEOUT_MS, 1500)),
  breakerFailures: Math.max(1, Math.trunc(num(process.env.TORRENTIO_BREAKER_FAILURES, 3))),
  breakerCooldown: Math.max(0, num(process.env.TORRENTIO_BREAKER_COOLDOWN_MS, 5 * 60_000)),
});

// Addon público "Mico Leão Dublado V2": card próprio na /configure (id `mico`,
// fora do Jackett — consulta por IMDb) e, opcionalmente, fonte do colhedor.
// Matching dele é fraco (medido: 5 de 48 hashes úteis em 5 obras), então todo
// item passa pelo mesmo filtro de relevância das releases do Jackett.
export const mico = () => ({
  // Kill-switch da fonte inteira: sem ele o card some e nada consulta o Mico.
  enabled: String(process.env.MICO_ENABLED || 'true') !== 'false',
  // Instalação nova já nasce com o card marcado (entra no `ji` padrão).
  default: String(process.env.MICO_DEFAULT || 'false') === 'true',
  harvest: String(process.env.MICO_HARVEST || 'false') === 'true',
  url: (process.env.MICO_URL || 'https://mico-leao-dublado-apiv-2.vercel.app').replace(/\/$/, ''),
  timeout: Math.max(1, num(process.env.MICO_TIMEOUT_MS, 15000)),
  breakerFailures: Math.max(1, Math.trunc(num(process.env.MICO_BREAKER_FAILURES, 3))),
  breakerCooldown: Math.max(0, num(process.env.MICO_BREAKER_COOLDOWN_MS, 10 * 60_000)),
  // Raspador (crawl-sites/mico.ts, Fase 1). Intervalo MÍNIMO entre chamadas do
  // crawler ao Mico — throttle PRÓPRIO, independente do breaker da busca viva
  // (o erro do raspador não pode abrir o circuito da resposta).
  crawlMinGapMs: Math.max(0, num(process.env.MICO_CRAWL_MIN_GAP_MS, 1000)),
  // Período do balde de releitura (`bucketLastmod`): a obra é relida a cada N
  // dias, e ~1/N do catálogo "vira" por dia (espalhado pelo hash do IMDb).
  crawlRereadDays: Math.max(1, Math.trunc(num(process.env.MICO_CRAWL_REREAD_DAYS, 14))),
  // Séries (Fase 2): teto de TEMPORADAS mais recentes lidas por obra. Série
  // explode em requisições (1 chamada de stream POR EPISÓDIO), então o raspador
  // só percorre as N temporadas mais altas, da mais recente para trás, e só os
  // episódios JÁ EXIBIDOS (data no Cinemeta ≤ agora). O progresso retomável
  // (`SeriesWorkProgress`) fatia a obra em passes de `maxButtons` episódios.
  crawlSeriesMaxSeasons: Math.max(1, Math.trunc(num(process.env.MICO_CRAWL_SERIES_MAX_SEASONS, 2))),
  // Varredura do catálogo (`skip=N`): teto de páginas por rodada e por tipo (o
  // catálogo tem ~20 mil obras por tipo ≈ 450 páginas; sair pelo teto marca a
  // descoberta TRUNCADA), reconsultas de página vazia (a API devolve vazio
  // intermitente) e quantas vazias seguidas, já reconsultadas, valem como fim.
  crawlMaxPages: Math.max(1, Math.trunc(num(process.env.MICO_CRAWL_MAX_PAGES, 700))),
  crawlEmptyRetries: Math.max(0, Math.trunc(num(process.env.MICO_CRAWL_EMPTY_RETRIES, 2))),
  crawlEndAfterEmpties: Math.max(1, Math.trunc(num(process.env.MICO_CRAWL_END_AFTER_EMPTIES, 4))),
  // Varredura COMPLETA por tipo no máximo a cada N horas; entre elas, a rodada
  // é incremental (do topo, mais novos primeiro) e para depois de N páginas
  // seguidas só com obras já na fila. A completa (~50 min na VPS) é o que
  // reenfileira o balde de releitura, que vira por DIA — uma por dia basta.
  crawlFullSweepHours: Math.max(1, num(process.env.MICO_CRAWL_FULL_SWEEP_HOURS, 24)),
  crawlKnownPagesToStop: Math.max(1, Math.trunc(num(process.env.MICO_CRAWL_KNOWN_PAGES_TO_STOP, 2))),
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
