import type { Stream, DebridAdapter } from '../../types/domain.js';
import {
  UNKNOWN_QUALITY,
  audioFromTitle,
  sourceFromTitle,
  hasExplicitForeignAudio,
  looksPtBr,
  hasPtSigns,
} from './audio-quality.js';
import { isSeasonPackRelease } from './episode-matching.js';
import { streamQuality } from './stream-quotas.js';
import { dropTrace } from './stream-trace.js';
import type { StreamTraceState } from './stream-trace.js';

interface PoolsOptions {
  season?: number | null;
  minSeeders?: number;
  /**
   * Preferência PT no pool de swarm: candidato com sinal de português vence
   * a contagem bruta de seeders. É PREFERÊNCIA, não filtro — sem nenhum
   * candidato PT a ordenação por seeders continua valendo.
   */
  ptFirst?: boolean;
}

interface AutofetchOptions {
  autoFetchBr?: boolean;
}

// Peso de resolução dos pools de autofetch (BR e global): 1080p/720p vencem
// 2160p porque o download esquenta o cache para o play rápido, não para baixar
// o maior arquivo; SD fica por último.
const DUBBED_QUALITY_WEIGHT: Record<string, number> = {
  '1080p': 6,
  '720p': 5,
  '2160p': 4,
  [UNKNOWN_QUALITY]: 3,
  '480p': 2,
  SD: 1,
};

// Faixas que o Chupim cobre com 1 download cada. 4K e 2160p são o mesmo
// balde canônico (`2160p`). Unknown/SD/480p ficam de fora — não abrem nem
// fecham vaga de upgrade entre essas três.
const AUTOFETCH_TARGET_QUALITIES = Object.freeze(['1080p', '720p', '2160p'] as const);
type AutofetchTargetQuality = (typeof AUTOFETCH_TARGET_QUALITIES)[number];

function isAutofetchTargetQuality(q: string): q is AutofetchTargetQuality {
  return (AUTOFETCH_TARGET_QUALITIES as readonly string[]).includes(q);
}

/**
 * O que mandar o debrid baixar quando falta cobertura BR dublada por faixa.
 *
 * Cuidado deliberado aqui, porque o efeito é escrever na conta do usuário:
 * - só olha o que tem infoHash (stream já resolvido não tem o que enfileirar);
 * - cobertura é POR qualidade-alvo (720/1080/4K): 720 Dual ⚡ não bloqueia
 *   o upgrade 1080/4K; as três faixas cobertas é que param o Chupim;
 * - BR sem marca de áudio no título entra como dublado só quando nenhum
 *   candidato tiver a marca: é o padrão dos sites BR ("Nome (2026) [opção 3]"),
 *   mas um "LEGENDADO" explícito nunca é tratado como dublado.
 *
 */
function brDubbedPool(streams: Stream[] = [], { season }: PoolsOptions = {}) {
  const br = streams.filter(
    (s) => s && s.infoHash && s._br && sourceFromTitle(s.title || s.name || '') !== 'CAM',
  );
  if (br.length === 0) return [];
  const tagged = br.filter((s) => s._dubbed);
  const candidates = tagged.length
    ? tagged
    : br.filter((s) => audioFromTitle(s.title || s.name || '') !== 'Legendado');

  // Pré-computado uma vez: o sort consultaria o mesmo parse n·log n vezes.
  const packOf = season == null
    ? null
    : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));

  return [...candidates].sort((a, b) => {
    // 1. Quem tem marcação explícita de dublado/dual/nacional
    const dubDiff = (b._dubbed ? 1 : 0) - (a._dubbed ? 1 : 0);
    if (dubDiff !== 0) return dubDiff;

    // 2. Pack da temporada pedida (só em busca de série): um download serve o
    // binge inteiro em vez de um episódio, e vale mais que resolução/seeders.
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff !== 0) return packDiff;
    }

    // 3. Resolução ideal para download e playback rápido
    const qA = streamQuality(a);
    const qB = streamQuality(b);
    const qDiff = (DUBBED_QUALITY_WEIGHT[qB] || 0) - (DUBBED_QUALITY_WEIGHT[qA] || 0);
    if (qDiff !== 0) return qDiff;

    // 4. Mais seeders para o debrid baixar o torrent rapidamente
    return (b._seeders || 0) - (a._seeders || 0);
  });
}

/**
 * Pool do fallback global do autofetch: quando a busca não achou NENHUMA fonte
 * BR dublada, o que resta baixar são as releases com áudio dublado/dual/
 * nacional marcado no título (`_dubbed`). Sem a marca não entra — fora dos
 * sites BR o padrão é o contrário, legendado domina, e o fallback "sem marca
 * vale como dublado" do pool BR encheria a conta com o que o usuário não
 * pediu. (BR elegível aqui é impossível na prática: se existisse, o pool BR
 * já teria sido escolhido no lugar deste.)
 *
 */
function anyDubbedPool(streams: Stream[] = [], { season }: PoolsOptions = {}) {
  const candidates = streams.filter(
    (s) => s && s.infoHash && s._dubbed && sourceFromTitle(s.title || s.name || '') !== 'CAM',
  );
  // Mesmo bônus de pack do pool BR, pré-computado para o sort.
  const packOf = season == null
    ? null
    : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));
  return [...candidates].sort((a, b) => {
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff !== 0) return packDiff;
    }
    const qDiff =
      (DUBBED_QUALITY_WEIGHT[streamQuality(b)] || 0) - (DUBBED_QUALITY_WEIGHT[streamQuality(a)] || 0);
    if (qDiff !== 0) return qDiff;
    return (b._seeders || 0) - (a._seeders || 0);
  });
}

/**
 * Pool de segurança: prioriza o swarm, não a resolução, para o download terminar.
 *
 */
function topSeededPool(
  streams: Stream[] = [],
  { season, minSeeders = 0, ptFirst = true }: PoolsOptions = {},
) {
  const seedersOf = (s: any) => Number(s?._seeders ?? (String(s?.name || '').match(/👤\s*(\d+)/)?.[1] || 0));
  const candidates = streams.filter((s) =>
    s && s.infoHash && sourceFromTitle(s.title || s.name || '') !== 'CAM' &&
    seedersOf(s) >= minSeeders && !hasExplicitForeignAudio(s.title || s.name || ''),
  );
  const packOf = season == null ? null : new Map(candidates.map((s) => [s, isSeasonPackRelease(s, season)]));
  // Pré-computado uma vez, como o packOf: o sort consultaria o parse do mesmo
  // título n·log n vezes. Marca de áudio PT (looksPtBr) ou título que denuncia
  // português (hasPtSigns) — a rede de segurança baixava a release estrangeira
  // com mais pares e o usuário ficava sem dublagem mesmo havendo alternativa.
  const ptOf = ptFirst
    ? new Map(candidates.map((s) => {
      const t = String(s.title || s.name || '');
      return [s, looksPtBr(t) || hasPtSigns(t)];
    }))
    : null;
  return [...candidates].sort((a, b) => {
    if (packOf) {
      const packDiff = (packOf.get(b) ? 1 : 0) - (packOf.get(a) ? 1 : 0);
      if (packDiff) return packDiff;
    }
    // Entre o pack e os seeders: o candidato com sinal PT baixa primeiro.
    if (ptOf) {
      const ptDiff = (ptOf.get(b) ? 1 : 0) - (ptOf.get(a) ? 1 : 0);
      if (ptDiff) return ptDiff;
    }
    const seedDiff = seedersOf(b) - seedersOf(a);
    if (seedDiff) return seedDiff;
    return (DUBBED_QUALITY_WEIGHT[streamQuality(b)] || 0) - (DUBBED_QUALITY_WEIGHT[streamQuality(a)] || 0);
  });
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
 * 1 hash uncached por qualidade-alvo (1080 → 720 → 4K na ordem do pool).
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

  const cached = hashSet(cachedHashes);
  const seenQ = new Set<string>();
  const seenHash = new Set<string>();
  const out: Stream[] = [];
  for (const stream of pool) {
    if (!stream?.infoHash) continue;
    const key = String(stream.infoHash).toLowerCase();
    if (seenHash.has(key) || cached.has(key)) continue;
    const q = streamQuality(stream);
    if (!isAutofetchTargetQuality(q) || seenQ.has(q)) continue;
    seenQ.add(q);
    seenHash.add(key);
    out.push(stream);
    if (out.length >= max) break;
  }
  return out;
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
  DUBBED_QUALITY_WEIGHT,
  AUTOFETCH_TARGET_QUALITIES,
  isAutofetchTargetQuality,
  brDubbedPool,
  anyDubbedPool,
  topSeededPool,
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

export type { PoolsOptions, AutofetchOptions, AutofetchTargetQuality };
