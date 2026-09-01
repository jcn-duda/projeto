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

// A soma das cotas de namespaces conhecidos é 34.550 (inclui rdc=14.000,
// rdq=500, rdt=2.500, adprot=2.000, adsub=1.000 e adrm=500), deixando 1.450
// entradas de folga sob o teto global. O ledger RD
// é global por hash e precisa reter muito mais histórico que os caches por conta;
// os demais baldes foram calibrados para abrir esse espaço sem deixar o despejo
// global invalidar suas cotas antes da hora. Memória: o raw domina (800 × ~100 KB
// ≈ 79 MB no pior caso) e o streams cresceu com o /stream-trace.json (cap de
// 300 itens ≈ 27 KB por entrada): no teto teórico do namespace (2000 entradas)
// soma ~54 MB — hoje observado ~13 MB em produção local. Soma raw + streams +
// idx (~59 MB) segue segura no container de 3g; rdc/davail/mag/rdt/adprot/
// adsub/adrm guardam só registros minúsculos.
export const MAX_ENTRIES = 36000;
export const QUOTAS: Readonly<Record<string, number>> = Object.freeze({
  streams: 2000,
  dlmag: 4000,
  tmdb: 500,
  meta: 500,
  // Resultado bruto da busca por indexer/scraper: cada entrada pode chegar a
  // ~100 KB (teto de itens no config), então a cota fica bem abaixo das de
  // entrada minúscula — pior caso ~79 MB no L1, ainda o maior balde
  // individual (o streams, segundo maior, soma ~54 MB no teto teórico com o
  // trace do /stream-trace.json; ~13 MB observado).
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
  // Posse durável dos uploads do próprio addon (`adsub:v1:<conta>:<hash>`,
  // registro { at }, TTL de 7 dias): quebra a catraca do `preexistente` — sem
  // isto, o restart reclassifica tudo que o addon subiu como acervo do
  // usuário e a limpeza nunca mais o alcança (medido: 904 magnets em 8 dias
  // sem o autofetch participar). Registro minúsculo, mesmo formato do adprot.
  adsub: 1000,
  // Anti-reenchimento do AllDebrid (`adrm:v1`, 8.14): registro { at, name? }
  // por hash apagado de propósito, TTL de 3 dias — bloco minúsculo no tamanho
  // da rodada de limpeza (teto de 100/rodada), não do acervo inteiro.
  adrm: 500,
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
