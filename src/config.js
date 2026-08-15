require('dotenv').config();

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function list(value) {
  if (!value || !String(value).trim()) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    ptBrIndexers: list(
      // redetorrent é definição stock do Jackett (sem resolver local): entrega
      // magnet/infoHash direto, mas a query precisa ir sem SxxEyy — o strip
      // acontece em queryIndexer para todos os desta lista.
      process.env.JACKETT_PT_BR_INDEXERS ||
        'bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,redetorrent,apachetorrent',
    ),
    // Buscadores WordPress stock que zeram com QUALQUER token extra: além do
    // SxxEyy, o ano do filme também sai ("Coringa 2019" → 0 no redetorrent,
    // "Coringa" → 34). Os resolvers locais ficam FORA desta lista: lá o ano
    // ajuda a relevância e o strip de SxxEyy já acontece no servidor deles.
    bareTitleIndexers: list(
      process.env.JACKETT_BARE_TITLE_INDEXERS || 'redetorrent,apachetorrent',
    ),
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
      process.env.JACKETT_SLOW_INDEXERS || 'bludv-cardigann,redetorrent,apachetorrent',
    ),
  },
  prowlarr: {
    url: (process.env.PROWLARR_URL || 'http://127.0.0.1:9696').replace(/\/$/, ''),
    apiKey: process.env.PROWLARR_API_KEY || '',
  },
  tmdb: {
    apiKey: process.env.TMDB_API_KEY || '',
    timeout: num(process.env.TMDB_TIMEOUT_MS, 5000),
    cacheTtl: num(process.env.TMDB_CACHE_TTL, 604800), // 7 dias
  },
  cinemeta: {
    // O Cinemeta roda antes da coleta. Deixá-lo esperar o teto inteiro do
    // cliente consumiria o deadline sem sequer consultar os indexers; após
    // este prazo a busca degrada para o título do TMDB ou para o IMDb id.
    timeout: num(process.env.CINEMETA_TIMEOUT_MS, 2500),
  },
  resolvers: {
    embedded: String(process.env.BR_RESOLVERS_EMBEDDED || 'true') === 'true',
    host: process.env.BR_RESOLVERS_HOST || '127.0.0.1',
    bludvUrl: (process.env.BLUDV_URL || 'https://bludvfilmes.xyz').replace(/\/$/, ''),
    comandotorrentsUrl: (process.env.COMANDOTORRENTS_URL || 'https://comandotorrents.to').replace(/\/$/, ''),
    nerdfilmesUrl: (process.env.NERDFILMES_URL || 'https://www.xnerdfilmes.net').replace(/\/$/, ''),
    torrentdosfilmesUrl: (process.env.TORRENTDOSFILMES_URL || 'https://torrentdosfilmes-v2.xyz').replace(/\/$/, ''),
    extraProtectors: list(process.env.EXTRA_ALLOWED_PROTECTORS),
  },
  bludv: {
    enabled: String(process.env.BLUDV_ENABLED || 'false') === 'true',
    // bludv.net é o alias estável; o site troca de domínio com frequência.
    baseUrl: (process.env.BLUDV_URL || 'https://bludv.net').replace(/\/$/, ''),
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
  qualityFilter: list(process.env.QUALITY_FILTER),
  minSeeders: num(process.env.MIN_SEEDERS, 1),
  maxResults: num(process.env.MAX_RESULTS, 40),
  qualityLimits: {
    '2160p': num(process.env.MAX_STREAMS_2160P, 4),
    '1080p': num(process.env.MAX_STREAMS_1080P, 4),
    '720p': num(process.env.MAX_STREAMS_720P, 4),
    '480p': num(process.env.MAX_STREAMS_480P, 4),
    SD: num(process.env.MAX_STREAMS_SD, 4),
    unknown: num(process.env.MAX_STREAMS_UNKNOWN, 4),
  },
  // Teto de streams por indexador no resultado final (0 = sem limite). Impede
  // que uma fonte com muitos resultados ocupe quase todas as vagas. As vagas
  // reservadas BR não contam para esta cota.
  maxPerIndexer: num(process.env.MAX_STREAMS_PER_INDEXER, 0),
  // Quantos candidatos considerar antes do filtro do debrid.
  candidatePoolFactor: num(process.env.CANDIDATE_POOL_FACTOR, 4),
  // Vagas garantidas para fontes BR dubladas no resultado final.
  brReservedSlots: num(process.env.BR_RESERVED_SLOTS, 6),
  // Se o orçamento normal terminou só com globais, espera um pouco pela
  // primeira fonte BR. Algumas UIs não repetem a resposta parcial, então o
  // passe tardio sozinho não torna o dublado visível na lista já aberta.
  brPartialGrace: num(process.env.BR_PARTIAL_GRACE_MS, 1500),
  cacheTtl: num(process.env.CACHE_TTL, 900),
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
    batchSize: num(process.env.DEBRID_BATCH_SIZE, 100),
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
    // Remove da conta do debrid o que não está em cache. Sem isso cada consulta
    // deixa um download rodando lá (AllDebrid só informa cache ao dar upload).
    dropUncached: String(process.env.DEBRID_DROP_UNCACHED || 'true') === 'true',
    timeout: num(process.env.DEBRID_TIMEOUT_MS, 6000),
    // Sem fonte BR dublada em cache, manda o serviço baixar a melhor. O TTL vale
    // pra duas coisas: não reenviar o mesmo torrent a cada busca e por quanto
    // tempo ele fica protegido do dropUncached.
    autoFetchBr: String(process.env.DEBRID_AUTO_FETCH_BR || 'true') === 'true',
    autoFetchTtl: num(process.env.DEBRID_AUTO_FETCH_TTL, 6 * 3600),
    // URL pública do addon, usada nos links de play resolvidos no debrid.
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    // Segredo do HMAC dos links /resolve. Vazio = assina com a API key de
    // debrid efetiva da requisição (basta pra uso de um usuário só).
    resolveSecret: process.env.RESOLVE_SECRET || '',
  },
  // Menor que o limite de 10s do cliente Stremio.
  searchTimeout: num(process.env.SEARCH_TIMEOUT_MS, 8000),
  // 10s é o teto dos DOIS clientes: o Stremio aborta a requisição de stream
  // nesse prazo e o Power Movie declara o mesmo (kStreamReceiveTimeoutSeconds).
  // 9200 usa a folga que sobrava e ainda deixa 800ms para rede e parse —
  // passar de ~9500 troca "lista parcial" por "erro de timeout", que é pior.
  replyDeadline: num(process.env.REPLY_DEADLINE_MS, 9200),
  // Fatia do deadline reservada pra checagem no debrid depois da coleta. Com
  // 2000 ela não cobria nem o caso rápido (~2,6s) e a coleta comia o prazo
  // inteiro. 3500 era dimensionado pelo pior caso do Premiumize (75 hashes com
  // o event loop travado pelos resolvedores BR); medido na AllDebrid a checagem
  // leva 270-290ms, então 2800 continua com folga de 10x e devolve 700ms para a
  // coleta — que é onde as fontes BR disputam a primeira resposta.
  debridReserve: num(process.env.DEBRID_RESERVE_MS, 2800),
  // Piso que a graça BR nunca invade: o que a checagem de cache precisa ter
  // sobrado, aconteça o que acontecer. Era literal (2000) dentro do cálculo da
  // graça, e por isso baixar a reserva encolhia a janela BR em vez de ampliá-la.
  debridCheckFloor: num(process.env.DEBRID_CHECK_FLOOR_MS, 1500),
};

module.exports = config;
