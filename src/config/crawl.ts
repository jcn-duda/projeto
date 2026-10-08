import { DEFAULT_CRAWL_DB_PATH, list, num } from './helpers.js';

/** `CRAWL_SERIES_MAX_BUTTONS` com o default do teto de botões. Reusado no
 * default derivado do passo de LINHA para não duplicar o `40` (a fábrica
 * `crawl()` re-executa e esta função relê o `process.env` a cada chamada). */
const seriesMaxButtonsEnv = (): number =>
  Math.max(1, Math.trunc(num(process.env.CRAWL_SERIES_MAX_BUTTONS, 40)));

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
  // Fase 7 (séries): descoberta de série. LIGADA por padrão: a raspagem tem
  // que cobrir filme E série, e desligada ela cobre só filme — silêncio que
  // não se distingue de "site sem série". O custo é o que a chave existe para
  // controlar: série multiplica requisições (página → cards de temporada →
  // botões → protetores), e quem não quiser pagar isso põe `CRAWL_SERIES_ENABLED=false`
  // explicitamente (o painel também desliga ao vivo, mas SÓ no global: o
  // override por site é um subset fechado de chaves em `SITE_OVERRIDE_KEYS`
  // (`crawler-live-site.ts`), e `seriesEnabled` não está nele — pedir série por
  // site é decisão de produto, não portada aqui).
  seriesEnabled: String(process.env.CRAWL_SERIES_ENABLED || 'true') === 'true',
  // Teto de cards de temporada visitados por página de série.
  seriesMaxCards: Math.max(1, Math.trunc(num(process.env.CRAWL_SERIES_MAX_CARDS, 10))),
  // Teto de botões de download seguidos (cadeia do protetor) por página.
  seriesMaxButtons: seriesMaxButtonsEnv(),
  // Fase 8 (multi-site): gate da SONDA. Com `true`, um site só entra na rotação
  // do motor depois do veredito GO da amostra de 40 páginas gravado em
  // `crawl_state['probe:verdict']` — site novo sem medição não raspa nada. Default
  // `false` para não desligar o site's piloto já medido em produção: ligar é
  // decisão do operador, e o gate é por site, não global.
  requireProbe: String(process.env.CRAWL_REQUIRE_PROBE || 'false') === 'true',
  // Fase 8: custo ESTIMADO da rodada de descoberta, cobrado no teto por hora
  // enquanto o adaptador não declara o custo real (`CrawlDiscovery.requestCost`).
  // 3 = sitemap de filme + de série, na ordem de grandeza do Vaca. É estimativa
  // declarada (não medição) — ajuste depois de instrumentar os adaptadores.
  discoveryCost: Math.max(1, Math.trunc(num(process.env.CRAWL_DISCOVERY_COST, 3))),
  // Sites trabalhando AO MESMO TEMPO (`crawl-dispatch.ts`). Cada site mantém o
  // próprio ritmo; o paralelo só tira a espera pelo vizinho. 1 volta ao serial.
  maxParallel: Math.max(1, Math.min(8, Math.trunc(num(process.env.CRAWL_MAX_PARALLEL, 3)))),
  // Prazo DURO de UM passo do site (backstop do deadline de rede). A rede já
  // tem teto próprio que cobre fetch+corpo (`fetchJsonWithin`); este limite
  // existe para um await NÃO-abortável (throttle/coalescing) não segurar a vaga
  // do site para sempre. Default DERIVADO do site mais caro (série do Mico):
  // `CRAWL_SERIES_MAX_BUTTONS` episódios × (`MICO_TIMEOUT_MS` + `MICO_CRAWL_MIN_GAP_MS`)
  // + margem de metadados = 40×16s + 60s ≈ 11,7 min. A faixa útil é 10–15 min:
  // não mate uma série boa (4 min derrubaria o passe inteiro). Ao vencer, a
  // geração do passo é invalidada (escritas tardias descartadas) e a linha presa
  // vira `error step-timeout` com o progresso (`doneCards`) preservado.
  stepDeadlineMs: Math.max(30_000, Math.trunc(num(
    process.env.CRAWL_STEP_DEADLINE_MS,
    seriesMaxButtonsEnv()
      * (num(process.env.MICO_TIMEOUT_MS, 15_000) + num(process.env.MICO_CRAWL_MIN_GAP_MS, 1_000))
      + 60_000,
  ))),
  // Prazo DURO da fase de DESCOBERTA (separado do passo de linha). A descoberta
  // completa do Mico lê DOIS catálogos em sequência (filme + série), ~50 min
  // CADA na VPS (`mico-shared.ts`), podendo passar de 100 min: o orçamento de
  // LINHA (~11,7 min) NÃO pode cancelar uma varredura completa boa. Default 2 h
  // (≈100 min + margem) e configurável; NÃO é um "cap de 30 min". Ao vencer, a
  // cerca invalida o passo: o adaptador para o laço de páginas e não grava o
  // marker/cursor, e o vigia fecha a rodada e rearma `nextDiscoverAt=0` (retry).
  discoveryDeadlineMs: Math.max(60_000, Math.trunc(num(process.env.CRAWL_DISCOVERY_DEADLINE_MS, 2 * 3600_000))),
  // Sites que passam pelo FlareSolverr (um pedido por vez, o MESMO da busca):
  // nunca correm dois juntos.
  flareSites: list(process.env.CRAWL_FLARE_SITES || 'redetorrent-cardigann,bludv-cardigann,vacatorrent'),
  // Colhedor pula o card do site que o raspador já cobre (`crawl-coverage.ts`):
  // carga inicial concluída, fora de simulação e fila até este tamanho.
  coverHarvest: String(process.env.CRAWL_COVER_HARVEST || 'true') === 'true',
  coverMaxPending: Math.max(0, Math.trunc(num(process.env.CRAWL_COVER_MAX_PENDING, 50))),
  // Fase 8: teto de PÁGINAS por rodada de descoberta POR LISTAGEM (o caminho
  // sem sitemap — hoje só o HDRTorrent). A primeira rodada é `complete: false`
  // e continua na seguinte: o acervo do HDRTorrent tem 2123 páginas (medido por
  // bisseção em 2026-09-29), e uma varredura que não as lê todas não pode
  // afirmar que cobriu. Dimensionado contra o teto por hora acima: 20 páginas
  // × 20 cards = 400 URLs por rodada, e o acervo inteiro leva ~5 rodadas.
  listingMaxPagesPerRound: Math.max(1, Math.trunc(num(process.env.CRAWL_LISTING_MAX_PAGES_PER_ROUND, 20))),
});
