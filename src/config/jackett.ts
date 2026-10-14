import { indexerList, list, num } from './helpers.js';

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
  // LimeTorrents (id Jackett: limetorrents) é global EN — some nesta lista,
  // nunca em ptBr/slow/index-only: Cloudflare/Flare aborta tarde no Chromium.
  indexers: indexerList(process.env.JACKETT_INDEXERS),
  // Sem JACKETT_INDEXERS no .env, a lista padrão vem do próprio Jackett (todo
  // indexer configurado): o catálogo vivo preenche `indexers` no lugar
  // (`jackett-catalog.ts`). Adicionar/remover indexer no Jackett basta; o .env
  // explícito continua mandando quando existe.
  indexersAuto: !String(process.env.JACKETT_INDEXERS || '').trim(),
  indexerTimeout: num(process.env.JACKETT_INDEXER_TIMEOUT_MS, 4000),
  catalogTtl: num(process.env.JACKETT_CATALOG_TTL, 900),
  // Quanto tempo a última medição real aparece na configuração. O status
  // vem de busca/teste já executado; abrir a página nunca sonda os sites.
  statusTtl: num(process.env.JACKETT_STATUS_TTL, 900),
  // Cardigann pode entregar o magnet apenas no endpoint Link. Resolvemos
  // sob demanda somente nos indexadores localmente permitidos — opt-in por
  // indexer, nunca um "resolva todos os globais": cada entrada custa um
  // salto HTTP dentro do orçamento do indexer na resposta. Os cinco BR e o
  // MagnetDownload entregam Link em vez de magnet: fora desta lista, o
  // resultado é descartado por falta de infoHash. O MagnetDownload usa um
  // `/dl` lazy mesmo na definição stock; sem este opt-in todo o acervo chega
  // intocável. limetorrents e 1337x entraram medidos no caso real "The
  // Rejuvenator" (1988): ambos entregam `/dl/<indexer>/...` sem infoHash e o
  // endpoint Jackett responde 302 para o magnet, sem protetor de link nem
  // Chromium. Para o limetorrents o salto é barato; para o 1337x o redirect
  // /dl medido custa 1,8–6,5s — caro para a resposta ao vivo (é por isso que
  // ele é index-only), mas aceitável no play e no colhedor, onde não há
  // orçamento de resposta. Operador que define a env explícita substitui o
  // default inteiro (a escolha explícita vence).
  resolveDownloadIndexers: indexerList(
    process.env.JACKETT_RESOLVE_DOWNLOAD_INDEXERS ||
      'comandotorrents,nerdfilmes,bludv-cardigann,torrentdosfilmesv2,vacatorrent,magnetdownload,' +
      'limetorrents,1337x',
  ),
  resolveConcurrency: num(process.env.JACKETT_RESOLVE_CONCURRENCY, 10),
  maxDownloadResolves: num(process.env.JACKETT_MAX_DOWNLOAD_RESOLVES, 20),
  downloadTimeout: num(process.env.JACKETT_DOWNLOAD_TIMEOUT_MS, 8000),
  // O Link do indexer é input externo; destinos locais são SSRF salvo quando
  // o operador explicitamente usa um resolvedor privado nesse caminho.
  allowPrivateDownloadIps: String(process.env.JACKETT_ALLOW_PRIVATE_DOWNLOAD_IPS || 'false') === 'true',
  ptBrIndexers: indexerList(
    // redetorrent-cardigann e apachetorrent-cardigann são os cards LOCAIS (os
    // resolvers embutidos nas portas 8705/8706; os indexers stock do Jackett
    // foram aposentados): recebem a query em pt-BR e entregam magnet direto,
    // mas sem SxxEyy — o strip acontece em queryIndexer para todos os desta
    // lista. Nenhum dos dois entra em resolveDownloadIndexers: o magnet já é o
    // href da linha sintética, não há endpoint Link a salvar.
    // hdrtorrent-cardigann é o card LOCAL (resolver na porta 8707): a busca
    // nativa do hdrtorrents.net devolve a homepage, então o resolver raspa as
    // páginas de listagem e casa a query contra o catálogo em cache. Magnets
    // diretos no post, sem protetor de link.
    process.env.JACKETT_PT_BR_INDEXERS ||
      'bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,vacatorrent,redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann',
  ),
  // Buscadores que zeram com QUALQUER token extra: além do SxxEyy, o ano do
  // filme também sai ("Coringa 2019" → 0 no buscador do apachetorrent). O
  // redetorrent-cardigann é igual, e os dois resolvers locais também normalizam
  // do lado deles (defesa dupla). Os outros resolvers locais ficam FORA desta
  // lista: lá o ano ajuda a relevância.
  bareTitleIndexers: indexerList(
    process.env.JACKETT_BARE_TITLE_INDEXERS || 'redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann',
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
  // NÃO adicione aqui os que passam por FlareSolverr (kickasstorrents,
  // limetorrents): não é questão de orçamento. O desafio Cloudflare é
  // re-resolvido a CADA busca e foi medido em 20s (kickass.ws) e 24s
  // (kickass.to) só pra abrir a primeira página — depois disso o Jackett
  // ainda tem que raspar os resultados. Com 20s eles abortavam igual, só mais
  // tarde, gastando Chromium à toa. Fora da lista de indexers é o lugar deles.
  // O 1337x também usa FlareSolverr e era o exemplo clássico aqui; hoje ele
  // vive no JACKETT_INDEX_ONLY_INDEXERS (isolamento mais forte: NENHUMA
  // consulta ao vivo, só colhedor) — não o traga de volta para slow.
  slowIndexers: indexerList(
    process.env.JACKETT_SLOW_INDEXERS || 'bludv-cardigann,redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann',
  ),
  // Fora do caminho da resposta, DENTRO do sistema: estes indexers não
  // recebem busca ao vivo de nenhum usuário. Alimentam o índice pelo COLHEDOR,
  // que tem fila persistente, orçamento largo e cujas falhas não pintam card —
  // e a busca ao vivo serve do índice quando ele cobre a obra. Separado de
  // JACKETT_SLOW_INDEXERS de propósito: lá o problema é o agrupamento do
  // plano; aqui é PRESENÇA na resposta.
  //
  // Os 8–31s que justificavam a entrada dos três cardigann BR eram dos
  // indexers STOCK do Jackett, hoje aposentados. Os cards LOCAIS que os
  // substituíram são rápidos (medido 2026-09-20, query fria, por indexer):
  // apachetorrent 1,5–4,2s (p50 ~2,4s), redetorrent 0,65–1,4s, hdrtorrent
  // 0,01–0,03s. Latência sozinha já NÃO sustenta a lista — o que sustenta é
  // que a coleta viva tem 4700ms (budgets().debridReserve comeu o resto) e o
  // passe tardio, com orçamento próprio de 20s, é o caminho natural deles.
  //
  // Os três NÃO são a mesma classe de risco, e a diferença importa para quem
  // pensar em promover algum ao vivo:
  //   - apachetorrent/hdrtorrent: fetch DIRETO, sem Cloudflare. São os únicos
  //     candidatos defensáveis — se o orçamento da coleta subir, comece por
  //     aqui e meça de novo;
  //   - redetorrent: atrás de Cloudflare via FlareSolverr (ver
  //     resolvers/profiles/redetorrent.ts). A sessão de 20min esconde o custo
  //     na medição morna, mas fria ele entra na fila SERIAL do FlareSolverr e
  //     atrasa todo mundo. Não promova pelo número acima.
  //
  // O buraco que a lista abre é conhecido e tem dono: obra nunca colhida mostra
  // o dublado só na SEGUNDA abertura. Quem fecha isso é a sonda dirigida
  // (br-probe.ts, interseção indexOnlyIndexers ∩ ptBrIndexers) somada ao
  // instantâneo do banco de magnets — não uma consulta viva a estes indexers.
  //
  // O 1337x entrou medido: busca fria de 12,2–19s (com re-resolução do
  // desafio Cloudflare) e redirect `/dl/` de 1,8–6,5s contra orçamento de
  // 4s — nem background:true nem index-only resolvem isoladamente quando ele
  // entra na varredura pt-BR tardia; por isso ele também fica fora dela. A
  // resolução do magnet permanece (JACKETT_RESOLVE_DOWNLOAD_INDEXERS) e o
  // colhedor o consulta individualmente com orçamento dedicado
  // (JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS).
  indexOnlyIndexers: indexerList(
    process.env.JACKETT_INDEX_ONLY_INDEXERS || 'redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann,magnetdownload,1337x',
  ),
  // Exceção de PRESENÇA no plano ao vivo: indexers que continuam sendo
  // index-only para todos os outros fins (allowedSourceIndexer não filtra por ji,
  // magnet-bank-instant aceita passed_filter=0, colhedor dedica timeout de 35s),
  // mas que PASSAM a ser consultados na resposta ao vivo.
  //
  // Medição de 2026-09-20 (15 amostras frias):
  //   - apachetorrent-cardigann: 1,48–5,02s (p50 ~3,2s). Fetch direto, sem
  //     Cloudflare. Janela da resposta = computeCollectionBudget (~4700ms) +
  //     graça da 1ª fonte BR (1500ms) = ~6200ms. O máximo (5,02s) cabe nela!
  //   - redetorrent-cardigann: 0,65–1,4s morno, mas usa FlareSolverr serial
  //     (resolvers/profiles/redetorrent.ts); fila fria atrasa resposta. Fica fora.
  //   - hdrtorrent-cardigann: 0,007–0,03s, mas catálogo frio devolve vazio e só
  //     geraria wastedQueries e card verde mentindo cobertura. Fica fora.
  //
  // ?? e não ||: string vazia permite kill-switch total via env.
  liveExemptIndexers: indexerList(
    process.env.JACKETT_LIVE_EXEMPT_INDEXERS ?? 'apachetorrent-cardigann',
  ),
  // Orçamento TOTAL (busca + resolução `/dl`) de UMA consulta do colhedor a
  // um indexer index-only. Aplicado SÓ no colhedor/fundo: a busca ao vivo
  // nunca consulta index-only (o filtro liveIndexers roda antes do plano) e
  // indexer comum continua com budgetFor (indexerTimeout/brIndexerTimeout).
  // O 1337x medido precisa de 12–19s frio. O magnetdownload (2026-09-24):
  // busca ~10s e cada salto `/dl` de 7s a 60s+; com 35s quase nenhum
  // resultado virava magnet. 90s é trabalho de fundo, sem usuário esperando.
  indexOnlyHarvestTimeout: Math.min(
    120_000,
    Math.max(5_000, Math.trunc(num(process.env.JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS, 90_000))),
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
