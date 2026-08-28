import { DEFAULT_CACHE_DB_PATH, DEFAULT_CATALOG_DB_PATH, num } from './helpers.js';

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
