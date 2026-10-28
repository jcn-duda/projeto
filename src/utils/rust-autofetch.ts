/**
 * Portas napi do autofetch (Chupim) em Rust (`evaluateAutofetchCandidates`,
 * composição dos módulos `autofetch_*`): a cascata `br → any → seeds` decide
 * os imediatos e a fila numa chamada SÍNCRONA. Não há mais runner TS: o
 * `autofetch-candidates.ts` foi apagado na leva B4 junto com o corpo do Chupim,
 * e quem executa é o worker nativo (`adom-autofetch` + `adom-server::autofetch`,
 * chamado pelo tail de efeitos). Daqui sobra o contrato do lote mais as portas
 * da fila/marker/estado v3 que o Node ainda lê, e o `decideAutofetch` segue vivo
 * como oráculo dos testes do núcleo.
 */
import { requireCore } from './rust-core.js';
import type { NativeKvNapi } from './native-kv.js';
import * as metrics from './metrics.js';

// ---------------------------------------------------------------------------
// Contrato napi (camelCase; o napi converte o snake_case do Rust)
// ---------------------------------------------------------------------------

export type AutofetchStreamIn = {
  infoHash?: string | null;
  title?: string | null;
  name?: string | null;
  quality?: string | null;
  seeders?: number | null;
  sizeBytes?: number | null;
  packBytes?: number | null;
  isBr: boolean;
  isDubbed: boolean;
  isDubClaim: boolean;
  isBankDub: boolean;
  isLied: boolean;
  isCached: boolean;
  fromFallback: boolean;
  fallbackFetchable: boolean;
  viable: boolean;
};

export type PoolOptionsIn = {
  season?: number | null;
  minSeeders: number;
  ptFirst: boolean;
  autoFetchMax: number;
  queueDepth: number;
  topSeedsMax: number;
  rareMax: number;
  rareThreshold: number;
  rareMaxSeeders: number;
  autoFetchBr: boolean;
  adapterCacheCheck: boolean;
  adapterAutofetchSource: boolean;
  anyDubbed: boolean;
  topSeeds: boolean;
  /** `seedsSelectionBlock(...) != null` pré-computado no TS (o lote não vê a
   *  lista tocável nem o estado da sonda): bloqueia o seeds primário e o
   *  fallback seeds, como no oráculo. */
  seedsBlocked: boolean;
};

export type SeedsPolicyIn = {
  dubbedOnly: boolean;
  cachedOnly: boolean;
  maxSizeGb: number;
  seedsMaxGb: number;
  seedsMaxQuality: string;
};

export type EnqueueGatesIn = {
  isPaused: boolean;
  isDead: boolean;
  isCached: boolean;
  markerActive: boolean;
  lockAcquired: boolean;
  slotAcquired: boolean;
  obraCapGranted: boolean;
  accountBlocked: boolean;
  budgetGranted: boolean;
};

export type AutofetchInputNapi = {
  streams: AutofetchStreamIn[];
  options: PoolOptionsIn;
  seedsPolicy: SeedsPolicyIn;
  gates: EnqueueGatesIn;
  obraEntries: unknown[];
  pendingReservations: unknown[];
};

// ---------------------------------------------------------------------------
// Fila v3 no KV nativo (`autofetch/queue_v3.rs`): o formato REAL da fila do
// Chupim. O candidato cruza como STRING (o `JSON.stringify` do Node), nunca
// como objeto napi — é o que preserva o formato exato do `QueueCandidate`.
// ---------------------------------------------------------------------------

/** Opções do `autofetchV3WriteQueue` (o `AutofetchQueueWriteOpts` do Rust). */
export type AutofetchQueueWriteOptsNapi = {
  /** TTL da chave da fila (`DEBRID_AUTO_FETCH_QUEUE_TTL`). */
  ttlSeconds: number;
  /** Teto de candidatos na fila (`autoFetchQueueDepth`). */
  depth: number;
  /** Escopo do filtro de hash morto: só vale com adapter E conta. */
  adapterId?: string | null;
  account?: string | null;
};

/** Relatório do `write_queue`: `kept` gravados, `dropped` descartados. */
export type AutofetchQueueWriteReportNapi = { kept: number; dropped: number };

/**
 * Portas da fila v3 sobre o `NativeKv`: chave, leitura/gravação por searchKey,
 * drop (aceita chave pronta ou searchKey) e varredura das chaves vivas.
 */
export type AutofetchQueueCore = {
  autofetchV3QueueKey(searchKey: string): string;
  autofetchV3ReadQueue(kv: NativeKvNapi, searchKey: string, nowMs: number): string | null;
  autofetchV3WriteQueue(
    kv: NativeKvNapi,
    searchKey: string,
    candidatesJson: string,
    opts: AutofetchQueueWriteOptsNapi,
    nowMs: number,
  ): AutofetchQueueWriteReportNapi;
  autofetchV3DropQueue(kv: NativeKvNapi, keyOrSearchKey: string): boolean;
  autofetchV3QueueKeys(kv: NativeKvNapi, nowMs: number): string[];
};

/**
 * Portas do MARKER v3 (`autofetch:v3:m:<adapter>:<conta>:<hash>`) sobre o
 * `NativeKv`. O marker é o `is_obsolete` do dreno e a prova de posse do
 * AllDebrid: o Node não o lê mais do cache (o prefixo é RUST_OWNED), e o valor
 * cruza como STRING para preservar as três formas (`1`, `{id}`, `{id,…meta}`)
 * exatamente como o `markerValue` as monta.
 */
export type AutofetchMarkerCore = {
  /** JSON cru do marker vivo; `null` = ausente/vencido. */
  autofetchV3Marker(kv: NativeKvNapi, adapterId: string, account: string, infoHash: string, nowMs: number): string | null;
  /** Grava o valor cru; no Rust `ttlSeconds <= 0` = permanente (o TS não passa <= 0). */
  autofetchV3SetMarker(
    kv: NativeKvNapi,
    adapterId: string,
    account: string,
    infoHash: string,
    valueJson: string,
    ttlSeconds: number,
    nowMs: number,
  ): void;
  /** Apaga o marker; `false` = não havia nada. */
  autofetchV3ForgetMarker(kv: NativeKvNapi, adapterId: string, account: string, infoHash: string): boolean;
};

/** Estado adicional do Chupim v3 preparado sobre o mesmo NativeKv.
 * Mantido sem roteamento de prefixos até os consumidores Node migrarem juntos. */
export type AutofetchStateV3Core = {
  autofetchV3ProbeKey(kind: string, imdbId: string, season?: number | null, episode?: number | null): string;
  autofetchV3ProbeRead(
    kv: NativeKvNapi, kind: string, imdbId: string,
    season: number | null | undefined, episode: number | null | undefined, nowMs: number,
  ): string | null;
  autofetchV3ProbeWrite(
    kv: NativeKvNapi, kind: string, imdbId: string,
    season: number | null | undefined, episode: number | null | undefined,
    recordJson: string, ttlSeconds: number, nowMs: number,
  ): void;
  autofetchV3ObraRead(kv: NativeKvNapi, key: string, nowMs: number): string | null;
  autofetchV3ObraCommit(kv: NativeKvNapi, key: string, entryJson: string, ttlSeconds: number, nowMs: number): boolean;
  autofetchV3ObraForgetHash(kv: NativeKvNapi, key: string, hash: string, ttlSeconds: number, nowMs: number): boolean;
  autofetchV3SuppressedKey(adapterId: string, account: string, hash: string): string;
  autofetchV3SuppressedRead(kv: NativeKvNapi, adapterId: string, account: string, hash: string, nowMs: number): string | null;
  autofetchV3SuppressedNote(kv: NativeKvNapi, adapterId: string, account: string, hash: string, id: string, ttlSeconds: number, nowMs: number): boolean;
  autofetchV3SuppressedRetry(kv: NativeKvNapi, adapterId: string, account: string, hash: string, ttlSeconds: number, nowMs: number): 'missing' | 'scheduled' | 'given-up';
  autofetchV3SuppressedForget(kv: NativeKvNapi, adapterId: string, account: string, hash: string): boolean;
  autofetchV3LotKey(searchKey: string): string;
  autofetchV3LotRead(kv: NativeKvNapi, searchKey: string, nowMs: number): string | null;
  autofetchV3LotWrite(kv: NativeKvNapi, searchKey: string, lotJson: string, ttlSeconds: number, nowMs: number): void;
  autofetchV3LotForget(kv: NativeKvNapi, searchKey: string): boolean;
  autofetchV3LotKeys(kv: NativeKvNapi, nowMs: number): string[];
};

export type AutofetchCandidateNapi = { infoHash: string; pool: string; rare: boolean; slotLimit?: number | null };
export type QueueCandidateNapi = { infoHash: string; pool: string; rare: boolean; slotLimit?: number | null };
export type SkipNapi = { reason: string; rollback: string[]; infoHash: string };
export type AutofetchDecisionNapi = {
  immediates: AutofetchCandidateNapi[];
  queue: QueueCandidateNapi[];
  skips: SkipNapi[];
  trace?: { pool?: string; disabled?: boolean };
};

export type AutofetchCore = AutofetchQueueCore & AutofetchMarkerCore & AutofetchStateV3Core & {
  evaluateAutofetchCandidates(input: AutofetchInputNapi): AutofetchDecisionNapi;
};

// ---------------------------------------------------------------------------
// Captura da decisão (fatos já medidos; nada aqui consulta rede/estado)
// ---------------------------------------------------------------------------

/** Stream cru do pipeline: só os campos que o lote lê (prefixo `_`). */
export type AutofetchRawStream = {
  infoHash?: string;
  title?: string;
  name?: string;
  _quality?: string;
  _seeders?: number;
  _size?: number;
  _packBytes?: number;
  _br?: boolean;
  _dubbed?: boolean;
  _dubClaim?: boolean;
  _bankDub?: boolean;
  _lied?: boolean;
  _fromFallback?: boolean;
  _fallbackFetchable?: boolean;
  _seedFloorWaived?: boolean;
};

/** Config efetiva do autofetch (subconjunto usado pelo lote). */
export type AutofetchLiveSubset = {
  autoFetchMinSeeders: number;
  autoFetchSeedsPtFirst: boolean;
  autoFetchMax: number;
  autoFetchTopSeedsMax: number;
  autoFetchRareMax: number;
  autoFetchRareThreshold: number;
  autoFetchRareMaxSeeders: number;
  autoFetchAnyDubbed: boolean;
  autoFetchTopSeeds: boolean;
};

/** Fatos da busca que a seleção lê (nada aqui consulta rede ou estado). */
export type AutofetchCapture = {
  streams: AutofetchRawStream[];
  season?: number | null;
  queueDepth: number;
  live: AutofetchLiveSubset;
  policy: { dubbedOnly: boolean; cachedOnly: boolean; maxSizeGb: number; seedsMaxGb: number; seedsMaxQuality: string };
  autoFetchBr: boolean;
  adapter: { cacheCheck?: boolean; autofetchSource?: boolean } | null;
  /** Fato do oráculo: o `seedsSelectionBlock` da busca (bloqueia seeds). */
  seedsBlocked?: boolean;
};

/** Portões abertos: na seleção o TS ainda não avaliou lock/slot/obra/budget. */
function openGates(): EnqueueGatesIn {
  return {
    isPaused: false,
    isDead: false,
    isCached: false,
    markerActive: false,
    lockAcquired: true,
    slotAcquired: true,
    obraCapGranted: true,
    accountBlocked: false,
    budgetGranted: true,
  };
}

function toStreamIn(s: AutofetchRawStream): AutofetchStreamIn {
  // O napi-rs só aceita `undefined` (campo omitido) para `Option`; `null`
  // explícito falha a conversão — por isso a entrada é montada sem nulos.
  const out: AutofetchStreamIn = {
    infoHash: s.infoHash || null,
    title: s.title || null,
    name: s.name || null,
    quality: s._quality || null,
    seeders: s._seeders ?? null,
    sizeBytes: s._size ?? null,
    packBytes: s._packBytes ?? null,
    isBr: Boolean(s._br),
    isDubbed: Boolean(s._dubbed),
    isDubClaim: Boolean(s._dubClaim),
    isBankDub: Boolean(s._bankDub),
    isLied: Boolean(s._lied),
    isCached: false,
    fromFallback: Boolean(s._fromFallback),
    fallbackFetchable: Boolean(s._fallbackFetchable),
    // Espelho do waiver do piso SEM emitir métrica (o runner já contou).
    viable: !Boolean(s._seedFloorWaived),
  };
  for (const k of Object.keys(out) as (keyof AutofetchStreamIn)[]) {
    if (out[k] === null) delete out[k];
  }
  return out;
}

function buildInput(c: AutofetchCapture): AutofetchInputNapi {
  return {
    streams: c.streams.map(toStreamIn),
    options: {
      // Omitido quando null: o napi-rs rejeita `null` explícito em `Option`.
      ...(c.season == null ? {} : { season: c.season }),
      minSeeders: Number(c.live.autoFetchMinSeeders) || 0,
      ptFirst: Boolean(c.live.autoFetchSeedsPtFirst),
      autoFetchMax: Number(c.live.autoFetchMax) || 0,
      queueDepth: Number(c.queueDepth) || 0,
      topSeedsMax: Number(c.live.autoFetchTopSeedsMax) || 0,
      rareMax: Number(c.live.autoFetchRareMax) || 0,
      rareThreshold: Number(c.live.autoFetchRareThreshold) || 0,
      rareMaxSeeders: Number(c.live.autoFetchRareMaxSeeders) || 0,
      autoFetchBr: Boolean(c.autoFetchBr),
      adapterCacheCheck: Boolean(c.adapter?.cacheCheck),
      adapterAutofetchSource: Boolean(c.adapter?.autofetchSource),
      anyDubbed: Boolean(c.live.autoFetchAnyDubbed),
      topSeeds: Boolean(c.live.autoFetchTopSeeds),
      seedsBlocked: Boolean(c.seedsBlocked),
    },
    seedsPolicy: {
      dubbedOnly: Boolean(c.policy.dubbedOnly),
      cachedOnly: Boolean(c.policy.cachedOnly),
      maxSizeGb: Number(c.policy.maxSizeGb) || 0,
      seedsMaxGb: Number(c.policy.seedsMaxGb) || 0,
      seedsMaxQuality: String(c.policy.seedsMaxQuality || ''),
    },
    gates: openGates(),
    obraEntries: [],
    pendingReservations: [],
  };
}

/** Escolha do Rust já casada com a lista de streams viva da busca. */
export type AutofetchPick<S> = {
  immediate: Array<{ stream: S; pool: string; rare: boolean; slotLimit?: number }>;
  queue: Array<{ stream: S; pool: string; rare?: boolean; slotLimit?: number }>;
};

/**
 * O Rust decide imediatos e fila. Lança se o napi lançar ou citar um hash que
 * não está na lista viva — nunca dispara um stream que a busca não conhece;
 * quem chama decide o que fazer com o erro (a busca segue sem candidato).
 */
export function decideAutofetch<S extends AutofetchRawStream>(
  capture: AutofetchCapture & { streams: S[] },
): AutofetchPick<S> {
  const byHash = new Map<string, S>();
  for (const s of capture.streams) {
    const h = String(s.infoHash || '').toLowerCase();
    if (h && !byHash.has(h)) byHash.set(h, s);
  }
  metrics.count('rust.autofetch.calls');
  const core = requireCore() as unknown as AutofetchCore;
  const d = core.evaluateAutofetchCandidates(buildInput(capture));
  const find = (hash: string): S => {
    const s = byHash.get(String(hash || '').toLowerCase());
    if (!s) throw new Error(`hash fora da lista viva: ${hash}`);
    return s;
  };
  const slot = (n: number | null | undefined) => (n == null ? {} : { slotLimit: n });
  return {
    immediate: (d.immediates || []).map((c) => ({ stream: find(c.infoHash), pool: c.pool, rare: Boolean(c.rare), ...slot(c.slotLimit) })),
    queue: (d.queue || []).map((c) => ({ stream: find(c.infoHash), pool: c.pool, rare: Boolean(c.rare), ...slot(c.slotLimit) })),
  };
}
