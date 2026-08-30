import { list, num } from './helpers.js';

// Fábrica (não objeto pronto): módulo ESM é cacheado, e cada re-avaliação do
// compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Camada de debrid: serviço, checagem de cache, limpeza, autofetch, sonda e
// paridade Real-Debrid (gate/ledger/oráculo/warmer).
export const debrid = () => ({
  // premiumize | realdebrid | alldebrid | torbox | debridlink
  // Vazio = modo P2P puro (infoHash direto). A lista viva está em src/debrid/index.js.
  service: (process.env.DEBRID_SERVICE || '').toLowerCase(),
  apiKey: process.env.DEBRID_API_KEY || '',
  // Em instância pública, não deixe uma instalação sem config gastar a conta
  // do operador. O default preserva o modo de usuário único já existente.
  // Este gate autoriza SÓ a HERANÇA da chave para instalações sem dk
  // (runtime.ts); as features de operador (catálogo, varreduras, painel,
  // warmer) usam `envOperatorAccount` abaixo, que é o OU com o flag próprio.
  allowEnvKey: String(process.env.DEBRID_ALLOW_ENV_KEY || 'true') === 'true',
  // Features de operador sobre a conta do .env SEM herdar a chave para
  // installs: instância pública com ALLOW_ENV_KEY=false + OPERATOR_ENV_ACCOUNT
  // = true deixa o painel/catálogo funcionando e o anônimo em P2P puro.
  operatorEnvAccount: String(process.env.DEBRID_OPERATOR_ENV_ACCOUNT || 'false') === 'true',
  // Gate das features de OPERADOR (catalog-env, env-ops, account-status,
  // inventory warmup, harvester quota-warn, br-coverage, rd-warmer). Getter
  // (não valor congelado) porque o OU precisa refletir os campos vivos — os
  // testes mutam os campos do singleton, e um booleano pré-calculado na
  // fábrica dessincronizaria do par de flags real.
  get envOperatorAccount() {
    return this.allowEnvKey || this.operatorEnvAccount;
  },
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
  // Proteção durável dos BR no AllDebrid (`adprot:v1`): o hold volátil morre
  // no restart, e sem uma marca persistida a limpeza apagava do acervo o que o
  // autofetch subiu para o usuário. O custo é um registro por hash retido na
  // conta (BR tocável — `any`/`seeds` não entram). `false` desliga a proteção.
  autoFetchProtectBr: String(process.env.DEBRID_AUTO_FETCH_PROTECT_BR || 'true') === 'true',
  // Por quanto tempo o registro durável fica de pé. 10 anos é "até o acervo
  // deixar de ser dela": a retirada real é o estado terminal (dead/stalled/
  // expired) ou o `DubLieError`, não o relógio. Clamp >=1s.
  autoFetchProtectBrTtl: Math.max(1, num(process.env.DEBRID_AUTO_FETCH_PROTECT_BR_TTL, 315_360_000)),
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
});
