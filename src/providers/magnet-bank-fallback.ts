// Fallback do banco de magnets vivo (Etapa 4): quando um indexer Jackett falha
// MEDIDAMENTE na coleta da obra, o acervo persistido daquele indexer volta como
// item de reserva — com o selo honesto (📦/~N) e SEM alimentar índice, banco,
// Chupim ou warmer (o vivo e o histórico continuam sendo a autoridade).
//
// Desenho (as travas da revisão adversarial):
// 1. Só indexer FALHO entra. O estado vivo (`live-indexer-state.ts`) decide
//    quem falhou; pendente no prazo conta como falho (contrato explícito do
//    usuário) e é removido quando a resposta tardia chega. `allFailed` (ramo
//    `/all` em erro/pendente) aceita qualquer source do banco — nunca uma
//    config vazia. `passed_filter` NÃO é critério de elegibilidade: o item
//    sempre passa pelo filtro de título ATUAL no build (1 é dado auxiliar).
// 2. VIVO VENCE SEMPRE: hash do lote vivo (`hashOf`) é cortado ANTES do build,
//    independentemente de seeders. Quando o live tardio chega, a reconstrução
//    remove o fallback do mesmo hash.
// 3. Zero auto-perpetuação: `fromFallback` é excluído da captura do banco, do
//    `releaseIndex.record`, das pools/candidatos do autofetch e do warmer.
// 4. O item passa pelo MESMO `buildStreams` (título/episódio/multiobra, mag
//    bad/lie/debrid/cotas/MIN_SEEDERS) — sem bypass além do selo/origem.
import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import * as bank from '../utils/magnet-bank.js';
import { worksForObraMany, sourcesForMany } from '../utils/magnet-bank-query.js';
import type { MagnetRow, SourceRow, WorkRow } from '../utils/magnet-bank.js';
import { stageTrace, dropTrace } from '../utils/stream-trace.js';
import type { StreamTraceState } from '../utils/stream-trace.js';
import type { LiveIndexerState } from './live-indexer-state.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';

export interface FallbackRequest {
  /** 'movie' | 'series' — filme só consulta a obra raiz. */
  type: string;
  imdbId: string;
  season: number | null;
  episode: number | null;
  /** Hashes já presentes no lote VIVO: fallback para eles é redundante. */
  liveHashes: ReadonlySet<string>;
  /** Indexers que falharam/pendem (já normalizados). */
  failedIndexers: ReadonlySet<string>;
  /** Ramo `/all` em erro/pendente: todos os indexers do banco são candidatos. */
  allFailed: boolean;
  trace?: StreamTraceState | null;
}

export interface FallbackResult {
  items: RawItem[];
  injected: number;
  cut: Record<string, number>;
}

/** Motivos de corte, na ordem em que são contados. */
export type FallbackCut = 'lied' | 'no-hash' | 'live-dedupe' | 'no-source' | 'cap-indexer' | 'cap-global';

/** Amostra de cortes no ledger: o teto global é 300 e a pré-seleção pode gerar
 * centenas — 20 preserva o diagnóstico sem consumir o payload das demais fases. */
const TRACE_SAMPLE_MAX = 20;

/** Piso do teto por indexer (o config já clampa em 1..40). */
const PER_INDEXER_MAX = 40;

const nIndexer = (value: unknown) => String(value || '').trim().toLowerCase();

/** Id de métrica seguro: o nome do indexer vem de config/terceiro. */
function safeMetricId(value: unknown): string {
  const clean = nIndexer(value).replace(/[^a-z0-9_.-]/g, '_').slice(0, 40);
  return clean || 'unknown';
}

/**
 * Obras a consultar para o pedido. Filme: só a raiz (season/episode nulos).
 * Série: episódio pedido, pack da temporada e série completa — o pack achado
 * numa busca de episódio fica recuperável para os demais (release-work.ts).
 */
function obraTargets(type: string, season: number | null, episode: number | null) {
  if (type === 'movie' || season == null) return [{ season: null, episode: null }];
  const out: Array<{ season: number | null; episode: number | null }> = [];
  if (episode != null) out.push({ season, episode });
  out.push({ season, episode: null });
  out.push({ season: null, episode: null });
  return out;
}

type Candidate = { magnet: MagnetRow; source: SourceRow; work: WorkRow };

/** Fonte elegível: indexer falho; com `allFailed`, qualquer source do banco. */
function pickSource(sources: readonly SourceRow[], failedIndexers: ReadonlySet<string>, allFailed: boolean): SourceRow | null {
  const eligible = allFailed
    ? sources
    : sources.filter((source) => failedIndexers.has(nIndexer(source.indexer)));
  if (eligible.length === 0) return null;
  // Mais recente primeiro (fonte com a última observação viva).
  return eligible.reduce((best, current) => (current.lastSeen > best.lastSeen ? current : best));
}

function toRawItem(candidate: Candidate): RawItem {
  const { magnet, source } = candidate;
  const uri = String(magnet.uri || '');
  return {
    title: magnet.title || 'Torrent',
    infoHash: magnet.hash,
    ...(uri.startsWith('magnet:') ? { magnet: uri } : {}),
    ...(magnet.size > 0 ? { size: magnet.size } : {}),
    // Número REAL preservado: o `~` é só exibição; ranking, MIN_SEEDERS e
    // filtros usam o seedersLast medido (nunca um valor inventado pelo selo).
    seeders: magnet.seedersLast,
    indexer: source.indexer,
    tracker: source.tracker || '',
    isBr: Boolean(magnet.isBr),
    dubbed: Boolean(magnet.dubbed),
    quality: magnet.quality || '',
    fromFallback: true,
    fallbackIndexer: source.indexer,
  };
}

/**
 * Monta os itens de fallback da obra. Fail-open: qualquer falha do banco
 * devolve lista vazia (a busca segue sem reserva), com warn e métrica — nunca
 * derruba a resposta.
 */
export function collectFallbackItems(req: FallbackRequest): FallbackResult {
  const empty: FallbackResult = { items: [], injected: 0, cut: {} };
  const cut: Record<string, number> = {};
  let traced = 0;
  const countCut = (reason: FallbackCut, magnet?: MagnetRow | null) => {
    cut[reason] = (cut[reason] || 0) + 1;
    metrics.count(`fallback.items.cut.${reason}`);
    if (magnet && traced < TRACE_SAMPLE_MAX) {
      traced += 1;
      dropTrace(req.trace, { title: magnet.title }, 'fallback');
    }
  };

  try {
    if (!config.magnetBank?.enabled || !config.magnetBank?.fallbackEnabled) return empty;
    const imdbId = String(req.imdbId || '');
    if (!imdbId || !imdbId.startsWith('tt')) return empty;
    if (req.failedIndexers.size === 0 && !req.allFailed) return empty;

    const perIndexerMax = Math.max(1, Math.min(PER_INDEXER_MAX, Math.trunc(config.magnetBank.fallbackMaxPerIndexer) || PER_INDEXER_MAX));
    const globalMax = Math.max(1, Math.min(500, Math.trunc(config.magnetBank.fallbackGlobalMax) || 40));
    // Leitura conservadora: no máximo o dobro do necessário para encher o teto
    // global, por alvo. Sem isto o fallback lia 3×400 works + getMagnet de cada
    // um no caminho da resposta.
    const readLimit = Math.min(200, Math.max(globalMax, perIndexerMax) * 2);
    const maxTotal = globalMax * 3;

    const rows = worksForObraMany(imdbId, obraTargets(req.type, req.season, req.episode), readLimit, maxTotal);
    const magnets = new Map<string, MagnetRow>();
    const works = new Map<string, WorkRow>();
    for (const row of rows) {
      const magnet = row.magnet;
      if (!magnet || !row.work || !magnet.hash) { if (row.work) countCut('no-hash'); continue; }
      if (magnet.lied) { countCut('lied', magnet); continue; }
      if (!magnets.has(magnet.hash)) { magnets.set(magnet.hash, magnet); works.set(magnet.hash, row.work); }
    }

    const sourcesByHash = sourcesForMany([...magnets.keys()]);
    const candidates: Candidate[] = [];
    for (const [hash, magnet] of magnets) {
      if (req.liveHashes.has(hash)) { countCut('live-dedupe', magnet); continue; }
      const source = pickSource(sourcesByHash.get(hash) || [], req.failedIndexers, req.allFailed);
      if (!source) { countCut('no-source', magnet); continue; }
      candidates.push({ magnet, source, work: works.get(hash)! });
    }

    // seedersMax desc, lastSeen desc (a ordenação que o pedido define).
    candidates.sort((a, b) => {
      if (b.magnet.seedersMax !== a.magnet.seedersMax) return b.magnet.seedersMax - a.magnet.seedersMax;
      return b.magnet.lastSeen - a.magnet.lastSeen;
    });

    const items: RawItem[] = [];
    const perIndexer = new Map<string, number>();
    for (const candidate of candidates) {
      if (items.length >= globalMax) { countCut('cap-global', candidate.magnet); continue; }
      const indexerId = nIndexer(candidate.source.indexer) || 'unknown';
      const usedByIndexer = perIndexer.get(indexerId) || 0;
      if (usedByIndexer >= perIndexerMax) { countCut('cap-indexer', candidate.magnet); continue; }
      perIndexer.set(indexerId, usedByIndexer + 1);
      items.push(toRawItem(candidate));
      metrics.count(`fallback.indexer.${safeMetricId(indexerId)}`);
    }

    if (items.length > 0) metrics.count('fallback.items.injected', items.length);
    stageTrace(req.trace, 'fallback', items.length);
    if (items.length > 0) {
      log.info(`[fallback] ${items.length} item(ns) do banco para ${imdbId}${req.season != null ? ` S${req.season}${req.episode != null ? `E${req.episode}` : ''}` : ''}`);
    }
    return { items, injected: items.length, cut };
  } catch (err: unknown) {
    metrics.count('fallback.error');
    log.warn('[fallback] banco de magnets falhou; seguindo sem reserva:', log.errorMessage(err));
    return empty;
  }
}

/**
 * Reserva para UMA build do `finish`: só consulta o banco quando o estado vivo
 * aponta falha. `items` é o lote VIVO — `hashOf` deles é a exclusão que faz o
 * vivo vencer sempre, independentemente de seeders.
 */
export function collectFallbackForBuild(args: {
  live: LiveIndexerState | null | undefined;
  items: readonly RawItem[];
  type: string;
  imdbId: string;
  season: number | null;
  episode: number | null;
  trace?: StreamTraceState | null;
}): FallbackResult {
  const { live } = args;
  if (!live || !live.hasAnyFailure()) return { items: [], injected: 0, cut: {} };
  const liveHashes = new Set<string>();
  for (const item of args.items) {
    const hash = bank.hashOf(item);
    if (hash) liveHashes.add(hash);
  }
  return collectFallbackItems({
    type: args.type, imdbId: args.imdbId, season: args.season, episode: args.episode,
    liveHashes,
    failedIndexers: live.failedIndexers(),
    allFailed: live.allFailed(),
    trace: args.trace,
  });
}
