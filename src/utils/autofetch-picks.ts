import type { Stream, DebridAdapter } from '../../types/domain.js';
import { sourceFromTitle } from './audio-quality.js';
import { dropTrace } from './stream-trace.js';
import type { StreamTraceState } from './stream-trace.js';
import {
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
} from './autofetch-pools.js';
import type { PoolsOptions, AutofetchTargetQuality } from './autofetch-pools.js';
import { streamQuality } from './stream-quotas.js';

interface AutofetchOptions {
  autoFetchBr?: boolean;
}

/**
 * Set de hashes comparável com `stream.infoHash`.
 *
 * O conjunto de cacheados é sempre minúsculo (debrid/index.js normaliza na ida,
 * os adapters na volta), mas o infoHash do stream vem cru do Jackett — e o
 * Torznab devolve o btih em MAIÚSCULO. Comparar os dois direto erra silencioso:
 * o hash cacheado não é reconhecido e o autofetch baixa o que já estava pronto.
 */
function hashSet(hashes: Iterable<string> | null | undefined) {
  return new Set([...(hashes || [])].map((h) => String(h || '').toLowerCase()).filter(Boolean));
}

/**
 * Seleciona até `limit` candidatos de um pool JÁ ordenado (a ordem é a
 * prioridade), sem olhar cache:
 *
 * - dedupe de hash case-insensitive (indexers BR às vezes alternam a caixa do
 *   btih entre os posts que duplicam a mesma release);
 * - pula hashes já em cache — não há o que baixar para eles;
 * - no máximo `limit` candidatos.
 */
function pickFromPool(pool: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  if (max === 0) return [];
  const cached = hashSet(cachedHashes);
  const seen = new Set();
  const out: Stream[] = [];
  for (const stream of pool) {
    if (!stream || !stream.infoHash) continue;
    const key = String(stream.infoHash).toLowerCase();
    if (seen.has(key) || cached.has(key)) continue;
    seen.add(key);
    out.push(stream);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Melhores candidatos BR dublados para o autofetch: o pool brDubbedPool já
 * ordena por marca de áudio, resolução e seeders.
 */
function pickBrDubbedCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(brDubbedPool(streams, options), cachedHashes, limit);
}

/**
 * Qualidades-alvo (720/1080/4K) do pool BR dublado que JÁ estão em cache.
 * Unknown/SD nunca entram — não contam como cobertura de upgrade.
 */
function cachedBrDubbedTargetQualities(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), options: PoolsOptions = {}) {
  const cached = hashSet(cachedHashes);
  const covered = new Set<AutofetchTargetQuality>();
  for (const stream of brDubbedPool(streams, options)) {
    const h = String(stream.infoHash || '').toLowerCase();
    if (!cached.has(h)) continue;
    const q = streamQuality(stream);
    if (isAutofetchTargetQuality(q)) covered.add(q);
  }
  return covered;
}

/**
 * Uncached por qualidade-alvo (1080 → 720 → 4K na ordem do pool).
 *
 * Com `limit` ≤ nº de faixas: 1 hash por faixa (primários).
 * Com `limit` maior (autoFetchMax + queueDepth): até K por faixa
 * (`ceil(limit / 3)`), primários primeiro e depois alternates — assim
 * `slice(0, autoFetchMax)` cobre as 3 faixas e o resto vira fila de
 * reposição no stall/dead. Sem isso a fila BR nascia vazia com Max=3.
 *
 * Se o pool BR não tem nenhum alvo (só unknown/SD), cai no pick clássico —
 * senão o Chupim pararia de esquentar fontes BR sem resolução no título.
 */
function pickBrDubbedByTargetQualities(
  streams: Stream[] = [],
  cachedHashes: Set<string> = new Set(),
  limit: number = AUTOFETCH_TARGET_QUALITIES.length,
  options: PoolsOptions = {},
) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  if (max === 0) return [];
  const pool = brDubbedPool(streams, options);
  const hasTarget = pool.some((s) => isAutofetchTargetQuality(streamQuality(s)));
  if (!hasTarget) return pickFromPool(pool, cachedHashes, max);

  const targetCount = AUTOFETCH_TARGET_QUALITIES.length;
  const perQuality = max <= targetCount
    ? 1
    : Math.max(1, Math.ceil(max / targetCount));

  const cached = hashSet(cachedHashes);
  const seenHash = new Set<string>();
  const countQ = new Map<string, number>();
  const primaries: Stream[] = [];
  const alternates: Stream[] = [];

  // Passo A: 1º uncached por faixa — primários sempre antes dos backups.
  for (const stream of pool) {
    if (!stream?.infoHash) continue;
    const key = String(stream.infoHash).toLowerCase();
    if (seenHash.has(key) || cached.has(key)) continue;
    const q = streamQuality(stream);
    if (!isAutofetchTargetQuality(q) || countQ.has(q)) continue;
    countQ.set(q, 1);
    seenHash.add(key);
    primaries.push(stream);
    if (primaries.length >= max) return primaries.slice(0, max);
  }

  if (perQuality <= 1 || primaries.length >= max) return primaries.slice(0, max);

  // Passo B: alternates até K por faixa / até encher o limit.
  for (const stream of pool) {
    if (primaries.length + alternates.length >= max) break;
    if (!stream?.infoHash) continue;
    const key = String(stream.infoHash).toLowerCase();
    if (seenHash.has(key) || cached.has(key)) continue;
    const q = streamQuality(stream);
    if (!isAutofetchTargetQuality(q)) continue;
    const n = countQ.get(q) || 0;
    if (n === 0 || n >= perQuality) continue;
    countQ.set(q, n + 1);
    seenHash.add(key);
    alternates.push(stream);
  }

  return [...primaries, ...alternates].slice(0, max);
}

/** Compatibilidade: o melhor candidato BR dublado, sem olhar cache. */
function pickBrDubbedCandidate(streams: Stream[] = [], cachedHashes: Set<string> = new Set()) {
  return pickBrDubbedCandidates(streams, cachedHashes, 1)[0] || null;
}

/** Candidatos do fallback global: mesmas regras do pick BR, sobre anyDubbedPool. */
function pickAnyDubbedCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(anyDubbedPool(streams, options), cachedHashes, limit);
}

function pickTopSeededCandidates(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 1, options: PoolsOptions = {}) {
  return pickFromPool(topSeededPool(streams, options), cachedHashes, limit);
}

/**
 * Já existe fonte BR dublada tocável? Diagnóstico e fallback do ramo sem
 * qualidade-alvo (unknown/SD). O stop do pool `br` com alvos 720/1080/4K
 * usa `cachedBrDubbedTargetQualities` — este predicao NÃO bloqueia upgrade.
 */
function hasCachedBrDubbed(streams: Stream[] = [], cachedHashes: Set<string> = new Set()) {
  const cached = hashSet(cachedHashes);
  return brDubbedPool(streams).some((s) => cached.has(String(s.infoHash || '').toLowerCase()));
}

function canAutoFetchBr({ autoFetchBr }: AutofetchOptions = {}, adapter?: DebridAdapter | null) {
  // cachedOnly não é mais trava: o objetivo do autofetch é justamente esquentar
  // o cache quando não há BR dublada pronta, independente do modo. As travas
  // reais são o toggle, o cacheCheck confiável ou fonte de autofetch por inventário (RD/DL).
  return Boolean(autoFetchBr && (adapter?.cacheCheck || adapter?.autofetchSource));
}

/**
 * Exceção explícita ao cachedOnly: as fontes globais continuam instantâneas,
 * mas as vagas reservadas BR não viram um vazio quando o dublado ainda não
 * chegou ao debrid. O stream fica como torrent P2P, sem selo ⚡.
 */
function uncachedBrHashes(streams: Stream[] = [], cachedHashes: Set<string> = new Set(), limit = 0) {
  const selected = new Set<string>();
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  const cached = hashSet(cachedHashes);
  // Mesmo pool do autofetch: a vaga P2P tem que ser o torrent que vamos baixar,
  // não um LEGENDADO que só estava mais acima na lista.
  for (const stream of brDubbedPool(streams)) {
    if (selected.size >= max) break;
    if (!cached.has(String(stream.infoHash || '').toLowerCase())) {
      selected.add(String(stream.infoHash));
    }
  }
  return selected;
}

function filterKnownCache(
  streams: Stream[] = [],
  cachedHashes: Set<string> = new Set(),
  {
    cachedOnly = true,
    showUncachedBr = false,
    brReservedSlots = 0,
    known = true,
    missHashes,
    trace,
  }: {
    cachedOnly?: boolean;
    showUncachedBr?: boolean;
    brReservedSlots?: number;
    known?: boolean;
    missHashes?: Set<string>;
    trace?: StreamTraceState | null;
  } = {},
) {
  const cached = hashSet(cachedHashes);
  const miss = missHashes ? hashSet(missHashes) : null;
  const cachedBr = brDubbedPool(streams).filter((stream) =>
    cached.has(String(stream.infoHash || '').toLowerCase()),
  ).length;
  const uncachedSlots = Math.max(0, Math.trunc(Number(brReservedSlots) || 0) - cachedBr);
  const visibleBr = cachedOnly && showUncachedBr
    ? uncachedBrHashes(streams, cached, uncachedSlots)
    : new Set();
  return {
    visibleBr,
    streams: streams.filter((stream) => {
      if (!cachedOnly) return true;
      const h = String(stream.infoHash || '').toLowerCase();
      if (cached.has(h) || visibleBr.has(String(stream.infoHash))) return true;
      if (known) {
        // P5 — corte do cachedOnly: o hash não está em cache e a conta
        // respondeu completa. É o corte mais comum de "sumiu o dublado".
        dropTrace(trace, stream, 'cached-only');
        return false;
      }
      if (miss) {
        // P5 — recusa ternária do RD: o ledger confirmou MISS (ou blocked)
        // para o hash. É um corte por evidência, não por falta de resposta.
        if (miss.has(h)) {
          dropTrace(trace, stream, 'rd-miss');
          return false;
        }
      }
      return true;
    }),
  };
}

export {
  hashSet,
  pickFromPool,
  pickBrDubbedCandidates,
  pickBrDubbedByTargetQualities,
  cachedBrDubbedTargetQualities,
  pickBrDubbedCandidate,
  pickAnyDubbedCandidates,
  pickTopSeededCandidates,
  hasCachedBrDubbed,
  canAutoFetchBr,
  uncachedBrHashes,
  filterKnownCache,
};

export type { AutofetchOptions };
