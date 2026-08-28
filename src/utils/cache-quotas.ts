/**
 * Política de cotas do cache multi-nível — módulo PURO, sem estado.
 *
 * A regra que não pode voltar atrás: a repartição por namespace acontece
 * ANTES de qualquer despejo global — reintroduzir o despejo global antes da
 * repartição foi bug real (um burst de dlmag desalojava streams).
 *
 * O L1 (Map `store`) e os contadores por namespace pertencem ao ponto de
 * entrada (cache.ts) e entram aqui como parâmetro: módulo irmão com estado
 * próprio quebraria o cache-busting dos testes (`cache.js?query` criaria uma
 * instância nova de cache.ts reusando o irmão cacheado, com o store alheio).
 */

// A soma das cotas de namespaces conhecidos é 33.050 (inclui rdc=14.000,
// rdq=500, rdt=2.500 e adprot=2.000), deixando 2.950 entradas de folga sob o
// teto global. O ledger RD
// é global por hash e precisa reter muito mais histórico que os caches por conta;
// os demais baldes foram calibrados para abrir esse espaço sem deixar o despejo
// global invalidar suas cotas antes da hora. Memória: o raw domina (800 × ~100 KB
// ≈ 79 MB no pior caso); rdc/davail/mag/rdt/adprot guardam só registros minúsculos.
export const MAX_ENTRIES = 36000;
export const QUOTAS: Readonly<Record<string, number>> = Object.freeze({
  streams: 2000,
  dlmag: 4000,
  tmdb: 500,
  meta: 500,
  // Resultado bruto da busca por indexer/scraper: cada entrada pode chegar a
  // ~100 KB (teto de itens no config), então a cota fica bem abaixo das de
  // entrada minúscula — pior caso ~79 MB no L1.
  raw: 800,
  // Disponibilidade por hash é só 0/1; a cota alta evita reconsultar a mesma
  // conta em buscas diferentes sem ocupar a memória dos resultados brutos.
  davail: 1000,
  // Banco de magnets: histórico durável por hash (vivo/ruim), entrada
  // minúscula como o davail — a cota alta cobre contas com catálogo grande.
  mag: 2000,
  // Ledger global do Real-Debrid: cache de serviço, sem credencial na chave.
  // A cota alta evita perder a evidência rara das sondas entre instalações.
  // Era 20 mil, mas agora o namespace é só de hashes (o cache por título do
  // Torrentio migrou para `rdt` e a fila do warmer para `rdq`), então abriu
  // espaço para os dois novos baldes sem estourar o teto global.
  rdc: 14000,
  // Fila do rdWarmer: uma única chave `rdq:v1:wq` carrega o array inteiro;
  // cota pequena por ser essencialmente um registro de estado, não histórico.
  rdq: 500,
  // Cache por título do Torrentio (`rdt:v1:trt:<type>:<id>`): uma entrada por
  // obra consultada, TTL ~6h — cota média para conviver com o ledger.
  rdt: 2500,
  // Índice de releases por obra (~14,7 KB por chave medido no pior caso, com teto
  // de 60 releases): 4.000 chaves ≈ 59 MB. É o que faz o addon responder do
  // próprio índice sem esperar Jackett. Folga tranquila no limite de 3 GB.
  idx: 2000,
  autofetch: 1000,
  'indexer-status': 200,
  cfg: 50,
  // Proteção durável dos BRs AllDebrid (`adprot:v1`): registro minúsculo por
  // hash, TTL de 10 anos — é a garantia do acervo BR sobreviver ao restart.
  adprot: 2000,
  __default: 500,
});

export function namespaceFor(key: string) {
  const separator = String(key).indexOf(':');
  return separator === -1 ? '__default' : String(key).slice(0, separator);
}

export function quotaFor(namespace: string) {
  return QUOTAS[namespace] || QUOTAS.__default;
}

export function incrementNamespace(namespaceCounts: Map<string, number>, namespace: string) {
  namespaceCounts.set(namespace, (namespaceCounts.get(namespace) || 0) + 1);
}

export function removeFromStore(store: Map<string, any>, namespaceCounts: Map<string, number>, key: string) {
  const entry = store.get(key);
  if (!entry) return false;
  store.delete(key);
  const remaining = (namespaceCounts.get(entry.namespace) || 1) - 1;
  if (remaining > 0) namespaceCounts.set(entry.namespace, remaining);
  else namespaceCounts.delete(entry.namespace);
  return true;
}

export function quotaOverflow(store: Map<string, any>, namespaceCounts: Map<string, number>, namespace: string) {
  const excess = (namespaceCounts.get(namespace) || 0) - quotaFor(namespace);
  if (excess <= 0) return [];
  const dropped: any[] = [];
  // O Map é LRU global; filtrá-lo preserva a mesma ordem de recência dentro do
  // namespace sem deixar um burst de dlmag desalojar streams.
  for (const [key, entry] of store) {
    if (entry.namespace === namespace) dropped.push(key);
    if (dropped.length === excess) break;
  }
  return dropped;
}
