import { DEFAULT_CRAWL_DB_PATH, list, num } from './helpers.js';

// Raspagem total dos sites BR (plano "Raspagem total", piloto: Vaca). Estado
// da fila em SQLite próprio (`data/crawl.db`, ver `utils/crawl-store.ts`).
// DESLIGADA por padrão: ligar é decisão do operador, site a site, depois das
// fases de validação (adaptador → identificação → motor em simulação → painel
// → gravação de verdade). O painel pode sobrepor `enabled` ao vivo
// (`cfg:v1:crawler`) e essa sobreposição PERSISTE como decisão explícita do
// operador: um `crawl-config-set {enabled:true}` religa a raspagem após o
// restart até um `crawl-config-reset`, que volta ao valor daqui. Os knobs já
// definem o contrato no `.env` antes do código que os consome existir (mesmo
// padrão do `magnetBank.fallback*`).
// Fábrica (não objeto pronto): a re-avaliação do compositor precisa reler o
// process.env.
export const crawl = () => ({
  // Kill-switch geral: false = nenhuma raspagem roda (o motor nem inicia).
  enabled: String(process.env.CRAWL_ENABLED || 'false') === 'true',
  // Modo simulação: raspa e conta, mas NÃO grava nada (nem banco vivo, nem
  // índice). Default true de propósito: a gravação de verdade é decisão
  // explícita, tirada só depois da noite inteira de carga em Docker local.
  dryRun: String(process.env.CRAWL_DRY_RUN || 'true') === 'true',
  // Sites ligados, por id de card do Jackett (o piloto é o Vaca).
  sites: list(process.env.CRAWL_SITES || 'vacatorrent'),
  // SQLite próprio do estado da raspagem. Fora do cache.db: 10 mil+ URLs por
  // site não cabem na cota do L1/L2 (folga real do teto global: ~779).
  dbPath: process.env.CRAWL_DB_PATH || DEFAULT_CRAWL_DB_PATH,
  // Pausa entre páginas: o motor faz UMA requisição por vez, sem FlareSolverr.
  delayMs: Math.max(0, num(process.env.CRAWL_DELAY_MS, 1000)),
  // Teto de REQUISIÇÕES por hora (educação com o site; bloqueio de IP custa
  // dias). Fase 7: o custo é REAL por página (cards e saltos de protetor
  // contam) — a chave mantém o nome legado por compatibilidade.
  maxPerHour: Math.max(1, Math.trunc(num(process.env.CRAWL_MAX_PER_HOUR, 1500))),
  // Só rascar com o app ocioso — a MESMA janela deslizante do colhedor
  // (`activity.recentUserTraffic`); tráfego de usuário preempta a raspagem.
  idleWindowMs: Math.max(0, num(process.env.CRAWL_IDLE_WINDOW_MS, 10 * 60_000)),
  // Tentativas por URL antes de desistir; "Reprocessar erros" volta do zero.
  maxTries: Math.max(1, Math.trunc(num(process.env.CRAWL_MAX_TRIES, 3))),
  // Erros seguidos (403/429/5xx) que pausam o site automaticamente.
  errorPauseStreak: Math.max(1, Math.trunc(num(process.env.CRAWL_ERROR_PAUSE_STREAK, 5))),
  // Canário de layout: N páginas seguidas que antes tinham torrent e agora não
  // têm botão nenhum pausam o site com "layout mudou?" em vez de marcar tudo
  // como no-torrent (o sintoma do site que trocou de DOM, não de acervo).
  layoutCanary: Math.max(1, Math.trunc(num(process.env.CRAWL_LAYOUT_CANARY, 10))),
  // Ciclo incremental (min): relê só o sitemap e reprocessa URL nova ou com
  // lastmod novo (o upsert idempotente do store é quem barateia o ciclo).
  incrementalIntervalMin: Math.max(1, Math.trunc(num(process.env.CRAWL_INCREMENTAL_INTERVAL_MIN, 60))),
  // Fase 7 (séries): descoberta de tv_show-sitemap. DESLIGADA por padrão —
  // séries multiplicam requisições (página → season-internal → cards →
  // protetores); ligar é decisão do operador, como a raspagem em si.
  seriesEnabled: String(process.env.CRAWL_SERIES_ENABLED || 'false') === 'true',
  // Teto de cards de temporada visitados por página de série.
  seriesMaxCards: Math.max(1, Math.trunc(num(process.env.CRAWL_SERIES_MAX_CARDS, 10))),
  // Teto de botões de download seguidos (cadeia do protetor) por página.
  seriesMaxButtons: Math.max(1, Math.trunc(num(process.env.CRAWL_SERIES_MAX_BUTTONS, 40))),
});
