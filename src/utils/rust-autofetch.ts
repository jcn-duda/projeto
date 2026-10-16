/**
 * Sombra do lote de seleção do autofetch (Chupim) em Rust
 * (`evaluateAutofetchCandidates`, composição dos módulos `autofetch_*`).
 *
 * A seleção real continua no TS (`autofetch-candidates.ts`): o runner é dono
 * dos portões, das travas (holds), da sonda BR, da fila persistida e do waiver
 * do piso. Aqui só REPETIMOS a parte determinística da cascata `br → any →
 * seeds` numa ÚNICA chamada napi, AGENDADA com `setImmediate` — o napi por
 * chamada é mais lento que o TS, então nada roda no caminho da resposta.
 *
 * O TS já calculou `immediate`/`queue` antes de chamar `observeAutofetch`; a
 * sombra copia esses fatos (strings puras, sem referência aos itens vivos do
 * pipeline) e compara com o Rust depois. Divergência vira métrica
 * (`rust.autofetch.*`) e log com teto — nunca muda a resposta.
 *
 * `off` (default) ou núcleo ausente = no-op. `shadow` e `on` fazem a mesma
 * comparação; a promoção para usar o valor do Rust é passo futuro (espelha o
 * `rust-release-index.ts`), já que os portões/travas/sonda ficam no Node.
 */
import config from '../config.js';
import * as log from './logger.js';
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
  evaluateAutofetchCandidates?(input: AutofetchInputNapi): AutofetchDecisionNapi;
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

/** Snapshot sincrônico da decisão do TS + fatos para reconstruir a entrada. */
export type AutofetchCapture = {
  streams: AutofetchRawStream[];
  pool: string;
  immediateHashes: string[];
  queueEntries: Array<{ hash: string; pool: string }>;
  season?: number | null;
  queueDepth: number;
  live: AutofetchLiveSubset;
  policy: { dubbedOnly: boolean; cachedOnly: boolean; maxSizeGb: number; seedsMaxGb: number; seedsMaxQuality: string };
  autoFetchBr: boolean;
  adapter: { cacheCheck?: boolean; autofetchSource?: boolean } | null;
  /** Fato do oráculo: o `seedsSelectionBlock` da busca (bloqueia seeds). */
  seedsBlocked?: boolean;
};

type GetCore = () => AutofetchCore | null;

let getCore: GetCore | null = null;
let loggedDiffs = 0;
let warnedNoFn = false;

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

function noteMissing() {
  if (warnedNoFn) return;
  warnedNoFn = true;
  log.info('[rust] núcleo sem evaluateAutofetchCandidates (binário antigo); sombra do autofetch desligada');
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function logDiff(c: AutofetchCapture, part: string, ts: string, rust: string) {
  metrics.count('rust.autofetch.divergence');
  if (loggedDiffs >= config.rustCore.maxLoggedDiffs) return;
  loggedDiffs += 1;
  log.warn(`[rust] autofetch divergiu (${part}): pool=${c.pool} ts=${ts} rust=${rust}`);
}

function compare(c: AutofetchCapture, d: AutofetchDecisionNapi) {
  const rustImm = (d.immediates || []).map((x) => String(x.infoHash || '').toLowerCase());
  const tsImm = c.immediateHashes.map((h) => h.toLowerCase());
  if (!sameList(tsImm, rustImm)) logDiff(c, 'immediates', tsImm.join(','), rustImm.join(','));

  const rustQueue = (d.queue || []).map((x) => `${String(x.infoHash || '').toLowerCase()}:${x.pool}`);
  const tsQueue = c.queueEntries.map((e) => `${e.hash.toLowerCase()}:${e.pool}`);
  if (!sameList(tsQueue, rustQueue)) logDiff(c, 'queue', tsQueue.join(','), rustQueue.join(','));

  // Na seleção os portões estão abertos: nenhum lado deve produzir skip.
  const rustSkips = (d.skips || []).map((s) => s.reason);
  if (rustSkips.length > 0) logDiff(c, 'skips', '', rustSkips.join(','));
}

/**
 * Agenda a comparação do lote. Copia os fatos (strings puras) de forma
 * síncrona — o pipeline muta os itens depois — e chama o napi no `setImmediate`.
 */
export function observeAutofetch(capture: AutofetchCapture): void {
  try {
    if (config.rustAutofetch.mode === 'off' || !getCore) return;
    const core = getCore();
    const fn = core?.evaluateAutofetchCandidates;
    if (typeof fn !== 'function') {
      noteMissing();
      return;
    }
    const input = buildInput(capture);
    const snapshot: AutofetchCapture = {
      ...capture,
      immediateHashes: capture.immediateHashes.slice(),
      queueEntries: capture.queueEntries.slice(),
    };
    metrics.count('rust.autofetch.calls');
    setImmediate(() => {
      try {
        compare(snapshot, fn(input));
      } catch (err) {
        metrics.count('rust.autofetch.error');
        log.debug('[rust] autofetch lançou no lote:', log.errorMessage(err));
      }
    });
  } catch (err) {
    metrics.count('rust.autofetch.error');
    log.debug('[rust] autofetch não agendou:', log.errorMessage(err));
  }
}

/** A sombra está ligada? O runner usa para nem montar o snapshot no off. */
export function autofetchShadowEnabled(): boolean {
  return config.rustAutofetch.mode !== 'off';
}

function installAutofetchHook(get: GetCore) {
  getCore = get;
}

function resetAutofetchHook() {
  getCore = null;
  loggedDiffs = 0;
  warnedNoFn = false;
}

export { installAutofetchHook, resetAutofetchHook };
