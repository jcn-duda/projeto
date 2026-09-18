import { DEFAULT_CACHE_DB_PATH, DEFAULT_CATALOG_DB_PATH, DEFAULT_MAGNET_BANK_DB_PATH, num } from './helpers.js';

// Fábricas (não objetos prontos): módulo ESM é cacheado, e cada re-avaliação
// do compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
export const cacheBase = () => ({
  cacheTtl: num(process.env.CACHE_TTL, 900),
  // Janela de graça do stale-while-revalidate das listas de stream (Fase 2):
  // depois do CACHE_TTL, a entrada expirada ainda é servida na hora enquanto
  // um refresh de fundo a reconstrói. Só vale para lista completa com debrid
  // conferido e stream tocável. 0 volta à semântica dura (expirou = busca nova).
  streamStaleGrace: num(process.env.STREAM_STALE_GRACE_SECONDS, 300),
  // TTL da lista que CONTÉM item de fallback do banco de magnets (Etapa 4): a
  // reserva é foto do acervo, não medição viva — nunca ganha o TTL cheio nem é
  // promovida a completa enquanto o indexer falho não responder. Curto para a
  // próxima abertura já reconsultar o vivo (o handler força cacheMaxAge 0 via
  // `partial`, que a entrada de fallback também carrega).
  fallbackStreamsTtl: Math.max(0, num(process.env.FALLBACK_STREAMS_TTL, 120)),
});

export const rawCache = () => ({
  // Cache do resultado BRUTO da busca (sem credencial nem config do usuário):
  // duas instalações com configs diferentes do mesmo título passam a
  // compartilhar a raspagem do Jackett/BLUDV. 0 desliga cada camada.
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
});

export const cache = () => ({
  // Memória é sempre L1; SQLite só preserva o aquecimento entre restarts.
  persist: String(process.env.CACHE_PERSIST || 'true') !== 'false',
  dbPath: process.env.CACHE_DB_PATH || DEFAULT_CACHE_DB_PATH,
});

// Catálogo durável da conta AllDebrid (o cache destrói conhecimento por
// cota/TTL/bump de namespace; catálogo é HISTÓRICO, separado de propósito).
export const catalog = () => ({
  dbPath: process.env.CATALOG_DB_PATH || DEFAULT_CATALOG_DB_PATH,
  // Idade mínima para a limpeza automática de estrangeiro provado tocar um
  // magnet. 48h é o limite operacional: o acervo da AllDebrid se recicla em
  // até ~3 dias, então 7d nunca liberava nada; duas janelas de observação
  // (48h) ainda descartam o download que acabou de ser aquecido.
  cleanupMinAgeMs: num(process.env.CATALOG_CLEANUP_MIN_AGE_MS, 48 * 3600 * 1000),
  // Teto de magnets por rodada da limpeza de estrangeiro provado.
  cleanupMaxPerRound: Math.max(0, Math.trunc(num(process.env.CATALOG_CLEANUP_MAX, 100))),
  // Teto de linhas por rodada da auditoria de arquivos (quem ainda não tem
  // evidência de áudio no release-index).
  auditMaxPerRound: Math.max(0, Math.trunc(num(process.env.CATALOG_AUDIT_MAX, 20))),
  // Workers paralelos da auditoria de arquivos (1..3).
  auditConcurrency: Math.min(3, Math.max(1, Math.trunc(num(process.env.CATALOG_AUDIT_CONCURRENCY, 2)))),
});

// Banco de magnets VIVO (clone permanente): SQLite próprio em data/magnets.db,
// sem cota, sem TTL e sem bump de namespace — é acervo, não cache. Os flags de
// fila valem já na Etapa 2; os de fallback ficam declarados aqui para o knob
// existir no `.env` antes da feature (Etapa 4), sem nenhum caminho os consumir.
export const magnetBank = () => ({
  enabled: String(process.env.MAGNET_BANK || 'true') !== 'false',
  dbPath: process.env.MAGNET_BANK_DB_PATH || DEFAULT_MAGNET_BANK_DB_PATH,
  // Teto de LINHAS da engine de MEMÓRIA (o fallback quando `node:sqlite` não
  // existe — Node 20 — ou o arquivo não abre). A unidade é magnets/hashes: o
  // SQLite é permanente e NÃO tem cota, mas o `Map` de memória cresceria com o
  // acervo inteiro até o OOM. 20000 é conservador porque a entrada daqui é
  // maior que a do cache (URI + título) e o fallback só roda onde não há
  // SQLite. Mínimo 1: NÃO existe modo ilimitado — desligar o teto reabriria o
  // vazamento que ele existe para fechar.
  memoryMax: Math.max(1, Math.trunc(num(process.env.MAGNET_BANK_MEMORY_MAX, 20000))),
  // Teto da fila de captura. A gravação é uma transação em lote por busca, fora
  // do caminho da resposta; encheu, a captura é descartada com métrica
  // (`magnetbank.queue.dropped`) — a busca nunca espera o disco.
  queueMax: Math.max(1, Math.trunc(num(process.env.MAGNET_BANK_QUEUE_MAX, 500))),
  // Memo do status do painel (ms): `stats()` no /dashboard-status.json é
  // agregação O(rows) (COUNT/MAX/GROUP BY) e o poll repetia a varredura a cada
  // ciclo. O memo serve a MESMA foto por esta janela — invalidado a cada
  // escrita efetiva (flush) e no reset. 0 desliga (recalcula a cada leitura).
  statusTtlMs: Math.max(0, num(process.env.MAGNET_BANK_STATUS_TTL_MS, 60000)),
  /** Fallback quando o indexer falha (Etapa 4). */
  fallbackEnabled: String(process.env.MAGNET_BANK_FALLBACK || 'true') !== 'false',
  // Teto por indexer falho (1..40). O item de fallback é reserva; acima disso a
  // conta do debrid vira depósito de candidato que o vivo provavelmente já tem.
  fallbackMaxPerIndexer: Math.min(40, Math.max(1, Math.trunc(num(process.env.MAGNET_BANK_FALLBACK_MAX, 40)))),
  // Teto GLOBAL da reserva (1..500): sem ele, N indexers falhos × 40 encheriam o
  // lote e a checagem do debrid. Conservador por default (igual ao por-indexer).
  fallbackGlobalMax: Math.min(500, Math.max(1, Math.trunc(num(process.env.MAGNET_BANK_FALLBACK_GLOBAL_MAX, 40)))),
});
