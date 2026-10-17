import type { Stream, StreamCandidate } from '../../types/domain.js';
import { dropTrace } from './stream-trace.js';
import type { StreamTraceState, TraceReason } from './stream-trace.js';
import {
  QUALITY_KEYS,
  streamQuality,
  selectQualityCandidates,
} from './stream-quotas-candidate.js';
import type { QualityLimits } from './stream-quotas-candidate.js';
import { nativeCore } from './native-core.js';
import { coreJson } from './native-json.js';

/**
 * Funções do CORTE FINAL no `.node` (camelCase do napi-rs). A decisão inteira
 * (reserva BR, cotas, troca do global por vaga garantida) é do núcleo; aqui só
 * se monta a entrada e se traduzem os índices — e o trace, que é I/O, fica
 * nesta casca.
 */
type StreamQuotasCore = {
  limitReservingBr(input: string): string;
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
  const globalLimit = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));
  const hasOverrides = indexerLimits && typeof indexerLimits === 'object' &&
    Object.keys(indexerLimits).length > 0;
  if (!globalLimit && !hasOverrides) return streams;
  const counts = new Map();
  return streams.filter((stream) => {
    // Stream sem indexador conhecido não vira um balde comum com os outros:
    // eles se limitariam entre si por acidente de metadado ausente.
    const source = String(stream?._indexer || '').trim().toLowerCase();
    if (!source) return true;
    const ownLimit = Object.prototype.hasOwnProperty.call(indexerLimits, source)
      ? Math.max(0, Math.trunc(Number(indexerLimits[source]) || 0))
      : globalLimit;
    const count = counts.get(source) || 0;
    // A vaga reservada ESTOURA o teto, mas continua contando: se ela não
    // contasse, uma reserva de 2 com cota 1 deixaria passar um terceiro stream
    // da mesma fonte — a reserva ampliaria a cota em vez de só furá-la.
    if (exempt.has(stream)) {
      counts.set(source, count + 1);
      return true;
    }
    if (ownLimit && count >= ownLimit) return false;
    counts.set(source, count + 1);
    return true;
  });
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
  // apenas ordem de chegada dentro do mesmo teto -- que é o que era antes, e
  // fazia `brReservedSlots: 4` render 2 BR quando a cota de 1080p era 2.
  reservedBr: Set<StreamCandidate> = new Set(),
  // P5 — ledger observacional das cotas finais (null => sem efeito).
  trace?: StreamTraceState | null,
) {
  const qualityCounts = new Map();
  const indexerCounts = new Map();
  const globalLimit = Math.max(0, Math.trunc(Number(maxPerIndexer) || 0));

  return streams.filter((stream) => {
    const quality = streamQuality(stream);
    const rawQualityLimit = qualityLimits[quality];
    const qualityLimit = rawQualityLimit == null || rawQualityLimit >= 100
      ? Infinity
      : Math.max(0, Math.trunc(rawQualityLimit));
    const qualityCount = qualityCounts.get(quality) || 0;
    const reserved = reservedBr.has(stream);
    if (!reserved && qualityCount >= qualityLimit) {
      dropTrace(trace, stream, 'quality-quota');
      return false;
    }

    const source = String(stream?._indexer || '').trim().toLowerCase();
    const sourceCount = source ? indexerCounts.get(source) || 0 : 0;
    const sourceLimit = source && Object.prototype.hasOwnProperty.call(indexerLimits, source)
      ? Math.max(0, Math.trunc(Number(indexerLimits[source]) || 0))
      : globalLimit;
    if (source && !exempt.has(stream) && sourceLimit && sourceCount >= sourceLimit) {
      dropTrace(trace, stream, 'indexer-limit');
      return false;
    }

    // A reservada não entra na conta do balde: as globais mantêm a cota inteira
    // delas e a lista cresce, no máximo, o tamanho da reserva. O teto real
    // continua sendo maxResults, aplicado no fim de limitReservingBr.
    if (!reserved) qualityCounts.set(quality, qualityCount + 1);
    if (source) indexerCounts.set(source, sourceCount + 1);
    return true;
  });
}

/** Aplica as cotas na lista pós-debrid, quando só os streams reais são contados. */
function limitByQuality(streams: StreamCandidate[], qualityLimits: QualityLimits = {}) {
  const counts = new Map();
  return streams.filter((stream) => {
    const quality = streamQuality(stream);
    const rawLimit = qualityLimits[quality];
    const limit = rawLimit == null || rawLimit >= 100 ? Infinity : Math.max(0, Math.trunc(rawLimit));
    const count = counts.get(quality) || 0;
    if (count >= limit) return false;
    counts.set(quality, count + 1);
    return true;
  });
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
    streams: streams.map((stream) => ({
      // `qualityFromTitle` do núcleo lê o título; `name` é o fallback do TS.
      title: stream.title || stream.name || '',
      quality: stream._quality,
      indexer: stream._indexer,
      isBr: Boolean(stream._br),
      isDubbed: Boolean(stream._dubbed),
      isDubClaim: Boolean(stream._dubClaim),
      isLied: Boolean(stream._lied),
    })),
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
