/**
 * Cache multi-nível do addon — ponto de entrada (padrão barrel §5.1/§5.3).
 *
 * A implementação vive em módulos irmãos, sem ciclo:
 * - cache-quotas.ts: política PURA de cotas/evicção (constantes + funções que
 *   recebem o estado como parâmetro);
 * - cache-db.ts: fábrica da persistência SQLite (L2) — handle, statements,
 *   fila de despejo e flush nascem na closure desta instância;
 * - cache.ts (este): dono de TODO o estado mutável (L1, contadores, L2 da
 *   instância) + API pública com os MESMOS nomes de export de antes da
 *   divisão — nenhum consumidor mudou. O estado morar aqui não é detalhe:
 *   os testes de cache recarregam o módulo com query string para nascer
 *   limpo, e estado em irmão importado sem query vazaria entre instâncias.
 */
import * as metrics from './metrics.js';
import {
  MAX_ENTRIES, QUOTAS,
  namespaceFor, quotaFor, incrementNamespace as bumpNamespace, removeFromStore as dropFromStore, quotaOverflow,
} from './cache-quotas.js';
import { createPersistence } from './cache-db.js';
import { isRustOwned, isForeignKey, prefix } from './cache-keys.js';
import { clearIdxStore } from './release-index-store.js';
import { clearRawStore } from './raw-store-native.js';
import { davailState, magnetState } from './debrid-state-native.js';
import { kvClearPrefix } from './native-kv.js';

const store = new Map();
const namespaceCounts = new Map();

const persistence = createPersistence();
const { pending, maxGraceMs, maintain } = persistence;

const removeFromStore = (key: string) => dropFromStore(store, namespaceCounts, key);
const incrementNamespace = (namespace: string) => bumpNamespace(namespaceCounts, namespace);
const l1Hooks = { store, removeFromStore, incrementNamespace };

// Telemetria de uso por namespace (guia do corte do L1): leituras e escritas
// REAIS deste processo desde o boot, com o instante da última. A guilhotina do
// motor precisa de prova de quem ainda tem consumidor; os contadores
// `cache.hit/miss` das métricas medem RESULTADO, não consulta — aqui cada API
// do L1 marca o namespace que tocou. `get`/`peek` com chave de dono Rust saem
// nas guardas antes do store e NÃO contam; `has`/`peekRemaining`/`getWithStale`
// tocam o store e contam — leitor zumbi de dado já migrado é justamente o sinal.
type UsageEntry = { reads: number; writes: number; lastReadAt: number; lastWriteAt: number };
const usageByNamespace = new Map<string, UsageEntry>();
function noteUsage(namespace: string, kind: 'read' | 'write') {
  const entry = usageByNamespace.get(namespace) ?? { reads: 0, writes: 0, lastReadAt: 0, lastWriteAt: 0 };
  if (kind === 'read') { entry.reads++; entry.lastReadAt = Date.now(); }
  else { entry.writes++; entry.lastWriteAt = Date.now(); }
  usageByNamespace.set(namespace, entry);
}

/** Foto do uso por namespace (padrão `_origem` do l2Stats): contadores do
 * processo, zeram no restart — amostra, não medida durável. */
function usage() {
  const namespaces: Record<string, UsageEntry> = {};
  for (const [namespace, entry] of usageByNamespace) namespaces[namespace] = { ...entry };
  return { namespaces, _origem: 'amostra' as const };
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

function evict(keys: string[]) {
  for (const key of keys) {
    // A cota cheia é o estado normal de um namespace quente. `cache.evicted`
    // fica reservado ao teto global, para continuar alertando só pressão real
    // de memória; o detalhamento mostra qual balde está girando.
    metrics.count('cache.evicted.quota');
    metrics.count(`cache.evicted.quota.${namespaceFor(key)}`);
  }
  forgetMany(keys);
}

function prune() {
  const now = Date.now();
  // Expirado dentro da janela de graça do SWR fica: o próximo getWithStale
  // ainda o serve enquanto o refresh de fundo revalida. O corte duro vale só
  // para o que passou da graça.
  const graceMs = maxGraceMs();
  // Acumula e apaga uma vez só: o disco é o caro, a memória não.
  const dropped: any[] = [];
  for (const [key, hit] of store) {
    if (hit.expiresAt && now > hit.expiresAt + graceMs) {
      dropped.push(key);
    }
  }
  // Sai do store AQUI, e não só no forgetMany do fim: o teto abaixo é
  // avaliado sobre store.size, e adiar a remoção tirava a condição de
  // parada do laço — ele repetia a mesma chave até o array estourar
  // (RangeError dentro de cache.set, derrubando a requisição).
  for (const key of dropped) {
    for (const hook of forgetHooks) hook(key);
    removeFromStore(key);
  }
  // Se ainda estourou o teto, descarta as entradas mais antigas (Map preserva ordem de inserção).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    for (const hook of forgetHooks) hook(oldest);
    removeFromStore(oldest);
    dropped.push(oldest);
    // Este laço é CANÁRIO, não regulador: com o teto estritamente acima da
    // soma do universo de cotas (a conta está em cache-quotas.ts), a
    // repartição por namespace acima já devolveu o store ao tamanho, e aqui
    // não sobra nada para despejar. Se este contador subir, é porque algum
    // namespace escapou da repartição — cota que virou fallback, chave sem
    // `:`, teto rebaixado — e não porque MAX_ENTRIES ficou pequeno. Subir o
    // teto esconde o sintoma sem tocar na causa.
    metrics.count('cache.evicted');
    metrics.count(`cache.evicted.${namespaceFor(oldest)}`);
  }
  forgetMany(dropped);
  // Gancho de quem tem estado FORA do L1 para varrer junto: o `mag`/`davail`
  // são do núcleo e o Node não vê mais as linhas vencidas deles. Roda depois
  // da poda da memória e nunca no caminho de uma request.
  for (const hook of pruneHooks) hook();
}

/** Para o /metrics.json: quanto do teto está ocupado agora. */
function size() { return store.size; }

function snapshot() {
  const namespaces: Record<string, { entries: number; maxEntries: number }> = {};
  for (const [namespace, entries] of namespaceCounts) {
    namespaces[namespace] = { entries, maxEntries: quotaFor(namespace) };
  }
  return { entries: size(), maxEntries: MAX_ENTRIES, namespaces, usage: usage() };
}

function get(key: string) {
  // Chave de outro dono não existe no L1 do Node: nem miss, nem métrica.
  if (isForeignKey(key)) return null;
  noteUsage(namespaceFor(key), 'read');
  const hit = store.get(key);
  if (!hit) {
    // O contador por namespace diz QUAL balde está pagando rede de novo; o
    // global continua para as séries históricas que já existem no painel.
    metrics.count('cache.miss');
    metrics.count(`cache.miss.${namespaceFor(key)}`);
    return null;
  }
  if (hit.expiresAt && Date.now() > hit.expiresAt) {
    forget(key);
    // Expirado é miss para quem perguntou; o `expired` separado diz se o TTL
    // está curto demais para o ritmo de uso.
    metrics.count('cache.miss');
    metrics.count(`cache.miss.${hit.namespace}`);
    metrics.count('cache.expired');
    return null;
  }
  metrics.count('cache.hit');
  metrics.count(`cache.hit.${hit.namespace}`);
  // Map preserva inserção; mover o hit para o fim transforma o corte em LRU.
  removeFromStore(key);
  store.set(key, hit);
  incrementNamespace(hit.namespace);
  return hit.value;
}

/**
 * Leitura com janela de graça para stale-while-revalidate: dentro do TTL
 * devolve `{ value, stale: false }`; entre o TTL e `expiresAt + grace` devolve
 * `{ value, stale: true }` SEM apagar a entrada — o consumidor responde com
 * ela enquanto revalida em fundo; depois devolve null. O get() normal mantém a
 * semântica dura (expirou = apagou), por isso os dois convivem.
 */
function getWithStale(key: string, graceSeconds = 0) {
  noteUsage(namespaceFor(key), 'read');
  const hit = store.get(key);
  if (!hit) {
    metrics.count('cache.miss');
    metrics.count(`cache.miss.${namespaceFor(key)}`);
    return null;
  }
  const now = Date.now();
  if (hit.expiresAt && now > hit.expiresAt) {
    if (now > hit.expiresAt + Math.max(0, graceSeconds) * 1000) {
      forget(key);
      metrics.count('cache.miss');
      metrics.count(`cache.miss.${hit.namespace}`);
      metrics.count('cache.expired');
      return null;
    }
    metrics.count('cache.hit');
    metrics.count(`cache.hit.${hit.namespace}`);
    // Contador próprio: o SWR só se paga se aparecer aqui. Hit stale que nunca
    // vira refresh seria lista velha eterna sem nenhum sinal no painel.
    metrics.count('cache.stale');
    return { value: hit.value, stale: true };
  }
  metrics.count('cache.hit');
  metrics.count(`cache.hit.${hit.namespace}`);
  removeFromStore(key);
  store.set(key, hit);
  incrementNamespace(hit.namespace);
  return { value: hit.value, stale: false };
}

function set(key: string, value: unknown, ttlSeconds: number) { setMany([{ key, value, ttlSeconds }]); }

/**
 * Segundos restantes da entrada, SEM promovê-la no LRU nem contar métrica —
 * leitura de sondagem, para o consumidor decidir se vale regravar. Expirada ou
 * ausente devolve null; entrada sem TTL também (não há o que renovar).
 */
function peekRemaining(key: string): number | null {
  noteUsage(namespaceFor(key), 'read');
  const hit = store.get(key);
  if (!hit || !hit.expiresAt) return null;
  if (Date.now() > hit.expiresAt) return null;
  return Math.max(0, Math.round((hit.expiresAt - Date.now()) / 1000));
}

/**
 * Leitura SEM efeito: devolve o valor se ainda válido, sem promover o LRU (o
 * Map preserva a posição de recência) e sem contar `cache.hit`/`cache.miss`.
 * Para sondas que só querem LER e decidir depois se escrevem — ex: o ledger do
 * debrid e o `davail` consultam antes de qualquer gravação, e o `set` promove
 * a chave e conta `cache.hit`. Assim a varredura sem match não infla os
 * contadores do painel nem reordena o cache. Expirada/ausente devolve null.
 */
function peek(key: string): unknown {
  if (isForeignKey(key)) return null;
  noteUsage(namespaceFor(key), 'read');
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt && Date.now() > hit.expiresAt) return null;
  return hit.value;
}

/** Presença física no L1, inclusive quando a entrada venceu mas ainda aguarda
 * o prune. Escritores usam isto para substituir sem contar a mesma chave duas
 * vezes na janela entre o vencimento e a poda periódica. */
function has(key: string): boolean {
  noteUsage(namespaceFor(key), 'read');
  return store.has(key);
}

/**
 * Escrita em LOTE com UMA passada de evicção por namespace. O `set` unitário
 * já dava conta dos consumidores antigos; o davail escreve um registro por
 * hash da busca no caminho de resposta, e em saturação de cota cada `set`
 * pagava um scan do store global mais uma transação SQLite (fsync) pela
 * vítima — o custo por chave que os comentários de persistência/forgetMany
 * dizem que só é aceitável em lote. Aqui o excesso do namespace inteiro é
 * calculado depois de todas as inserções: mesmo critério de vítima (as mais
 * antigas do LRU continuam na frente), uma transação só.
 */
function setMany(entries: { key: string; value: unknown; ttlSeconds: number }[]) {
  const valid = entries.filter((e) => e.ttlSeconds && e.ttlSeconds > 0);
  if (valid.length === 0) return;
  const namespaces = new Set<string>();
  for (const { key, value, ttlSeconds } of valid) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const namespace = namespaceFor(key);
    // RUST_OWNED tem dono único: segundo escritor no L1 faria o `forget`/prune
    // do Node apagar a linha fresca do gateway.
    if (isRustOwned(namespace) || isForeignKey(key)) continue;
    removeFromStore(key); // reinsere no fim para a ordem refletir o uso mais recente
    store.set(key, { value, expiresAt, namespace });
    incrementNamespace(namespace);
    noteUsage(namespace, 'write');
    persist(key, value, expiresAt);
    namespaces.add(namespace);
  }
  for (const namespace of namespaces) {
    const quotaDropped = quotaOverflow(store, namespaceCounts, namespace);
    if (quotaDropped.length) evict(quotaDropped);
  }
  if (store.size > MAX_ENTRIES) prune();
}

// Mecanismo interno dos ganchos de forget/prune — sem registrador vivo. Quem
// tinha estado fora do L1 saiu: a contagem do agregado do magnetdb passou para
// o dono nativo (o gateway mantém `mag_meta` pela régua `bump_counts`; o Node
// só lê pela ponte) e a varredura de vencidos é nativa, com relógio próprio
// (`magnetdb-persist.ts`). `onForget`/`onPrune` saíram por falta de chamador —
// só sobreviviam em comentários e docs. Os laços de disparo em
// `prune`/`forget`/`forgetMany` ficam; um futuro dono de estado externo volta a
// registrar acrescentando no set aqui.
type ForgetHook = (key: string) => void;
const forgetHooks = new Set<ForgetHook>();

type PruneHook = () => void;
const pruneHooks = new Set<PruneHook>();

function forget(key: string) {
  if (isRustOwned(namespaceFor(key)) || isForeignKey(key)) return;
  const existed = store.has(key);
  persistence.forget(key, removeFromStore);
  if (existed) {
    for (const hook of forgetHooks) hook(key);
  }
}

function forgetMany(keys: string[]) {
  const owned = keys.filter((key) => !isRustOwned(namespaceFor(key)) && !isForeignKey(key));
  if (!owned.length) return;
  const existingKeys: string[] = [];
  for (const key of owned) {
    if (store.has(key)) existingKeys.push(key);
  }
  persistence.forgetMany(owned, removeFromStore);
  for (const key of existingKeys) {
    for (const hook of forgetHooks) hook(key);
  }
}

function persist(key: string, value: unknown, expiresAt: number) {
  if (isRustOwned(namespaceFor(key)) || isForeignKey(key)) return;
  persistence.persist(key, value, expiresAt);
}

function clear() {
  store.clear();
  namespaceCounts.clear();
  // Antes do truncate, senão o despejo agendado reescreveria o banco limpo.
  pending.clear();
  persistence.clearDisk();
  // O disco é o mesmo arquivo que o Rust lê, mas um handle em memória
  // (`CACHE_PERSIST=false`) não é tocado pelo truncate: limpa os namespaces
  // RUST_OWNED também — `davail`/`mag`/`adsub`/`adprot`/`adrm` e o estado do
  // Chupim (namespace `autofetch` inteiro: fila, marker, dead, represa `sup:`,
  // obra, vestígios de `pf:`/`probe:`) só existem lá.
  clearIdxStore();
  clearRawStore();
  davailState().clear();
  magnetState().clear();
  // Namespaces do KV nativo que têm dono no Rust: o clear global zera as
  // evidências (ledger do RD, listas de arquivos e totais), como antes.
  for (const ns of ['adsub', 'adprot', 'adhold', 'adrm', 'rdc', 'fsz', 'tsz'] as const) kvClearPrefix(prefix(ns));
  clearAutofetchNative();
}

/** Estado do Chupim no KV nativo (o L1 não o alcança). */
const clearAutofetchNative = () => kvClearPrefix(prefix('autofetch'));

// Clear nativo do clearNamespace por namespace RUST_OWNED: handle próprio
// (`idx`/`raw`/`davail`/`mag` e o `autofetch` inteiro, L6) ou ponte do KV sobre
// o MESMO cache.db (`adsub`/`adprot`/`adhold`/`adrm`/`rdc`/`fsz`/`tsz`).
// `harvest`/`rdq` ficam de fora de propósito: dono vivo é o gateway (worker com
// fila e journal próprios) — quem zera é a admin dele, não esta ponte.
const nativeClears: Record<string, () => number> = {
  idx: clearIdxStore, raw: clearRawStore, davail: () => davailState().clear(), mag: () => magnetState().clear(), autofetch: clearAutofetchNative,
  adsub: () => kvClearPrefix(prefix('adsub')), adprot: () => kvClearPrefix(prefix('adprot')), adhold: () => kvClearPrefix(prefix('adhold')),
  adrm: () => kvClearPrefix(prefix('adrm')), rdc: () => kvClearPrefix(prefix('rdc')),
  fsz: () => kvClearPrefix(prefix('fsz')), tsz: () => kvClearPrefix(prefix('tsz')),
};

/** Remove só o namespace pedido, sem esfriar os outros baldes. */
function clearNamespace(namespace: string) {
  const wanted = String(namespace || '');
  if (!wanted) return 0;
  const clearer = nativeClears[wanted];
  return clearWhere((key) => namespaceFor(key) === wanted) + (clearer ? clearer() : 0);
}

/**
 * Limpeza seletiva para ações operacionais. A varredura é sobre o L1, que é a
 * fonte das leituras deste processo; forgetMany mantém L1, fila pendente e L2
 * coerentes na mesma operação.
 */
function clearWhere(matches: (key: string) => boolean) {
  const keys: string[] = [];
  for (const key of store.keys()) {
    if (matches(key)) keys.push(key);
  }
  forgetMany(keys);
  return keys.length;
}

/** Libera o L2 no encerramento; o L1 continua utilizável até o processo sair. */
function close() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  persistence.close();
}

persistence.open();
persistence.loadFromDisk(l1Hooks);
// Expirado ocupa linha no banco mesmo sem ninguém ler a chave.
pruneTimer = setInterval(prune, 10 * 60 * 1000);
pruneTimer.unref();

function l2Stats() { return persistence.l2Stats(); }

export {
  MAX_ENTRIES, QUOTAS, get, getWithStale, set, setMany, forget, forgetMany,
  prune, clear, clearNamespace, clearWhere, size, snapshot, has, peek, peekRemaining, usage, maintain, close, l2Stats,
};
