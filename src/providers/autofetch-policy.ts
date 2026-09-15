import type { Stream, StreamCandidate } from '../../types/domain.js';
import { UNKNOWN_QUALITY, streamQuality } from '../utils/format.js';
import { streamTitleBytes } from './episode-size.js';

// Política do pool `seeds` do Chupim (Fase 1 do Chupim 2.0). Módulo PURO: só
// decide, não seleciona, não segura hash, não escreve fila. As decisões
// intrínsecas do CANDIDATO (qualidade/tamanho/dubbedOnly) e de DESPACHO
// (continuar/parar o aquecimento; drenar/descartar da fila) moram aqui para o
// runner/recheck/fallback compartilharem a mesma regra sem depender de um
// objeto de config inteiro.
//
// Regra de ouro do módulo: nada aqui finge conhecer cache. O que depende de
// `cached` (stop-has-cached, exceção do título raro) entra como parâmetro já
// medido pelo checkCached — a decisão é função do resultado, nunca um palpite
// tomado antes da checagem.

export type SeedsRejectReason = 'seeds-size-unknown' | 'seeds-too-big' | 'seeds-quality';
export type SeedsSelectionBlock = 'dubbed-only' | 'seeds-playable';
export type SeedsStopReason = 'stop-has-br' | 'stop-has-cached';
export type SeedsDrainReason = SeedsRejectReason | 'dubbed-only';

export type SeedsPolicyConfig = {
  /** `opts().dubbedOnly` — instalação que só aceita dublado. */
  dubbedOnly: boolean;
  /** `opts().debridCachedOnly` — decide se a lista P2P conta como tocável. */
  cachedOnly: boolean;
  /** `opts().maxSizeGb` — teto do usuário (0 = sem teto). */
  maxSizeGb: number;
  /** `DEBRID_AUTO_FETCH_SEEDS_MAX_GB` — teto do pool seeds (0 = sem teto). */
  seedsMaxGb: number;
  /** `DEBRID_AUTO_FETCH_SEEDS_MAX_QUALITY` — faixa máxima aceita. */
  seedsMaxQuality: string;
};

// Forma mínima que a policy lê de um stream: os pitches do pool seeds e o que
// o candidato persistido da fila carrega (`quality`/`size` sem underscore).
type SeedsCandidate = {
  _size?: unknown;
  _packBytes?: unknown;
  _quality?: unknown;
  quality?: unknown;
  // Campo persistido da fila (`toQueueCandidate`): sem underscore, sobrevive
  // ao round-trip do SQLite quando `_size`/`_packBytes` não existem mais.
  size?: unknown;
  title?: unknown;
  name?: unknown;
};

const BYTES_PER_GB = 1024 ** 3;
const DEFAULT_SEEDS_MAX_QUALITY = '1080p';
// Ordem canônica de resolução: maior = melhor. Chave ausente e UNKNOWN_QUALITY
// (rank 0) são "não sei" — recusadas de propósito (conservador).
const QUALITY_RANK: Record<string, number> = {
  '2160p': 5,
  '1080p': 4,
  '720p': 3,
  '480p': 2,
  SD: 1,
  [UNKNOWN_QUALITY]: 0,
};
const VALID_SEEDS_QUALITIES = new Set(['2160p', '1080p', '720p', '480p', 'SD']);
// `sourceFromTitle` reconhece BDREMUX como BluRay, mas NÃO separa REMUX do
// resto; esta regex é a marca própria do teto (BDREMUX e REMUX solto).
const REMUX_RE = /\b(?:BD)?REMUX\b/i;

/** Normaliza o teto de qualidade: valor fora do vocabulário cai no default. */
export function normalizeSeedsMaxQuality(value: unknown): string {
  const q = String(value ?? '').trim();
  return VALID_SEEDS_QUALITIES.has(q) ? q : DEFAULT_SEEDS_MAX_QUALITY;
}

/**
 * Teto efetivo de tamanho, em bytes. O menor entre o teto do pool e o do
 * usuário manda; 0 no pool desliga a metade do pool (o `opts().maxSizeGb`
 * continua valendo sozinho, se setado). 0 nos dois = sem teto de tamanho —
 * o tamanho desconhecido segue recusado.
 */
export function effectiveSeedsMaxBytes(cfg: Pick<SeedsPolicyConfig, 'seedsMaxGb' | 'maxSizeGb'>): number {
  const seeds = Math.max(0, Number(cfg.seedsMaxGb) || 0);
  const user = Math.max(0, Number(cfg.maxSizeGb) || 0);
  const gb = user > 0 ? (seeds > 0 ? Math.min(seeds, user) : user) : seeds;
  return gb > 0 ? gb * BYTES_PER_GB : 0;
}

/** Tamanho do DOWNLOAD: `_size` → `_packBytes` → `size` da fila → marker do título. */
export function seedsDownloadBytes(stream: SeedsCandidate | null | undefined): number {
  const explicit = Number(stream?._size) || Number(stream?._packBytes) || Number(stream?.size);
  if (explicit > 0) return explicit;
  return streamTitleBytes(stream?.title);
}

/**
 * Recusa por qualidade. REMUX/BDREMUX é recusado SEMPRE (mesmo em 1080p):
 * release remasterizada costuma ser gigante e o pool é para esquentar play
 * rápido. Qualidade desconhecida também é recusada — não dá para provar que
 * está dentro do teto.
 */
export function seedsQualityReject(stream: SeedsCandidate | null | undefined, maxQuality: unknown): 'seeds-quality' | null {
  const title = String(stream?.title || stream?.name || '');
  if (REMUX_RE.test(title)) return 'seeds-quality';
  const explicit = stream?._quality ?? stream?.quality;
  const quality = explicit != null && String(explicit).length > 0
    ? String(explicit)
    : streamQuality(stream as StreamCandidate);
  const rank = QUALITY_RANK[quality];
  const cap = QUALITY_RANK[normalizeSeedsMaxQuality(maxQuality)];
  if (rank == null || rank === 0) return 'seeds-quality';
  if (rank > cap) return 'seeds-quality';
  return null;
}

/** Recusa por tamanho: desconhecido (`seeds-size-unknown`) ou acima do teto. */
export function seedsSizeReject(stream: SeedsCandidate | null | undefined, maxBytes: number): 'seeds-size-unknown' | 'seeds-too-big' | null {
  const size = seedsDownloadBytes(stream);
  if (!(size > 0)) return 'seeds-size-unknown';
  if (maxBytes > 0 && size > maxBytes) return 'seeds-too-big';
  return null;
}

/** Regras intrínsecas do candidato seeds (qualidade antes de tamanho). */
export function seedsIntrinsicRejection(stream: SeedsCandidate | null | undefined, cfg: SeedsPolicyConfig): SeedsRejectReason | null {
  const quality = seedsQualityReject(stream, cfg.seedsMaxQuality);
  if (quality) return quality;
  return seedsSizeReject(stream, effectiveSeedsMaxBytes(cfg));
}

/**
 * Filtra o universo ANTES de `pickSeedsPool` e devolve a contagem por motivo
 * (o chamador registra uma vez por motivo — sem inflar a tabela de skips com
 * um registro por candidato recusado).
 */
export function filterSeedsUniverse<T extends Stream>(
  streams: T[],
  cfg: SeedsPolicyConfig,
): { eligible: T[]; rejected: Map<SeedsRejectReason, number> } {
  const eligible: T[] = [];
  const rejected = new Map<SeedsRejectReason, number>();
  for (const stream of streams) {
    const reason = seedsIntrinsicRejection(stream as SeedsCandidate, cfg);
    if (reason) {
      rejected.set(reason, (rejected.get(reason) || 0) + 1);
    } else {
      eligible.push(stream);
    }
  }
  return { eligible, rejected };
}

/**
 * Stream tocável de verdade. Item de AVISO carrega `externalUrl` mas não toca;
 * `notice: true` é o único jeito de distingui-lo aqui — sem isso o aviso de
 * lista vazia contaria como play disponível e seeds nunca seria acionado.
 */
export function hasPlayableStream(streams: Array<Stream | null | undefined>): boolean {
  for (const stream of streams) {
    if (!stream) continue;
    const s = stream as { notice?: unknown; url?: unknown; infoHash?: unknown; externalUrl?: unknown };
    if (s.notice) continue;
    if (typeof s.url === 'string' && s.url) return true;
    if (typeof s.infoHash === 'string' && s.infoHash) return true;
    if (typeof s.externalUrl === 'string' && s.externalUrl) return true;
  }
  return false;
}

/**
 * Bloqueio de SELEÇÃO do pool seeds, avaliável antes do checkCached:
 * - `dubbed-only`: a instalação só quer dublado; seeds é, por definição, o
 *   que sobrou sem áudio PT;
 * - `seeds-playable`: fora do modo `cachedOnly` a lista já entrega P2P tocável,
 *   então baixar swarm é desperdício. No modo `cachedOnly` a lista visível pode
 *   estar vazia e o veredicto fica para DEPOIS da checagem.
 */
export function seedsSelectionBlock(
  cfg: Pick<SeedsPolicyConfig, 'dubbedOnly' | 'cachedOnly'>,
  streams: Array<Stream | null | undefined>,
): SeedsSelectionBlock | null {
  if (cfg.dubbedOnly) return 'dubbed-only';
  if (!cfg.cachedOnly && hasPlayableStream(streams)) return 'seeds-playable';
  return null;
}

/**
 * Decisão de parada do pool seeds com o cache JÁ conhecido. Extraída do
 * `applySeedsStopGate` para a regra ficar testável sem fila/holds:
 * - dublado em cache (BR ou global) para com `stop-has-br`;
 * - qualquer cache com a exceção raro-sobre-cache DESLIGADA para com
 *   `stop-has-cached`;
 * - a exceção só existe com regime raro real, `cacheCheck` efetivo e o knob
 *   `rareOverCached` ligado.
 */
export function decideSeedsStop(input: {
  hasCachedDubbed: boolean;
  cachedCount: number;
  rare: boolean;
  rareThreshold: number;
  adapterCacheCheck: boolean;
  rareOverCached: boolean;
}): { stop: SeedsStopReason | null; rareOverCached: boolean } {
  if (input.hasCachedDubbed) return { stop: 'stop-has-br', rareOverCached: false };
  if (input.cachedCount === 0) return { stop: null, rareOverCached: false };
  if (!(input.rare && input.rareThreshold > 0 && input.adapterCacheCheck && input.rareOverCached)) {
    return { stop: 'stop-has-cached', rareOverCached: false };
  }
  return { stop: null, rareOverCached: true };
}

/**
 * Regras PERMANENTES revalidadas no dreno: config que não vai mudar dentro da
 * vida da fila (`dubbedOnly`) e propriedade do próprio candidato (qualidade/
 * tamanho). Bloqueio transitório (cooldown, orçamento, br-probe futuro) NÃO
 * entra aqui — esses pertencem ao `deferFn` do `takeNext`.
 */
export function seedsDrainRejection(candidate: SeedsCandidate | null | undefined, cfg: SeedsPolicyConfig): SeedsDrainReason | null {
  if (cfg.dubbedOnly) return 'dubbed-only';
  return seedsIntrinsicRejection(candidate, cfg);
}
