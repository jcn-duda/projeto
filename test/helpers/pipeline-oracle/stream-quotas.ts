// Movido de src/utils/stream-quotas.ts na fase 1: sem chamador em produção desde o corte do
// /stream (F4.4); vive só para o oráculo congelado e os testes dele.
import type { Stream, StreamCandidate } from '../../../types/domain.js';
import { dropTrace } from '../../../src/utils/stream-trace.js';
import type { StreamTraceState, TraceReason } from '../../../src/utils/stream-trace.js';
import {
  QUALITY_KEYS,
  streamQuality,
  quotaStreamInput,
  selectQualityCandidates,
} from '../../../src/utils/stream-quotas-candidate.js';
import type { QualityLimits } from '../../../src/utils/stream-quotas-candidate.js';
import { nativeCore } from '../../../src/utils/native-core.js';
import { coreJson } from '../../../src/utils/native-json.js';

/**
 * Funções do CORTE FINAL no `.node` (camelCase do napi-rs). A decisão inteira
 * (reserva BR, cotas, troca do global por vaga garantida) é do núcleo; aqui só
 * se monta a entrada e se traduzem os índices — e o trace, que é I/O, fica
 * nesta casca.
 */
type StreamQuotasCore = {
  limitReservingBr(input: string): string;
  limitByQualityNapi(input: string): string;
  limitByQualityAndIndexerNapi(input: string): string;
  limitByIndexer(indexers: Array<string | null>, maxPerIndexer: number, exempt: number[], indexerLimits: QualityLimits): number[];
};

const quotasCore = () => nativeCore<StreamQuotasCore>();

/** Saída da ponte `limitReservingBr` (índices na lista ORIGINAL). */
interface LimitBrResult {
  selected: number[];
  eligible: number[];
  replaced: number[];
  dropped: { index: number; reason: string }[];
}

/**
 * Cota por indexador: teto de quantos streams cada fonte (YTS, BluDV, TheRARBG…)
 * pode ocupar na lista final. Sem isso um indexador com muitos resultados leva
 * quase todas as vagas e as outras fontes somem.
 *
 * `0` é SEM LIMITE, não "nenhum" — ao contrário das cotas por qualidade. Aqui o
 * default é desligado, e um 0 herdado de config antiga zerando a lista inteira
 * seria bem pior que um teto que não pega.
 *
 * `exempt` são as vagas reservadas BR: elas passam mesmo acima da cota, mas
 * continuam contando. Assim a reserva fura o teto sem ampliá-lo para os itens
 * seguintes da mesma fonte.
 */
function limitByIndexer(streams: StreamCandidate[], maxPerIndexer = 0, exempt: Set<StreamCandidate> = new Set(), indexerLimits: QualityLimits = {}) {
  // Regra no núcleo (`adom_core::limit_by_indexer`); entram só os indexadores
  // e os índices das vagas reservadas.
  const kept = quotasCore().limitByIndexer(
    streams.map((stream) => (stream?._indexer == null ? null : String(stream._indexer))),
    Number(maxPerIndexer) || 0,
    streams.flatMap((stream, index) => (exempt.has(stream) ? [index] : [])),
    indexerLimits || {},
  );
  return kept.map((index) => streams[index]);
}

/**
 * Aplica as duas cotas numa passada só. Se a cota individual rejeitar um item,
 * ele não pode consumir a vaga de qualidade — outra fonte precisa poder fazer
 * o backfill da lista final.
 */
function limitByQualityAndIndexer(
  streams: StreamCandidate[],
  qualityLimits: QualityLimits,
  maxPerIndexer: number,
  exempt: Set<StreamCandidate>,
  indexerLimits: QualityLimits,
  // Vagas reservadas para BR. Elas atravessam a cota do balde de qualidade E
  // não a consomem: "reservada" precisa significar vaga A MAIS, senão vira
  // apenas ordem de chegada dentro do mesmo teto.
  reservedBr: Set<StreamCandidate> = new Set(),
  // P5 — ledger observacional das cotas finais (null => sem efeito).
  trace?: StreamTraceState | null,
) {
  const indexesOf = (set: Set<StreamCandidate>) =>
    streams.flatMap((stream, index) => (set.has(stream) ? [index] : []));
  const result = JSON.parse(quotasCore().limitByQualityAndIndexerNapi(coreJson({
    streams: streams.map(quotaStreamInput),
    qualityLimits: qualityLimits || {},
    maxPerIndexer: Number(maxPerIndexer) || 0,
    exempt: indexesOf(exempt),
    indexerLimits: indexerLimits || {},
    reservedBr: indexesOf(reservedBr),
  }))) as { kept: number[]; dropped: { index: number; reason: string }[] };
  // Os cortes já vêm na ordem de visita, que é a ordem do ledger.
  for (const drop of result.dropped) dropTrace(trace, streams[drop.index], drop.reason as TraceReason);
  return result.kept.map((index) => streams[index]);
}

/** Aplica as cotas na lista pós-debrid, quando só os streams reais são contados. */
function limitByQuality(streams: StreamCandidate[], qualityLimits: QualityLimits = {}) {
  const kept = JSON.parse(quotasCore().limitByQualityNapi(coreJson({
    streams: streams.map(quotaStreamInput),
    qualityLimits: qualityLimits || {},
  }))) as number[];
  return kept.map((index) => streams[index]);
}

interface LimitBrOptions {
  brReservedSlots?: number;
  brReservedPerQuality?: number;
  maxResults?: number;
  brOnly?: boolean;
  qualityLimits?: QualityLimits;
  brFirst?: boolean;
  maxPerIndexer?: number;
  indexerLimits?: QualityLimits;
  /** Temporada pedida: liga a cobertura de pack por faixa (Causa D). */
  season?: number | null;
  /**
   * Callback interno de observabilidade: recebe os streams selecionados ANTES
   * de esta função limpar os campos internos (`_br`, `_seeders`, ...). É por
   * aqui que o `search.first.brVisible` vê a quantidade de fontes BR realmente
   * entregues — depois do `map` de limpeza os campos internos já não existem e
   * qualquer contagem de `_br` voltaria zero. Não faz parte do objeto público.
   */
  onSelected?: (selected: Stream[]) => void;
  /**
   * P5 — ledger observacional do corte final: quality-quota, indexer-limit,
   * max-results e o global trocado por vaga garantida BR. null => sem efeito.
   */
  trace?: StreamTraceState | null;
}

/** Reserva origem BR, aplica as cotas finais e remove todos os campos internos. */
function limitReservingBr(
  streams: Stream[],
  {
    brReservedSlots = 0,
    brReservedPerQuality = 0,
    maxResults = 40,
    brOnly = false,
    qualityLimits = {},
    brFirst = true,
    maxPerIndexer = 0,
    indexerLimits = {},
    season = null,
    onSelected,
    trace,
  }: LimitBrOptions = {},
) {
  // A decisão inteira é do núcleo (`adom_core::stream_quotas_extra`): reserva
  // BR (global e por faixa), cotas de qualidade/indexador e a troca do global
  // por vaga garantida. Aqui só se monta a entrada — `Stream` → campos que o
  // porte lê — e se traduzem os índices de volta.
  const result = JSON.parse(quotasCore().limitReservingBr(coreJson({
    streams: streams.map(quotaStreamInput),
    opts: {
      maxResults,
      qualityLimits,
      brReservedSlots,
      brReservedPerQuality,
      brFirst,
      maxPerIndexer,
      indexerLimits,
      brOnly,
      season: season == null ? null : season,
    },
  }))) as LimitBrResult;

  const selected = result.selected.map((index) => streams[index]);

  // P5 — ledger NA ORDEM do TS: os cortes de cota (`quality-quota`/
  // `indexer-limit`) na visita à lista reordenada e as trocas
  // (`br-guarantee-replaced`) na ordem do encaixa já vêm ordenados do núcleo.
  for (const drop of result.dropped) {
    dropTrace(trace, streams[drop.index], drop.reason as TraceReason);
  }
  // `max-results` é o diff `eligible − selected − replaced`, na ordem original;
  // os trocados já têm o motivo mais específico e não são re-registrados.
  const finais = new Set(result.selected);
  const trocadas = new Set(result.replaced);
  for (const index of result.eligible) {
    if (finais.has(index) || trocadas.has(index)) continue;
    dropTrace(trace, streams[index], 'max-results');
  }

  // Observa os selecionados ANTES da limpeza: é aqui que o `_br` ainda existe e
  // o `search.first.brVisible` pode medir quantas fontes BR realmente entregues.
  if (onSelected) onSelected(selected);

  return selected
    .map(({ _br, _seeders, _quality, _size, _dubbed, _dubClaim, _indexer, _tracker, _multiWork, _multiWorkAdmitted, _packBytes, _bytes, _lied, _seedFloorWaived, _magnetDn, ...stream }) => stream);
}

export {
  QUALITY_KEYS,
  streamQuality,
  selectQualityCandidates,
  limitByIndexer,
  limitByQualityAndIndexer,
  limitByQuality,
  limitReservingBr,
};

export type {
  QualityLimits,
  LimitBrOptions,
};
