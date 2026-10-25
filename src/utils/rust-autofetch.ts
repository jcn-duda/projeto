/**
 * Seleção do autofetch (Chupim) em Rust (`evaluateAutofetchCandidates`,
 * composição dos módulos `autofetch_*`): a cascata `br → any → seeds` decide
 * os imediatos e a fila numa chamada SÍNCRONA, antes das travas e da escrita
 * da fila. O runner (`autofetch-candidates.ts`) segue dono dos portões, das
 * travas (holds), da sonda BR, da fila persistida e do waiver do piso; a
 * seleção TS de imediatos/fila saiu do branch (oráculo no `esm`).
 */
import { requireCore } from './rust-core.js';
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

export type AutofetchCandidateNapi = { infoHash: string; pool: string; rare: boolean; slotLimit?: number | null };
export type QueueCandidateNapi = { infoHash: string; pool: string; rare: boolean; slotLimit?: number | null };
export type SkipNapi = { reason: string; rollback: string[]; infoHash: string };
export type AutofetchDecisionNapi = {
  immediates: AutofetchCandidateNapi[];
  queue: QueueCandidateNapi[];
  skips: SkipNapi[];
  trace?: { pool?: string; disabled?: boolean };
};

export type AutofetchCore = {
  evaluateAutofetchCandidates(input: AutofetchInputNapi): AutofetchDecisionNapi;
};

// ---------------------------------------------------------------------------
// Captura vinda do runner (fatos já medidos; nada aqui consulta rede/estado)
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

/** Escolha do Rust já casada com os streams vivos do runner. */
export type AutofetchPick<S> = {
  immediate: Array<{ stream: S; pool: string; rare: boolean; slotLimit?: number }>;
  queue: Array<{ stream: S; pool: string; rare?: boolean; slotLimit?: number }>;
};

/**
 * O Rust decide imediatos e fila. Lança se o napi lançar ou citar um hash que
 * não está na lista viva — nunca dispara um stream que o runner não conhece;
 * quem chama decide o que fazer com o erro (o runner fecha sem candidato).
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

// ---------------------------------------------------------------------------
// Regras puras AVULSAS do Chupim: ponte das cascas `autofetch-*.ts` ao núcleo
// ---------------------------------------------------------------------------
//
// As cascas antigas ainda têm chamadores fora do autofetch, então a troca é
// feita por fatia: cada wrapper abaixo tem a MESMA assinatura pública do módulo
// equivalente (o adaptador de tipo mora aqui) e o núcleo é obrigatório — não há
// knob de env. As réguas são as do `adom-core`; nada é reimplementado no TS.

export type ObraOverflowEntryNapi = { pool: string; quality: string; overflow: boolean };
export type ExpiredFactsNapi = { hashEmpty: boolean; isCleanupProtected: boolean; adapterIsAlldebrid: boolean; hasMarker: boolean; hasAdsub: boolean; hasSnapshot: boolean; inSnapshot: boolean };
export type ProgressLotNapi = { adapterId: string; account: string; hashes: string[]; threshold: number };
export type TorrentProgressNapi = { bytes: number; total: number; speed: number; seeders: number };
export type TorrentStatusNapi = { state: string; id?: string | number | null; progress?: TorrentProgressNapi | null };
export type ProgressDerivationNapi = { stalled: string[]; signals: number };
export type QueueEntryRuleNapi = { index: number; pool: string; rare: boolean; slotLimit?: number | null };
export type QueueCandidateOptsRule = { imdbId?: string | null; season?: number | null; episode?: number | null; seasonFill: boolean; rare?: boolean; slotLimit?: number | null; sizeBytes?: number | null };
export type QueueCandidateRuleNapi = { infoHash: string; name?: string | null; title?: string | null; quality?: string | null; size?: number | null; seeders?: number | null; br: boolean; dubbed: boolean; bankDub: boolean; lied: boolean; pool: string; imdbId?: string | null; season?: number | null; episode?: number | null; isPack: boolean; probeSeason?: number | null; probeEpisode?: number | null; rare: boolean; slotLimit?: number | null };
export type SeedsPoolInputNapi = { streams: AutofetchStreamIn[]; live: { minSeeders: number; topSeedsMax: number; ptFirst: boolean }; opts: { season?: number | null; queueDepth: number; rare: { max: number; threshold: number; maxSeeders: number } }; viableHashes: string[] };
export type SeedsPoolResultNapi = { candidates: number[]; immediateLimit: number; rareUsed: boolean };

/** Superfície napi das réguas avulsas (camelCase; o napi converte do snake_case). */
export type AutofetchRulesCore = {
  deadKey(adapterId: string, account: string, infoHash: string): string;
  overflowUpgradeAllowed(entries: ObraOverflowEntryNapi[], pool: string, quality: string): boolean;
  expiredRemovalAllowed(facts: ExpiredFactsNapi): boolean;
  classifyEnqueue(gates: EnqueueGatesIn): string | null;
  rollbackFor(reason: string): string[] | null;
  toQueueCandidate(stream: AutofetchStreamIn, pool: string, opts: QueueCandidateOptsRule): QueueCandidateRuleNapi;
  composeQueueEntries(primary: QueueEntryRuleNapi[], fallbacks: QueueEntryRuleNapi[], depth: number): QueueEntryRuleNapi[];
  pickSeedsPool(input: SeedsPoolInputNapi): SeedsPoolResultNapi;
  setTraceChupim(note: string, enabled: boolean): string | null;
  deriveStall(lot: ProgressLotNapi, statuses: Array<{ hash: string; status: TorrentStatusNapi }>): ProgressDerivationNapi;
  forgetProgress(adapterId: string, account: string, hash: string): number;
  progressMemorySize(): number;
};

function rulesCore(): AutofetchRulesCore {
  return requireCore() as unknown as AutofetchRulesCore;
}

/** `autofetch-keys.deadKey` — chave folha do registro de mortas. */
export function deadKey(adapterId: string, account: string, infoHash: string): string {
  return rulesCore().deadKey(adapterId, account, infoHash);
}

/** `autofetch-obra-overflow.overflowUpgradeAllowed` (C11): faixa-alvo ausente e superior. */
export function overflowUpgradeAllowed(entries: ObraOverflowEntryNapi[], input: { pool: string; quality?: string | null }): boolean {
  return rulesCore().overflowUpgradeAllowed(entries, String(input.pool || ''), String(input.quality || ''));
}

/** `autofetch-expired.expiredRemovalAllowed` — só a guarda; o IO dos fatos fica no chamador. */
export function expiredRemovalAllowed(facts: ExpiredFactsNapi): boolean {
  return rulesCore().expiredRemovalAllowed(facts);
}

/** `autofetch-gates.classifyEnqueue` — motivo do portão ou `null` com todos abertos. */
export function classifyEnqueue(gates: EnqueueGatesIn): string | null {
  return rulesCore().classifyEnqueue(gates);
}

/** Tabela do `ENQUEUE_ROLLBACK`: o que liberar, ou `null` para motivo fora dos portões. */
export function rollbackFor(reason: string): string[] | null {
  return rulesCore().rollbackFor(reason);
}

/** `autofetch-fallback.toQueueCandidate` — `_size` → `_packBytes` → `size` da fila. */
export function toQueueCandidate(
  stream: AutofetchRawStream & { infoHash: string; size?: number },
  pool: string,
  opts: QueueCandidateOptsRule,
): QueueCandidateRuleNapi {
  const explicit = Number(stream._size) || Number(stream._packBytes) || Number(stream.size);
  const sizeBytes = opts.sizeBytes ?? (explicit > 0 ? explicit : null);
  return rulesCore().toQueueCandidate(toStreamIn(stream), pool, { ...opts, sizeBytes });
}

/** `composeQueueEntries` — excedente primário primeiro, fallbacks na folga. */
export function composeQueueEntries(primary: QueueEntryRuleNapi[], fallbacks: QueueEntryRuleNapi[], depth: number): QueueEntryRuleNapi[] {
  return rulesCore().composeQueueEntries(primary, fallbacks, depth);
}

/** `pickSeedsPool` — recebe o universo JÁ filtrado por `filterSeedsUniverse`.
 *  Devolve ÍNDICES no array de `streams`, como o núcleo. */
export function pickSeedsPool(input: SeedsPoolInputNapi): SeedsPoolResultNapi {
  return rulesCore().pickSeedsPool(input);
}

/** `setTraceChupim` — resumo já sanitizado, ou `null` com o kill-switch desligado. */
export function chupimTraceSummary(note: string, enabled: boolean): string | null {
  return rulesCore().setTraceChupim(note, enabled);
}

/** `autofetch-progress.deriveStall` — a memória de processo mora no núcleo. */
export function deriveStall(lot: ProgressLotNapi, statuses: Record<string, TorrentStatusNapi>): ProgressDerivationNapi {
  const pairs = Object.entries(statuses).map(([hash, status]) => ({
    hash,
    status: status.id == null ? status : { ...status, id: String(status.id) },
  }));
  return rulesCore().deriveStall(lot, pairs);
}

/** Limpa UM hash; devolve o tamanho da memória depois (observabilidade). */
export function forgetProgress(adapterId: string, account: string, hash: string): number {
  return rulesCore().forgetProgress(adapterId, account, hash);
}

/** Limpa um lote inteiro (expira/evicção). */
export function forgetLotProgress(adapterId: string, account: string, hashes: Iterable<string>): number {
  const core = rulesCore();
  let size = 0;
  for (const hash of hashes) size = core.forgetProgress(adapterId, account, hash);
  return size;
}

/** Tamanho da memória de progresso — observabilidade de vazamento. */
export function progressMemorySize(): number {
  return rulesCore().progressMemorySize();
}
