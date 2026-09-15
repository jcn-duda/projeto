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

// A soma das cotas de namespaces conhecidos é 89.551 (inclui mag=50.000,
// rdc=14.000, autofetch=4.000, rdt=2.500, fsz=3.000, streams=2.000,
// idx=2.000, adprot=2.000, adsub=1.000, davail=1.000, vres=1.000, raw=800,
// dlmag=4.000, rdq=500, adrm=500, tmdb=500, meta=500, indexer-status=200 e
// cfg=50), deixando 1.449 entradas de folga sob o teto global. O ledger RD
// é global por hash e precisa reter muito mais histórico que os caches por conta;
// os demais baldes foram calibrados para abrir esse espaço sem deixar o despejo
// global invalidar suas cotas antes da hora. Memória: o raw domina (800 × ~100 KB
// ≈ 79 MB no pior caso) e o streams cresceu com o /stream-trace.json (cap de
// 300 itens ≈ 27 KB por entrada): no teto teórico do namespace (2000 entradas)
// soma ~54 MB — hoje observado ~13 MB em produção local. O idx (2.000 ×
// ~14,7 KB ≈ 29 MB) fecha a conta dos gordos; rdc/davail/mag/rdt/adprot/
// adsub/adrm/autofetch guardam só registros pequenos — mag 50k ≈ 19 MB e o
// autofetch 4k ≈ poucos MB (o registro `o:` por obra é uma lista curta).
//
// O teto global acompanha a soma: teto IGUAL OU ABAIXO dela reintroduz o
// despejo global antes da repartição por namespace, que foi bug real.
export const MAX_ENTRIES = 91000;
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
  // Banco de magnets: histórico durável por hash (vivo/ruim/mentiroso), entrada
  // minúscula como o davail (valor `1`, chave ~70 B) — ~400 B por entrada com o
  // overhead do Map, então 50.000 custa ~19 MB, folgado no container de 3g.
  // Era 2.000 e o banco ficava ~62x menor que o histórico que ele PODE guardar:
  // a conta do debrid trava em ~800 magnets vivos (autoFetchPauseAt), mas o
  // banco é histórico de tudo que já passou, inclusive do que a limpeza apagou.
  // Não confunda com permanência: o teto é capacidade, quem expira é o TTL
  // (alive/lie 7 dias, bad 24 h) — subir TTL é outro eixo, e é veto do plano.
  mag: 50000,
  // Um único agregado persistente com os contadores O(1) do MagnetDB.
  mag_meta: 1,
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
  // de 60 releases): 2.000 chaves ≈ 29 MB. É o que faz o addon responder do
  // próprio índice sem esperar Jackett. Folga tranquila no limite de 3 GB.
  // (PLANO_SERVIDOR prometeu 4000; o código entregou 2000 — não inventar 4000
  // no comentário nem no fallback do painel.)
  idx: 2000,
  // Fila do autofetch: markers vivos, dead/queues/prefetch, os registros `sup:`
  // com TTL próprio de 30 dias e — desde a Fase 2 — os registros por OBRA
  // (`o:<sha256>`, teto por janela). Os represados são lidos via `peek` (não
  // promovem LRU) e ficam como os itens mais frios do namespace: cota apertada
  // ali evicta justamente o acervo que a fila existe para tornar retroativo.
  // Recalculado na Fase 2: o registro `o:` soma ao balde que já carregava
  // markers/dead/queues/prefetch/sup, então 2.000 virou 4.000 (dobro) —
  // registro `o:` é uma lista curta de entradas minúsculas (hash+pool+at), e o
  // teto real de downloads por janela é a conta do debrid, não a cota. O teto
  // global (91.000) continua ESTRITAMENTE ACIMA da soma (89.551).
  autofetch: 4000,
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
  // Arquivos de vídeo por hash (`fsz:v1:<hash>`, lista {path,size}): dão o
  // tamanho do episódio num pack de temporada e do filme numa coleção. Uma
  // entrada fica em ~0,5–4 KB (13 filmes numa filmografia, 30 episódios numa
  // temporada), então 3.000 ≈ 12 MB no pior caso. Persistir é o motivo do
  // namespace: em memória, cada restart zerava a lista.
  fsz: 3000,
  // Resolução medida no cabeçalho do vídeo por arquivo (`vres:v1`): registro
  // minúsculo `{ q, w, h }`, uma entrada por arquivo que o play tocaria.
  vres: 1000,
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
