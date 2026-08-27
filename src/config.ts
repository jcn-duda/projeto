import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function num(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value: unknown) {
  if (!value || !String(value).trim()) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Default único do bludv. O resolvedor embutido e o scraper direto leem a
// MESMA BLUDV_URL; com dois defaults diferentes, quem não define a env fazia
// os dois buscarem em sites distintos. Trocar de domínio se faz aqui.
const BLUDV_DEFAULT_URL = 'https://bludvfilmes.xyz';
const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));
// config.ts roda em dist/src; subir dois níveis preserva data/cache.db tanto no
// build quanto no checkout TypeScript, sem depender do diretório de trabalho.
const DEFAULT_CACHE_DB_PATH = path.join(CONFIG_DIR, '..', '..', 'data', 'cache.db');

const config = {
  port: num(process.env.PORT, 7000),
  host: process.env.HOST || '0.0.0.0',
  addonName: process.env.ADDON_NAME || 'Adom Power-Movie',
  addonId: process.env.ADDON_ID || 'community.stremio.adom',
  version: '1.0.0',
  provider: (process.env.PROVIDER || 'demo').toLowerCase(),
  jackett: {
    url: (process.env.JACKETT_URL || 'http://127.0.0.1:9117').replace(/\/$/, ''),
    apiKey: process.env.JACKETT_API_KEY || '',
    // Credencial separada para a rota operacional que executa buscas reais.
    // Vazio desliga o endpoint; nunca reutilizamos nem expomos a API key.
    testToken: process.env.JACKETT_TEST_TOKEN || '',
    // Consultados em paralelo, um timeout por indexer. Vazio = agregado /all.
    indexers: list(process.env.JACKETT_INDEXERS),
    indexerTimeout: num(process.env.JACKETT_INDEXER_TIMEOUT_MS, 4000),
    catalogTtl: num(process.env.JACKETT_CATALOG_TTL, 900),
    // Quanto tempo a última medição real aparece na configuração. O status
    // vem de busca/teste já executado; abrir a página nunca sonda os sites.
    statusTtl: num(process.env.JACKETT_STATUS_TTL, 900),
    // Cardigann pode entregar o magnet apenas no endpoint Link. Resolvemos
    // sob demanda somente nos indexadores locais explicitamente permitidos.
    // Os quatro entregam Link em vez de magnet: fora desta lista, o resultado
    // é descartado por falta de infoHash. Com só dois aqui, bludv e
    // torrentdosfilmes perdiam ~2/3 do que achavam.
    resolveDownloadIndexers: list(
      process.env.JACKETT_RESOLVE_DOWNLOAD_INDEXERS ||
        'comandotorrents,nerdfilmes,bludv-cardigann,torrentdosfilmesv2',
    ),
    resolveConcurrency: num(process.env.JACKETT_RESOLVE_CONCURRENCY, 10),
    maxDownloadResolves: num(process.env.JACKETT_MAX_DOWNLOAD_RESOLVES, 20),
    downloadTimeout: num(process.env.JACKETT_DOWNLOAD_TIMEOUT_MS, 8000),
    // O Link do indexer é input externo; destinos locais são SSRF salvo quando
    // o operador explicitamente usa um resolvedor privado nesse caminho.
    allowPrivateDownloadIps: String(process.env.JACKETT_ALLOW_PRIVATE_DOWNLOAD_IPS || 'false') === 'true',
    ptBrIndexers: list(
      // redetorrent é definição stock do Jackett (sem resolver local): entrega
      // magnet/infoHash direto, mas a query precisa ir sem SxxEyy — o strip
      // acontece em queryIndexer para todos os desta lista.
      process.env.JACKETT_PT_BR_INDEXERS ||
        'bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,redetorrent,apachetorrent,hdrtorrent',
    ),
    // Buscadores WordPress stock que zeram com QUALQUER token extra: além do
    // SxxEyy, o ano do filme também sai ("Coringa 2019" → 0 no redetorrent,
    // "Coringa" → 34). Os resolvers locais ficam FORA desta lista: lá o ano
    // ajuda a relevância e o strip de SxxEyy já acontece no servidor deles.
    bareTitleIndexers: list(
      process.env.JACKETT_BARE_TITLE_INDEXERS || 'redetorrent,apachetorrent,hdrtorrent',
    ),
    // Varredura TARDIA com o título pt-BR nos indexers globais: roda depois da
    // resposta (fora do orçamento de coleta, que já estoura no caminho
    // crítico) e reescreve o cache quando traz novidade. Acha dublado
    // hospedado em tracker global titulado em português, que a query em
    // inglês não encontra. false desliga sem precisar de deploy.
    ptSweepGlobal: String(process.env.JACKETT_PT_SWEEP_GLOBAL || 'true') === 'true',
    // Orçamento TOTAL (busca + resolução de magnets) dos que raspam site e
    // seguem protetor de link. PODE passar do REPLY_DEADLINE_MS: a resposta não
    // espera por eles (collectRaw devolve o que chegou e o passe tardio
    // recacheia o lote completo). Abaixo de ~15s a busca FRIA não caberia — a
    // raspagem sozinha leva 5-6s e ainda faltam os saltos do protetor, e um
    // corte no meio disso descartava o indexer inteiro por falta de infoHash.
    // JACKETT_DOWNLOAD_TIMEOUT_MS é o teto por salto DENTRO deste.
    brIndexerTimeout: num(process.env.JACKETT_BR_INDEXER_TIMEOUT_MS, 20000),
    // Lentos porém úteis: medidos em 8-9s, perdiam o prazo dos globais.
    //
    // NÃO adicione aqui os que passam por FlareSolverr (1337x, kickasstorrents):
    // não é questão de orçamento. O desafio Cloudflare é re-resolvido a CADA
    // busca e foi medido em 13s (1337x), 20s (kickass.ws) e 24s (kickass.to) só
    // pra abrir a primeira página — depois disso o Jackett ainda tem que raspar
    // os resultados. Com 20s eles abortavam igual, só 16s mais tarde, gastando
    // Chromium à toa. Fora da lista de indexers é o lugar deles.
    slowIndexers: list(
      process.env.JACKETT_SLOW_INDEXERS || 'bludv-cardigann,redetorrent,apachetorrent,hdrtorrent',
    ),
    // Fora do caminho da resposta, DENTRO do sistema: estes indexers não
    // recebem busca ao vivo de nenhum usuário (latência medida de 8–31s contra
    // orçamento total de 20s derrubava-os no breaker e ainda consumia o prazo
    // com o retry PT→título original). Alimentam o índice pelo COLHEDOR, que
    // tem fila persistente, orçamento largo e cujas falhas não pintam card —
    // e a busca ao vivo serve do índice quando ele cobre a obra. Separado de
    // JACKETT_SLOW_INDEXERS de propósito: lá o problema é o agrupamento do
    // plano; aqui é PRESENÇA na resposta.
    indexOnlyIndexers: list(
      process.env.JACKETT_INDEX_ONLY_INDEXERS || 'redetorrent,apachetorrent,hdrtorrent',
    ),
    // Circuit breaker: indexer offline em N amostras seguidas deixa de
    // receber orçamento de busca (20s nos BR) até a falha esfriar — busca
    // real nunca conserta fonte morta, só queima prazo. slow/degraded não
    // quebram o circuito; o diagnóstico (/test-indexer.json) ignora o
    // breaker, porque é ele quem repara a fonte.
    breakerEnabled: String(process.env.JACKETT_BREAKER_ENABLED || 'true') === 'true',
    breakerFailures: num(process.env.JACKETT_BREAKER_FAILURES, 3),
    breakerCooldown: num(process.env.JACKETT_BREAKER_COOLDOWN_MS, 5 * 60_000),
  },
  warmup: {
    // Catálogo curado para aquecer raw antes do primeiro usuário. O operador
    // pode substituir a lista pelo perfil real de consumo da instância.
    enabled: String(process.env.WARMUP_ENABLED || 'true') === 'true',
    titles: list(process.env.WARMUP_TITLES || 'tt7286456:movie,tt11198330:movie,tt1630029:movie,tt11126994:series,tt3581920:series,tt2861424:series'),
    concurrency: num(process.env.WARMUP_CONCURRENCY, 2),
    indexerDelayMs: num(process.env.WARMUP_INDEXER_DELAY_MS, 250),
    timeoutMs: num(process.env.WARMUP_TIMEOUT_MS, 600000),
    // BR/slow têm orçamento de 20s; no boot o padrão aquece só globais.
    skipSlow: String(process.env.WARMUP_SKIP_SLOW || 'true') === 'true',
  },
  // Índice de releases por obra (`idx:v5`): o que a busca já provou existir,
  // filtrado e dedupado por hash. Compartilhado entre instalações DE PROPÓSITO —
  // guarda o que EXISTE, nunca o que está pronto em qual conta (isso é
  // davail/mag, escopados por conta). RELEASE_INDEX=false desliga a escrita E a
  // leitura; RELEASE_INDEX_TTL=0 idem.
  releaseIndex: {
    enabled: String(process.env.RELEASE_INDEX || 'true') === 'true',
    // Release não deixa de existir por envelhecer — quem a desqualifica é o
    // mag/dead, não o relógio. O TTL longo é só esquecimento lento.
    ttl: num(process.env.RELEASE_INDEX_TTL, 30 * 24 * 3600),
    // Teto de releases por obra: pack de temporada + encodes não podem virar
    // uma entrada gigante (cota de 4.000 chaves assume ~8 KB por chave).
    maxReleases: num(process.env.RELEASE_INDEX_MAX_RELEASES, 60),
  },
  // Fast-path da conta: se o inventário do debrid sozinho entrega releases
  // suficientes da obra pedida, a resposta sai na hora e o Jackett vai para o
  // tail enriquecer. Título novo continua no caminho normal.
  accountFastPath: {
    enabled: String(process.env.ACCOUNT_FAST_PATH || 'true') === 'true',
    // Menor que isso não é "suficiente": uma release só pode ser um pack
    // ambíguo ou encode ruim; o tail enriquece de qualquer forma.
    minReleases: num(process.env.ACCOUNT_FAST_MIN_RELEASES, 2),
    // Espera máxima pela conta na resposta imediata do fast-path (a primeira
    // leitura do inventário custa ~700ms; depois vem do memo, ~0ms).
    waitMs: num(process.env.ACCOUNT_FAST_WAIT_MS, 450),
  },
  // Colhedor: generalização do warmup. Fila de obras colhidas em fundo, com
  // orçamento largo (ninguém está esperando) e freio de atividade em janela
  // deslizante — colher só enquanto ninguém usa há N minutos.
  harvest: {
    enabled: String(process.env.HARVEST_ENABLED || 'true') === 'true',
    intervalMs: num(process.env.HARVEST_INTERVAL_MS, 60_000),
    idleWindowMs: num(process.env.HARVEST_IDLE_WINDOW_MS, 10 * 60_000),
    queueMax: num(process.env.HARVEST_QUEUE_MAX, 200),
    // O painel mostra apenas uma amostra; a fila inteira pode conter centenas
    // de obras e não deve virar payload operacional.
    queuePreview: Math.max(0, Math.trunc(num(process.env.HARVEST_QUEUE_PREVIEW, 8))),
    dashboardLastWorks: Math.max(0, Math.trunc(num(process.env.HARVEST_DASHBOARD_LAST, 10))),
    // Drenar pelo painel continua submetido ao teto horário. Este limite evita
    // que um clique monopolize o colhedor por muito tempo.
    drainMaxWorks: Math.max(1, Math.trunc(num(process.env.HARVEST_DRAIN_MAX_WORKS, 5))),
    // Teto de educação com os indexers: o colhedor reduz carga total (a mesma
    // obra deixa de ser raspada a cada busca), mas não pode virar crawler.
    // Teto de consultas ao Jackett por hora. O piso NÃO é gosto: uma obra custa
    // uma consulta por indexer MAIS uma por alvo da varredura pt-BR (medido
    // nesta instalação: 19 + 12 = 31). Teto abaixo disso faz a varredura ser
    // pulada SEMPRE — o guard dela soma os alvos antes de decidir — e é
    // justamente ela que acha o dublado titulado em PT nos trackers globais.
    // 120 ≈ 4 obras/hora com a varredura inteira em cada uma.
    maxPerHour: num(process.env.HARVEST_MAX_HOUR, 120),
    indexerDelayMs: num(process.env.HARVEST_INDEXER_DELAY_MS, 1500),
    entryTtl: num(process.env.HARVEST_ENTRY_TTL, 7 * 24 * 3600),
  },
  prowlarr: {
    url: (process.env.PROWLARR_URL || 'http://127.0.0.1:9696').replace(/\/$/, ''),
    apiKey: process.env.PROWLARR_API_KEY || '',
  },
  // Pool GLOBAL Torrentio (Fase 1). Consulta a API pública do serviço — sem
  // config nem credencial — para trazer releases já indexadas no acervo global.
  // `url` é só o host canônico; a fonte pode ser desligada por instalação via
  // o toggle na página. Nenhuma chave do usuário sai do processo.
  torrentio: {
    enabled: String(process.env.TORRENTIO_ENABLED || 'true') === 'true',
    url: (process.env.TORRENTIO_URL || 'https://torrentio.strem.fun').replace(/\/$/, ''),
    timeout: Math.max(1, num(process.env.TORRENTIO_TIMEOUT_MS, 1500)),
    breakerFailures: Math.max(1, Math.trunc(num(process.env.TORRENTIO_BREAKER_FAILURES, 3))),
    breakerCooldown: Math.max(0, num(process.env.TORRENTIO_BREAKER_COOLDOWN_MS, 5 * 60_000)),
  },
  tmdb: {
    apiKey: process.env.TMDB_API_KEY || '',
    timeout: num(process.env.TMDB_TIMEOUT_MS, 5000),
    cacheTtl: num(process.env.TMDB_CACHE_TTL, 604800), // 7 dias
    // TTL do cache NEGATIVO (id que devolveu nada/erro). Sem ele, título
    // desconhecido bate na API a cada busca; TTL curto porque falha pode ser
    // transitória. 0 desliga o cache de miss.
    missTtl: num(process.env.TMDB_MISS_TTL, 300),
  },
  cinemeta: {
    // O Cinemeta roda antes da coleta. Deixá-lo esperar o teto inteiro do
    // cliente consumiria o deadline sem sequer consultar os indexers; após
    // este prazo a busca degrada para o título do TMDB ou para o IMDb id.
    timeout: num(process.env.CINEMETA_TIMEOUT_MS, 2500),
    // Cache negativo, mesmo racional do TMDB: id inexistente não pode custar
    // 2,5s de rede em toda busca. 0 desliga.
    missTtl: num(process.env.CINEMETA_MISS_TTL, 300),
  },
  // Defaults dos sites BR. O carregador embutido (src/br-resolvers.ts) injeta
  // estes valores no SITE_URL de cada resolvedor quando a env não vem do .env,
  // então É AQUI que se troca um domínio derrubado -- o default hardcoded no
  // <nome>-resolver/server.js só vale para o modo container separado.
  resolvers: {
    embedded: String(process.env.BR_RESOLVERS_EMBEDDED || 'true') === 'true',
    host: process.env.BR_RESOLVERS_HOST || '127.0.0.1',
    portOffset: Number(process.env.BR_RESOLVERS_PORT_OFFSET || 0) || 0,
    // As portas também pertencem à infraestrutura do addon. Os profiles
    // CommonJS recebem-nas pela ponte temporária em br-resolvers.ts.
    ports: {
      bludv: 8700,
      comandotorrents: 8701,
      nerdfilmes: 8702,
      torrentdosfilmes: 8703,
    },
    bludvUrl: (process.env.BLUDV_URL || BLUDV_DEFAULT_URL).replace(/\/$/, ''),
    comandotorrentsUrl: (process.env.COMANDOTORRENTS_URL || 'https://comandotorrents.to').replace(/\/$/, ''),
    // xnerdfilmes.net migrou para nerdviatorrents.net (301 permanente); o
    // domínio novo precisa estar também na allowlist do resolver, senão o
    // redirect vira blocked_host e a fonte morre em silêncio.
    nerdfilmesUrl: (process.env.NERDFILMES_URL || 'https://www.nerdviatorrents.net').replace(/\/$/, ''),
    torrentdosfilmesUrl: (process.env.TORRENTDOSFILMES_URL || 'https://torrentdosfilmes-v2.xyz').replace(/\/$/, ''),
    extraProtectors: list(process.env.EXTRA_ALLOWED_PROTECTORS),
  },
  logging: {
    level: process.env.ADDON_LOG_LEVEL || 'info',
  },
  bludv: {
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
  },
  // Dublado antes de legendado DENTRO da mesma qualidade. Ligado por padrão: o
  // diferencial do addon é conteúdo BR dublado, e desligado as cotas por
  // qualidade (max1080p e cia.) não distinguem áudio — três releases legendadas
  // do mesmo post enchiam a cota do 1080p e empurravam a DUAL para fora.
  preferDubbed: String(process.env.PREFER_DUBBED || 'true') === 'true',
  // `compact` deixa na coluna estreita do Stremio só qualidade/áudio/BR/seeds;
  // a release inteira fica no `title`, que é a coluna larga. `full` duplica a
  // release nas duas — só faz sentido em cliente que ignora o `title`, e custa
  // ~11 linhas de altura por stream no Stremio.
  streamNameStyle: process.env.STREAM_NAME_STYLE === 'full' ? 'full' : 'compact',
  // Mostra o indexer no `name`, além da linha de metadados. Alguns clientes
  // só exibem a fonte se ela vier neste campo, sem reconhecer o marcador ⚙️.
  streamNameShowSource: String(process.env.STREAM_NAME_SHOW_SOURCE || 'true') !== 'false',
  qualityFilter: list(process.env.QUALITY_FILTER),
  minSeeders: num(process.env.MIN_SEEDERS, 1),
  maxResults: num(process.env.MAX_RESULTS, 40),
  // 6 em todas: a página de configurar tem UM controle para as seis cotas, e
  // 6 era o número que o balde "unknown" (as fontes BR, que não publicam
  // resolução) já usava. Uniformizar por baixo encolheria BR sem motivo.
  qualityLimits: {
    '2160p': num(process.env.MAX_STREAMS_2160P, 6),
    '1080p': num(process.env.MAX_STREAMS_1080P, 6),
    '720p': num(process.env.MAX_STREAMS_720P, 6),
    '480p': num(process.env.MAX_STREAMS_480P, 6),
    SD: num(process.env.MAX_STREAMS_SD, 6),
    unknown: num(process.env.MAX_STREAMS_UNKNOWN, 6),
  },
  // Teto de streams por indexador no resultado final (0 = sem limite). Impede
  // que uma fonte com muitos resultados ocupe quase todas as vagas. As vagas
  // reservadas BR não contam para esta cota.
  maxPerIndexer: num(process.env.MAX_STREAMS_PER_INDEXER, 0),
  // Quantos candidatos considerar antes do filtro do debrid.
  candidatePoolFactor: num(process.env.CANDIDATE_POOL_FACTOR, 4),
  // Vagas garantidas para fontes BR dubladas no resultado final. "Garantidas"
  // ao pé da letra: elas atravessam a cota por qualidade E o teto por indexador,
  // e não consomem a cota -- as globais ficam com o balde inteiro delas. Só o
  // MAX_RESULTS as corta.
  brReservedSlots: num(process.env.BR_RESERVED_SLOTS, 6),
  // Reserva BR POR FAIXA de qualidade: com a reserva global, 1080p BR
  // abundante tomava todas as vagas e a faixa 4K/720p ficava sem BR mesmo
  // quando existia fonte. Garante até N BR (dublado primeiro) por balde de
  // qualidade antes de a cota da faixa ser preenchida por globais.
  // 0 restaura o comportamento de reserva única global.
  brReservedPerQuality: num(process.env.BR_RESERVED_PER_QUALITY, 1),
  // Se o orçamento normal terminou só com globais, espera um pouco pela
  // primeira fonte BR. Algumas UIs não repetem a resposta parcial, então o
  // passe tardio sozinho não torna o dublado visível na lista já aberta.
  brPartialGrace: num(process.env.BR_PARTIAL_GRACE_MS, 1500),
  cacheTtl: num(process.env.CACHE_TTL, 900),
  // Cache do resultado BRUTO da busca (sem credencial nem config do usuário):
  // duas instalações com configs diferentes do mesmo título passam a
  // compartilhar a raspagem do Jackett/BLUDV. 0 desliga cada camada.
  rawCache: {
    ttl: num(process.env.RAW_CACHE_TTL, 900),
    // Indexers pt-BR raspam WordPress e ainda pagam saltos de protetor de
    // link (20s de orçamento): custam mais e mudam menos, então vivem mais.
    ttlBr: num(process.env.RAW_CACHE_TTL_BR, 1800),
    // 200 com zero itens pode ser rate-limit disfarçado: TTL curto separado,
    // senão um indexer travado congela o vazio pelo TTL inteiro.
    emptyTtl: num(process.env.RAW_CACHE_EMPTY_TTL, 120),
    // Pior caso real medido: 862 bytes por item. O teto mantém cada entrada
    // abaixo de ~100 KB no L1; acima dele o resultado não é cacheado.
    // 0 desliga o cache bruto inteiro.
    maxItems: num(process.env.RAW_CACHE_MAX_ITEMS, 120),
  },
  // Janela de graça do stale-while-revalidate das listas de stream (Fase 2):
  // depois do CACHE_TTL, a entrada expirada ainda é servida na hora enquanto
  // um refresh de fundo a reconstrói. Só vale para lista completa com debrid
  // conferido e stream tocável. 0 volta à semântica dura (expirou = busca nova).
  streamStaleGrace: num(process.env.STREAM_STALE_GRACE_SECONDS, 300),
  cache: {
    // Memória é sempre L1; SQLite só preserva o aquecimento entre restarts.
    persist: String(process.env.CACHE_PERSIST || 'true') !== 'false',
    dbPath: process.env.CACHE_DB_PATH || DEFAULT_CACHE_DB_PATH,
  },
  debrid: {
    // premiumize | realdebrid | alldebrid | torbox | debridlink
    // Vazio = modo P2P puro (infoHash direto). A lista viva está em src/debrid/index.js.
    service: (process.env.DEBRID_SERVICE || '').toLowerCase(),
    apiKey: process.env.DEBRID_API_KEY || '',
    // Em instância pública, não deixe uma instalação sem config gastar a conta
    // do operador. O default preserva o modo de usuário único já existente.
    allowEnvKey: String(process.env.DEBRID_ALLOW_ENV_KEY || 'true') === 'true',
    cachedOnly: String(process.env.DEBRID_CACHED_ONLY || 'true') === 'true',
    // Exceção opt-in ao cachedOnly: devolve as vagas BR como P2P enquanto o
    // debrid baixa o dublado. Default off preserva o contrato antigo — web e
    // algumas TVs não tocam infoHash, e URL sem `bu` herdaria o furo.
    showUncachedBr: String(process.env.DEBRID_SHOW_UNCACHED_BR || 'false') === 'true',
    // Cliente que só toca URL (web, algumas TVs, apps que filtram stream sem
    // `url`) enxerga ZERO quando nada do título está em cache: o não-cacheado
    // sai como infoHash puro e some na tela, mesmo com a busca cheia.
    //
    // Ligado, o não-cacheado também sai pelo /resolve, marcado "[AD download]"
    // — é o modelo do Torrentio: o play adiciona o magnet e o debrid baixa.
    // Default off porque isso escreve na conta do usuário a cada play de fonte
    // fria, que é justamente o que o modo padrão evita.
    resolveUncached: String(process.env.DEBRID_RESOLVE_UNCACHED || 'false') === 'true',
    // Lotes da checagem de cache, em paralelo, cada um com o teto COMPLETO
    // (não dividido). Não é aceleração: a latência é do serviço (44 hashes em
    // 1,9s; 43 em 4,7s — mesma conta). É degradação parcial: um lote que
    // responde marca o ⚡ dos seus itens mesmo quando o outro estoura o prazo
    // (normalizeCacheResult preserva o Set parcial com known:false). Com 100,
    // lista de ~45 hashes era 1 lote só — estourou, o Set voltava vazio e a
    // lista inteira ficava sem ⚡ (medido no Premiumize: 4 de 9 checagens
    // perderam o teto dinâmico de ~1,8s). Muito pequeno também não: rajada de
    // requisições paralelas responde rate_limit_reached no Premiumize; 25 é
    // o ponto de partida medido. Na AllDebrid cada lote é um upload de
    // verdade — 25 significa mais uploads paralelos, e a limpeza cuida dos
    // ids de todos.
    batchSize: num(process.env.DEBRID_BATCH_SIZE, 25),
    // Teto SÓ da checagem de cache. Com os lotes em paralelo é UMA janela, não
    // uma por lote — era a soma em série que estourava o REPLY_DEADLINE.
    //
    // Deliberadamente MAIOR que DEBRID_RESERVE_MS e que o REPLY_DEADLINE. É o
    // teto do PASSE TARDIO: os resolvedores BR rodam neste processo e podem
    // estender a mesma chamada de 2,6s para 7-9s. O passo de resposta usa o
    // orçamento dinâmico abaixo; depois o fundo repete sem teto curto e grava a
    // lista completa com ⚡/cachedOnly restaurados.
    cacheCheckTimeout: num(process.env.DEBRID_CACHE_CHECK_TIMEOUT_MS, 10000),
    // Teto dinâmico da checagem de cache no passo de resposta: o que sobra do
    // REPLY_DEADLINE menos esta margem (filtro + HMAC + serialização). Caso
    // medido: coleta fria de 162 itens consumiu os 6400ms do orçamento e a
    // checagem Premiumize de 3,5s estourou o deadline devolvendo []; com a
    // margem, a checagem degrada para known:false e a lista sai não-vazia.
    checkFormatMargin: num(process.env.DEBRID_CHECK_FORMAT_MARGIN_MS, 500),
    // Piso para disputar na primeira resposta uma checagem que não pode ser
    // abortada (AllDebrid). A chamada continua em background se perder o prazo;
    // abaixo deste valor ela só atrasaria a resposta sem chance útil de vencer.
    nonAbortableRaceFloor: num(process.env.DEBRID_NON_ABORTABLE_RACE_MIN_MS, 400),
    // Disponibilidade confirmada fica mais tempo; 0 desliga esta metade da
    // camada sem deploy. Cache pertence à conta, nunca à instalação.
    availPosTtl: num(process.env.DEBRID_AVAIL_POS_TTL, 900),
    // Negativo expira cedo para o recheck do autofetch enxergar o download
    // pronto logo; 0 deixa negativos sempre irem à rede.
    availNegTtl: num(process.env.DEBRID_AVAIL_NEG_TTL, 120),
    // Remove da conta do debrid o que não está em cache. Sem isso cada consulta
    // deixa um download rodando lá (AllDebrid só informa cache ao dar upload).
    dropUncached: String(process.env.DEBRID_DROP_UNCACHED || 'true') === 'true',
    // A checagem de cache é um upload: sem remover TAMBÉM os prontos, cada
    // busca deixa dezenas de magnets na conta para sempre (medido: 2300 em
    // quatro dias, até estourar o teto da AllDebrid e derrubar a checagem —
    // com o ⚡ sumindo de todos os streams). Apagar não custa cache: ele é do
    // serviço, e o play reenvia o hash na hora. Desligue se preferir ver na
    // conta tudo que passou pela lista.
    dropReady: String(process.env.DEBRID_DROP_READY || 'true') === 'true',
    // O snapshot protege os magnets que já eram da conta antes do addon. Ele
    // precisa vencer: o usuário pode adicionar algo no site do debrid depois
    // do boot, e uma referência congelada nunca pode autorizar o apagamento.
    preexistingTtlMs: Math.max(0, num(process.env.ALLDEBRID_PREEXISTING_TTL_MS, 300_000)),
    // Varredura dos magnets em estado terminal ("No peer after 30 minutes",
    // "Expired", "File not available"). A limpeza por busca só alcança hashes
    // que estão na consulta do momento; um torrent que morreu e nunca mais é
    // pesquisado fica ocupando vaga para sempre — medido: 183 mortos numa conta
    // no teto, e conta no teto faz a AllDebrid recusar /magnet/delete com 503.
    // Ao contrário do dropReady, NÃO poupa o inventário do usuário: magnet em
    // estado terminal não é escolha de ninguém, é lixo que consome quota.
    sweepDead: String(process.env.DEBRID_SWEEP_DEAD || 'true') === 'true',
    sweepDeadIntervalMs: num(process.env.DEBRID_SWEEP_DEAD_INTERVAL_MS, 6 * 3600 * 1000),
    // Margem antes de considerar um estado terminal definitivo: evita varrer um
    // magnet que a conta acabou de marcar e ainda pode reavaliar.
    sweepDeadMinAgeMs: num(process.env.DEBRID_SWEEP_DEAD_MIN_AGE_MS, 30 * 60 * 1000),
    // Varredura dos magnets ANTIGOS sem áudio PT (balde `lixo` do audioBucket):
    // legendado/estrangeiro que o autofetch acumulou antes do filtro de áudio.
    // Destrutiva sobre conteúdo tocável — as travas andam juntas: idade mínima,
    // `held`, inventário conhecido (frio = rodada pulada). false desliga tudo
    // (rollback de uma linha).
    sweepUndubbed: String(process.env.DEBRID_SWEEP_UNDUBBED || 'true') === 'true',
    sweepUndubbedIntervalMs: num(process.env.DEBRID_SWEEP_UNDUBBED_INTERVAL_MS, 6 * 3600 * 1000),
    // Idade mínima: só magnet mais antigo que isso entra na varredura (7 dias).
    sweepUndubbedMinAgeMs: num(process.env.DEBRID_SWEEP_UNDUBBED_MIN_AGE_MS, 7 * 24 * 3600 * 1000),
    // Teto por rodada; os mais antigos saem primeiro.
    sweepUndubbedMax: Math.max(0, Math.trunc(num(process.env.DEBRID_SWEEP_UNDUBBED_MAX, 100))),
    timeout: num(process.env.DEBRID_TIMEOUT_MS, 6000),
    // Sem fonte BR dublada em cache, manda o serviço baixar a melhor. O TTL vale
    // pra duas coisas: não reenviar o mesmo torrent a cada busca e por quanto
    // tempo ele fica protegido do dropUncached.
    autoFetchBr: String(process.env.DEBRID_AUTO_FETCH_BR || 'true') === 'true',
    // Fallback quando a busca não achou NENHUMA fonte BR dublada (site fora,
    // domínio mudou, título não indexado): baixa a melhor global que anuncia
    // áudio PT explícito. Default on é o próprio caso de uso do
    // autofetch — busca BR vazia não pode significar "não baixa nada".
    autoFetchAnyDubbed: String(process.env.DEBRID_AUTO_FETCH_ANY || 'true') === 'true',
    autoFetchTtl: num(process.env.DEBRID_AUTO_FETCH_TTL, 6 * 3600),
    // Quantos torrents BR dublados o autofetch baixa em background por busca
    // (uma vaga por candidato, compartilhada entre o passe parcial e o tardio).
    // Mais candidatos = mais chances de play pronto depois, ao custo de encher
    // mais a conta. Clamp 1..4: 0 não desliga o recurso (quem desliga é o toggle
    // DEBRID_AUTO_FETCH_BR); o teto superior 4 respeita o contrato de "até 4".
    autoFetchMax: Math.min(4, Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_MAX, 4)))),
    // Rede de segurança quando o título não tem dublagem NENHUMA (filme antigo,
    // cult, série sem áudio PT): sem isso a busca acaba sem baixar nada e, com
    // "somente já em cache" ligado, o usuário vê zero opção para sempre. O
    // limite é separado do autofetch dublado para não encher a conta com até
    // quatro torrents apenas porque o título não tem áudio PT.
    autoFetchTopSeeds: String(process.env.DEBRID_AUTO_FETCH_TOP_SEEDS || 'true') === 'true',
    autoFetchTopSeedsMax: Math.min(4, Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_TOP_SEEDS_MAX, 2)))),
    // Um torrent com poucos pares costuma morrer na fila do debrid; abaixo de
    // três seeders o download não é uma alternativa saudável ao episódio vazio.
    autoFetchMinSeeders: Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_MIN_SEEDERS, 3))),
    // Preferência PT no pool de swarm: candidato com sinal de português
    // (dublado/nacional ou título que denuncia pt-BR) vence a contagem bruta
    // de seeders. É preferência, não filtro: sem nenhum candidato PT a ordem
    // por seeders continua valendo. false restaura a ordenação antiga.
    autoFetchSeedsPtFirst: String(process.env.DEBRID_AUTO_FETCH_SEEDS_PT_FIRST || 'true') === 'true',
    // Recheck pós-enfileiramento: depois de aceitar um torrent, o addon volta a
    // perguntar ao debrid se ele já toca (sem o teto do deadline — é um passe
    // de fundo). Quando fica pronto, o cache da busca é esquecido para a
    // próxima pergunta do Stremio reconstruir a lista com ⚡, em vez de esperar
    // o CACHE_TTL inteiro. 0 em qualquer um desliga o recheck.
    autoFetchRecheckMs: num(process.env.DEBRID_AUTO_FETCH_RECHECK_MS, 120_000),
    autoFetchRecheckMax: num(process.env.DEBRID_AUTO_FETCH_RECHECK_MAX, 3),
    // Torrent que informa "running" com progresso ausente/0 e mensagem "0 Bytes
    // of 0 Bytes" / "from 0 peer" está PARADO, não baixando. É o mesmo sintoma
    // de um morto, mas merece limiar próprio: a ausência de pares pode ser
    // transitória (magnet frio) e matar na 1ª observação descartaria um
    // download que ainda podia esquentar. Após N rechecks consecutivos parado,
    // o recheck trata como morto (blacklist, remoção e dreno da fila). 0
    // desliga a detecção: parado nunca mais derruba um download.
    autoFetchStallStreak: Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_STALL_STREAK, 3))),
    // Pack de temporada pronto invalida os episódios já buscados daquela mesma
    // conta/temporada; a próxima lista usa o davail positivo sem esperar CACHE_TTL.
    autoFetchSeasonFill: String(process.env.DEBRID_AUTO_FETCH_SEASON_FILL || 'true') === 'true',
    // LRU do índice em memória de temporadas. 0 desliga o índice sem deploy.
    autoFetchSeasonIndexMax: Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_SEASON_INDEX_MAX, 200))),
    // Teto de chaves de busca por temporada no índice. Cada instalação da
    // mesma conta é uma chave distinta; conta compartilhada por muitas URLs
    // precisa de teto maior para o fill alcançar todas após um pack pronto.
    autoFetchSeasonIndexKeys: Math.max(16, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_SEASON_INDEX_KEYS, 256))),
    // Fila persistente de autofetch e drenagem automática
    autoFetchQueue: String(process.env.DEBRID_AUTO_FETCH_QUEUE || 'true') === 'true',
    autoFetchQueueDepth: Math.min(12, Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_QUEUE_DEPTH, 6)))),
    autoFetchDeadTtl: num(process.env.DEBRID_AUTO_FETCH_DEAD_TTL, 86400),
    autoFetchSettleMs: num(process.env.DEBRID_AUTO_FETCH_SETTLE_MS, 900_000),
    autoFetchSettleMaxLots: Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_SETTLE_MAX_LOTS, 50))),
    autoFetchQueueTtl: num(process.env.DEBRID_AUTO_FETCH_QUEUE_TTL, 86400),
    autoFetchEnqueueMaxHour: Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_ENQUEUE_MAX_HOUR, 50))),
    autoFetchDrainMaxRefusals: Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_DRAIN_MAX_REFUSALS, 2))),
    // Orçamento horário cheio não é recusa do torrent. Pausa a drenagem para
    // não girar a mesma fila até a janela deslizante voltar a ter espaço.
    autoFetchDrainBackoffMs: Math.max(0, num(process.env.DEBRID_AUTO_FETCH_DRAIN_BACKOFF_MS, 60_000)),
    // Gate de ocupação da conta (backpressure): com este número de magnets ou
    // mais, o autofetch para de enfileirar — conta no teto derruba a checagem
    // de cache (upload, na AllDebrid) e o ⚡ some da lista inteira. Alinhado ao
    // teto de aviso do /debrid-status.json. 0 desliga o gate.
    autoFetchPauseAt: Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_PAUSE_AT, 800))),
    // Validade do memo de ocupação do gate: vencida, a contagem é renovada em
    // background (fail-open enquanto o refresh não volta — nunca rede no
    // caminho síncrono).
    autoFetchPauseRefreshMs: Math.max(0, num(process.env.DEBRID_AUTO_FETCH_PAUSE_REFRESH_MS, 900_000)),
    // Sonda em fundo no Real-Debrid: substituto honesto do instantAvailability
    // aposentado. Mede addMagnet→downloaded na conta, grava magnetdb, apaga o
    // torrent da sonda. Fora do caminho da resposta. false desliga tudo.
    rdProbe: String(process.env.DEBRID_RD_PROBE || 'true') === 'true',
    // Teto por busca (e por janela horária abaixo). Concurrency implícita = 1.
    // Default 2: cada sonda é addMagnet+info+delete; com autofetch na mesma
    // conta, 4 em paralelo com o passe tardio estourava 429 com facilidade.
    rdProbeMax: Math.min(8, Math.max(0, Math.trunc(num(process.env.DEBRID_RD_PROBE_MAX, 2)))),
    rdProbeMaxHour: Math.max(0, Math.trunc(num(process.env.DEBRID_RD_PROBE_MAX_HOUR, 40))),
    // Folga entre sondas — longe do teto de 250 req/min e do aviso de bruteforce.
    rdProbeGapMs: Math.max(0, num(process.env.DEBRID_RD_PROBE_GAP_MS, 800)),
    // Espera após a resposta antes da 1ª sonda: o autofetch RD também faz
    // addMagnet na mesma janela; sem folga a sonda herda 429 na hora.
    rdProbeInitialDelayMs: Math.max(0, num(process.env.DEBRID_RD_PROBE_INITIAL_DELAY_MS, 15_000)),
    // Após 429, pausa novas sondas (doc: bruteforce bloqueia por tempo indefinido).
    rdProbeRateCooldownMs: Math.max(0, num(process.env.DEBRID_RD_PROBE_RATE_COOLDOWN_MS, 90_000)),
    // Miss recente não re-sonda (evita martelar o mesmo hash pending).
    rdProbeMissTtlMs: Math.max(0, num(process.env.DEBRID_RD_PROBE_MISS_TTL_MS, 120_000)),
    // Ledger durável GLOBAL do CDN Real-Debrid. Ao contrário do magnetdb,
    // disponibilidade do RD é do serviço, não da conta que a observou.
    rdLedger: {
      enabled: String(process.env.DEBRID_RD_LEDGER || 'true') === 'true',
      hitTtl: Math.max(0, num(process.env.DEBRID_RD_LEDGER_HIT_TTL, 2_592_000)),
      blockedTtl: Math.max(0, num(process.env.DEBRID_RD_LEDGER_BLOCKED_TTL, 2_592_000)),
      // Miss só evita re-sondar um pending; cresce para não martelar, mas nunca
      // vira filtro de stream — falso negativo aqui é pior que falso positivo.
      missBackoffMs: (list(process.env.DEBRID_RD_LEDGER_MISS_BACKOFF_MS || '1800000,7200000,43200000,259200000')
        .map((value) => Math.max(0, Math.trunc(num(value, 0))))
        .filter((value) => value > 0)),
    },
    // Oráculo externo do cache global RD. Só habilita o cacheCheck dinâmico
    // quando há fonte COM credencial e ledger: sem as duas, o RD continua honesto
    // como "não sei" e cachedOnly não pode esconder a lista.
    //
    // Opt-in seguro: `enabled` é true por padrão, mas as FONTES são off por
    // padrão — `stremthruUrl` nasce VAZIO e `torrentio` false. Sem endpoint/flag
    // explícito nenhuma credencial sai para terceiros: a `available()` exige
    // fonte realmente utilizável com credencial efetiva, então sem elas o RD
    // segue honesto em "não sei". Um terceiro só vê a apiKey da instalação (nos
    // headers/Bearer/token quando não há token/key explícitos) se o operador
    // configurar deliberadamente a fonte.
    rdOracle: {
      enabled: String(process.env.DEBRID_RD_ORACLE || 'true') === 'true',
      timeoutMs: Math.max(1, num(process.env.DEBRID_RD_ORACLE_TIMEOUT_MS, 800)),
      maxHashes: Math.min(500, Math.max(1, Math.trunc(num(process.env.DEBRID_RD_ORACLE_MAX_HASHES, 100)))),
      // Vazio por padrão: endpoint público canonico só vira destino depois que o
      // operador o define (e ainda assim exige credencial efetiva). Documentado
      // no .env.example; o valor canônico pode ser reposto ali. Limite 500/hash.
      stremthruUrl: (process.env.DEBRID_RD_ORACLE_STREMTHRU_URL || '').replace(/\/$/, ''),
      stremthruToken: process.env.DEBRID_RD_ORACLE_STREMTHRU_TOKEN || '',
      stremthruStore: process.env.DEBRID_RD_ORACLE_STREMTHRU_STORE || 'realdebrid',
      torrentio: String(process.env.DEBRID_RD_ORACLE_TORRENTIO || 'false') === 'true',
      // O URL canônico permanece como default, mas isso NÃO vale por envio: o
      // flag `torrentio` nasce false e é o opt-in. Só com ele true a fonte é
      // consultada (e só com credencial efetiva a chamada vai à rede).
      torrentioUrl: (process.env.DEBRID_RD_ORACLE_TORRENTIO_URL || 'https://torrentio.strem.fun').replace(/\/$/, ''),
      // Vazio usa a chave efetiva da instalação (a mesma recebida por rdOracle.check),
      // nunca a do operador por engano.
      torrentioKey: process.env.DEBRID_RD_ORACLE_TORRENTIO_KEY || '',
      torrentioTtl: Math.max(0, num(process.env.DEBRID_RD_ORACLE_TORRENTIO_TTL, 21600)),
    },
    // Governador por conta das escritas no Real-Debrid. false preserva o fluxo
    // anterior, inclusive o gap e o cooldown próprios da sonda.
    rdGate: {
      enabled: String(process.env.DEBRID_RD_GATE || 'true') === 'true',
      minGapMs: Math.max(0, num(process.env.DEBRID_RD_GATE_MIN_GAP_MS, 1_000)),
      maxGapMs: Math.max(0, num(process.env.DEBRID_RD_GATE_MAX_GAP_MS, 30_000)),
      cooldownMs: Math.max(0, num(process.env.DEBRID_RD_GATE_COOLDOWN_MS, 90_000)),
      // Depois deste teto play fura só gap/cooldown; job já em voo não é
      // preemptado e ainda precisa terminar.
      playMaxWaitMs: Math.max(0, num(process.env.DEBRID_RD_GATE_PLAY_MAX_WAIT_MS, 1_500)),
    },
    // Warmer contínuo em fundo para o Real-Debrid (Fase F3).
    rdWarm: {
      enabled: String(process.env.DEBRID_RD_WARM || 'true') === 'true',
      intervalMs: Math.max(1, num(process.env.DEBRID_RD_WARM_INTERVAL_MS, 30_000)),
      batch: Math.max(1, Math.trunc(num(process.env.DEBRID_RD_WARM_BATCH, 10))),
      maxPerHour: Math.max(0, Math.trunc(num(process.env.DEBRID_RD_WARM_MAX_HOUR, 300))),
      idleWindowMs: Math.max(0, num(process.env.DEBRID_RD_WARM_IDLE_WINDOW_MS, 120_000)),
      queueMax: Math.max(1, Math.trunc(num(process.env.DEBRID_RD_WARM_QUEUE_MAX, 5000))),
    },
    // Prefetch do próximo episódio de séries
    prefetchNextEp: String(process.env.DEBRID_PREFETCH_NEXT_EP || 'true') === 'true',
    prefetchTtl: num(process.env.DEBRID_PREFETCH_TTL, 43200),
    // A conta como fonte de busca: o que já está pronto no debrid entra com ⚡
    // sem depender de indexer — inclusive pack de franquia que o casamento
    // estrito dos trackers rejeita (medido: "FILMOGRAFIA COMPLETA JORNADA NAS
    // ESTRELAS" pronto na conta e invisível, porque nenhum indexer devolve o
    // título). AllDebrid, TorBox e Real-Debrid expõem inventário; nos demais é no-op.
    inventorySource: String(process.env.DEBRID_INVENTORY_SOURCE || 'true') === 'true',
    // Validade do inventário memoizado: ele só muda quando o usuário mexe na
    // conta, então 300s troca "refletir uploads novos" por "não bater na API
    // a cada busca". Falha nunca fica gravada.
    inventoryTtl: num(process.env.DEBRID_INVENTORY_TTL, 300),
    // Teto defensivo de itens lidos da conta (a real medida tem 1208 prontos).
    inventoryMax: Math.max(1, Math.trunc(num(process.env.DEBRID_INVENTORY_MAX, 3000))),
    // Teto da fonte DENTRO da busca: a primeira leitura custa ~700ms (medido);
    // estourou, a tarefa devolve [] e a próxima busca pega do memo aquecido.
    inventoryTimeoutMs: num(process.env.DEBRID_INVENTORY_TIMEOUT_MS, 1500),
    // Diagnóstico não pode reter o gate global quando a API da conta está fora
    // do ar; é separado do timeout da busca de inventário.
    dashboardAccountTimeoutMs: num(process.env.DEBRID_DASHBOARD_ACCOUNT_TIMEOUT_MS, 3000),
    // Limiares operacionais do /debrid-status.json. O total mantém Number()
    // para preservar o comportamento histórico para valor inválido (NaN não avisa).
    accountWarnTotal: Number(process.env.DEBRID_ACCOUNT_WARN_TOTAL || 800),
    accountWarnLimitUsed: (() => {
      const value = Number(process.env.DEBRID_ACCOUNT_WARN_LIMIT_USED ?? 0.8);
      return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8;
    })(),
    // Auditoria proativa (fase D): no passe tardio, prova os top N candidatos
    // dublados em cache listando os arquivos reais no debrid. 0 desliga; a
    // prova em si continua sujeita a AUDIO_AUDIT=1.
    dubAuditTailMax: num(process.env.DEBRID_DUB_AUDIT_MAX, 2),
    // URL pública do addon, usada nos links de play resolvidos no debrid.
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    // Segredo do HMAC dos links /resolve. Vazio = assina com a API key de
    // debrid efetiva da requisição (basta pra uso de um usuário só).
    resolveSecret: process.env.RESOLVE_SECRET || '',
    // Play que descobre 451 invalida o cache de streams: a lista prometia ⚡
    // para hash que o serviço recusa, e ela só seria reconstruída no fim do
    // TTL. Debounce para uma rajada de plays bloqueados (usuário clicando
    // vários cards mortos em seguida) não esfriar o cache repetidamente.
    // 0 desliga a invalidação.
    resolveBlockedInvalidateCooldownMs: num(process.env.RESOLVE_BLOCKED_INVALIDATE_COOLDOWN_MS, 30000),
  },
  // Menor que o limite de 10s do cliente Stremio.
  searchTimeout: num(process.env.SEARCH_TIMEOUT_MS, 8000),
  // 10s é o teto dos DOIS clientes: o Stremio aborta a requisição de stream
  // nesse prazo e o Power Movie declara o mesmo (kStreamReceiveTimeoutSeconds).
  // 9200 usa a folga que sobrava e ainda deixa 800ms para rede e parse —
  // passar de ~9500 troca "lista parcial" por "erro de timeout", que é pior.
  replyDeadline: num(process.env.REPLY_DEADLINE_MS, 9200),
  // Fatia do deadline reservada pra checagem no debrid depois da coleta. O
  // 2800 antigo era dimensionado pela AllDebrid (270-290ms medidos) — mas quem
  // manda no prazo é o serviço mais lento da casa: Premiumize medido em
  // 1,9-4,7s no passo de resposta (mediana ~3,2s), e 2800 perdia a corrida na
  // maioria das buscas, degradando a lista inteira para known:false (sem ⚡
  // nenhum). 4500 cobre a mediana com folga e chega perto do pior caso; os
  // outliers de 6,5-7,5s ficam para o passe tardio, que re-checa sem teto
  // curto e regrava o cache. O custo é direto: a coleta cai de 6400 para
  // 4700ms, e fonte BR lenta passa a cair mais no passe tardio — que já é o
  // caminho dela (orçamento próprio de 20s). NÃO compense subindo o
  // REPLY_DEADLINE: o cliente Stremio aborta perto de 10s.
  debridReserve: num(process.env.DEBRID_RESERVE_MS, 4500),
  // Piso que a graça BR nunca invade: o que a checagem de cache precisa ter
  // sobrado, aconteça o que acontecer. Era literal (2000) dentro do cálculo da
  // graça, e por isso baixar a reserva encolhia a janela BR em vez de ampliá-la.
  debridCheckFloor: num(process.env.DEBRID_CHECK_FLOOR_MS, 1500),
  search: {
    // A busca complementar de pack fica no passe tardio: duas varreduras de
    // Jackett em série não cabem no deadline da resposta.
    packTail: String(process.env.SEARCH_PACK_TAIL || 'true') === 'true',
    // Episódio abaixo deste piso é fraco; o pack pode ter um swarm saudável.
    packMinSeeders: Math.max(0, Math.trunc(num(process.env.SEARCH_PACK_MIN_SEEDERS, 3))),
    // Sem uma fonte tocável, explica ao cliente por que a lista não ficou vazia.
    noticeStream: String(process.env.SEARCH_NOTICE_STREAM || 'true') === 'true',
  },
  // Semente do colhedor pela lista de populares do IMDb (RapidAPI). Sem
  // RAPIDAPI_KEY o modulo e inerte: nao faz requisicao nenhuma. O teto por
  // ciclo e pequeno de proposito — o gargalo e a vazao do colhedor (~4
  // obras/hora), nao a cota da API (10.000 requisicoes por periodo contra 2
  // requisicoes por dia).
  seed: {
    enabled: String(process.env.SEED_ENABLED || 'true') === 'true',
    apiKey: process.env.RAPIDAPI_KEY || '',
    host: process.env.RAPIDAPI_IMDB_HOST || 'imdb236.p.rapidapi.com',
    maxPerCycle: Math.max(0, Math.trunc(num(process.env.SEED_MAX_PER_CYCLE, 20))),
    // Piso de votos: popular sem publico e ruido de metadado.
    minVotes: Math.max(0, Math.trunc(num(process.env.SEED_MIN_VOTES, 1000))),
    intervalH: Math.max(1, Math.trunc(num(process.env.SEED_INTERVAL_H, 24))),
    timeoutMs: num(process.env.SEED_TIMEOUT_MS, 8000),
  },
  magnetDb: {
    enabled: String(process.env.MAGNET_DB || 'true') === 'true',
    aliveTtl: num(process.env.MAGNET_ALIVE_TTL, 7 * 24 * 3600),
    badTtl: num(process.env.MAGNET_BAD_TTL, 24 * 3600),
    // "Lie" não é bad: há vídeo, mas os paths provaram release EN apesar da
    // promessa de áudio PT no post. É evidência própria, por conta.
    lieEnabled: String(process.env.MAGNET_LIE || 'true') === 'true',
    lieTtl: num(process.env.MAGNET_LIE_TTL, 7 * 24 * 3600),
  },
  // Listas calibráveis sem deploy. Ausência de PT nunca condena sozinha: o
  // veredito ainda exige um marcador forte de release EN.
  audioAudit: {
    enabled: String(process.env.AUDIO_AUDIT || 'true') === 'true',
    ptMarkers: list(
      process.env.AUDIO_AUDIT_PT_MARKERS ||
        'dublado,dublada,dublagem,dubbed,dual audio,pt br,ptbr,portugues,portuguese,nacional,fleg',
    ),
    enGroups: list(
      process.env.AUDIO_AUDIT_EN_GROUPS ||
        'rarbg,killers,ettv,afm72,tovar,evo,megusta,galaxyrg,glxrc,yts,fgt,amzn,dsnp,smi,ntb,roarb,oxy,bae,drs,huzzah',
    ),
  },
  // Webhooks operacionais: alerta de credenciais recusadas, indexers BR offline
  // e aviso proativo de quota de magnets.
  notify: {
    enabled: String(process.env.NOTIFY_ENABLED || 'true') !== 'false',
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
    cooldownS: num(process.env.NOTIFY_COOLDOWN_S, 3600),
    magnetsWarn: num(process.env.NOTIFY_MAGNETS_WARN, 900),
  },
};

export default config;
