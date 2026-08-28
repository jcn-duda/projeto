import { list, num } from './helpers.js';

// Fábrica (não objeto pronto): módulo ESM é cacheado, e cada re-avaliação do
// compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Jackett: indexers, orçamentos de timeout, breaker e listas especiais.
export const jackett = () => ({
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
  // Os cinco entregam Link em vez de magnet: fora desta lista, o resultado
  // é descartado por falta de infoHash. Com só dois aqui, bludv e
  // torrentdosfilmes perdiam ~2/3 do que achavam.
  resolveDownloadIndexers: list(
    process.env.JACKETT_RESOLVE_DOWNLOAD_INDEXERS ||
      'comandotorrents,nerdfilmes,bludv-cardigann,torrentdosfilmesv2,vacatorrent',
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
      'bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,vacatorrent,redetorrent,apachetorrent,hdrtorrent',
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
});
