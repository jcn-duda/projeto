import { list, num } from './helpers.js';

// Fábricas (não objetos prontos): módulo ESM é cacheado, e cada re-avaliação
// do compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Coleta em fundo: warmup, índice de releases, fast-path da conta, colhedor,
// sementes IMDb e Fase 3 (cobertura BR ⚡).
export const warmup = () => ({
  // Catálogo curado para aquecer raw antes do primeiro usuário. O operador
  // pode substituir a lista pelo perfil real de consumo da instância.
  enabled: String(process.env.WARMUP_ENABLED || 'true') === 'true',
  titles: list(process.env.WARMUP_TITLES || 'tt7286456:movie,tt11198330:movie,tt1630029:movie,tt11126994:series,tt3581920:series,tt2861424:series'),
  concurrency: num(process.env.WARMUP_CONCURRENCY, 2),
  indexerDelayMs: num(process.env.WARMUP_INDEXER_DELAY_MS, 250),
  timeoutMs: num(process.env.WARMUP_TIMEOUT_MS, 600000),
  // BR/slow têm orçamento de 20s; no boot o padrão aquece só globais.
  skipSlow: String(process.env.WARMUP_SKIP_SLOW || 'true') === 'true',
});

// Índice de releases por obra (`idx:v6`): o que a busca já provou existir,
// filtrado e dedupado por hash. Compartilhado entre instalações DE PROPÓSITO —
// guarda o que EXISTE, nunca o que está pronto em qual conta (isso é
// davail/mag, escopados por conta). RELEASE_INDEX=false desliga a escrita E a
// leitura; RELEASE_INDEX_TTL=0 idem.
export const releaseIndex = () => ({
  enabled: String(process.env.RELEASE_INDEX || 'true') === 'true',
  // Release não deixa de existir por envelhecer — quem a desqualifica é o
  // mag/dead, não o relógio. O TTL longo é só esquecimento lento.
  ttl: num(process.env.RELEASE_INDEX_TTL, 30 * 24 * 3600),
  // Teto de releases por obra: pack de temporada + encodes não podem virar
  // uma entrada gigante (cota de 4.000 chaves assume ~8 KB por chave).
  maxReleases: num(process.env.RELEASE_INDEX_MAX_RELEASES, 60),
});

// Fast-path da conta: se o inventário do debrid sozinho entrega releases
// suficientes da obra pedida, a resposta sai na hora e o Jackett vai para o
// tail enriquecer. Título novo continua no caminho normal.
export const accountFastPath = () => ({
  enabled: String(process.env.ACCOUNT_FAST_PATH || 'true') === 'true',
  // Menor que isso não é "suficiente": uma release só pode ser um pack
  // ambíguo ou encode ruim; o tail enriquece de qualquer forma.
  minReleases: num(process.env.ACCOUNT_FAST_MIN_RELEASES, 2),
  // Espera máxima pela conta na resposta imediata do fast-path (a primeira
  // leitura do inventário custa ~700ms; depois vem do memo, ~0ms).
  waitMs: num(process.env.ACCOUNT_FAST_WAIT_MS, 450),
});

// Colhedor: generalização do warmup. Fila de obras colhidas em fundo, com
// orçamento largo (ninguém está esperando) e freio de atividade em janela
// deslizante — colher só enquanto ninguém usa há N minutos.
export const harvest = () => ({
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
  // Priorizacao da fila por evidencia BR (Fase 3.2): obra com sinal de
  // conteudo BR dublado (play do usuario = next-episode, ou indice ja com
  // release BR dublada) sai na frente, para o BR chegar ao indice — e dai
  // ao warmer que gera o raio — antes de obra sem BR. Desligar restaura a
  // ordem FIFO exata. O contrapeso `brMaxWaitMs` impede fome da obra
  // pedida: obra sem evidencia BR esperando alem do prazo sobe para a frente.
  brFirst: String(process.env.HARVEST_BR_FIRST || 'true') === 'true',
  // Prazo maximo que uma obra sem evidencia BR pode esperar (fome-bound).
  // 0 desliga o prazo (rotulo de quem aceita starvation).
  brMaxWaitMs: Math.max(0, num(process.env.HARVEST_BR_MAX_WAIT_MS, 6 * 3600 * 1000)),
  quotaWarnCooldownMs: Math.max(0, num(process.env.HARVEST_QUOTA_WARN_COOLDOWN_MS, 6 * 3600 * 1000)),
});

// Semente do colhedor pela lista de populares do IMDb (RapidAPI). Sem
// RAPIDAPI_KEY o modulo e inerte: nao faz requisicao nenhuma. O teto por
// ciclo e pequeno de proposito — o gargalo e a vazao do colhedor (~4
// obras/hora), nao a cota da API (10.000 requisicoes por periodo contra 2
// requisicoes por dia).
export const seed = () => ({
  enabled: String(process.env.SEED_ENABLED || 'true') === 'true',
  apiKey: process.env.RAPIDAPI_KEY || '',
  host: process.env.RAPIDAPI_IMDB_HOST || 'imdb236.p.rapidapi.com',
  maxPerCycle: Math.max(0, Math.trunc(num(process.env.SEED_MAX_PER_CYCLE, 20))),
  // Piso de votos: popular sem publico e ruido de metadado.
  minVotes: Math.max(0, Math.trunc(num(process.env.SEED_MIN_VOTES, 1000))),
  intervalH: Math.max(1, Math.trunc(num(process.env.SEED_INTERVAL_H, 24))),
  timeoutMs: num(process.env.SEED_TIMEOUT_MS, 8000),
});

// Fase 3 — cobertura BR com raio: baseline, priorizacao do colhedor e decisao
// de vazao. A 3.1 e observabilidade pura (metrica em memoria, zero mudanca de
// comportamento); o sampler `f3.br` varre o indice periodicamente e conta
// quantas obras com BR dublada no indice ja tem raio confirmado (ledger RD hit,
// davail positivo ou magnetdb alive para a conta do operador).
export const f3 = () => ({
  enabled: String(process.env.F3_ENABLED || 'true') === 'true',
  br: {
    enabled: String(process.env.F3_BR_ENABLED || 'true') === 'true',
    sampleMs: Math.max(30_000, num(process.env.F3_BR_SAMPLE_MS, 5 * 60_000)),
    // Teto por tipo na coorte popular do baseline: quantos IDs (filmes E
    // séries) entram em `popularCohort` para medir a cobertura BR. Cada
    // lista IMDb devolve 100 títulos; o default 100 é o top completo. 1..100.
    topPerType: Math.min(100, Math.max(1, Math.trunc(num(process.env.F3_BR_TOP_PER_TYPE, 100)))),
  },
});
