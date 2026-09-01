// Ledger observacional do pipeline de busca (P5 Fase 0). Cada corte que uma
// release sofre no caminho raw → streams fica registrado aqui, e o rastro
// viaja DENTRO da entrada `streams` do cache — é isso que permite ao
// /stream-trace.json responder OFFLINE, sem refazer a busca nem tocar no
// Jackett ou no debrid.
//
// Puro por contrato: nenhuma chamada de rede, nenhum timer, nenhum estado de
// módulo. Módulos de busca podem importá-lo sem arrastar runtime/debrid
// (mesma razão do cache-keys.ts). O único import é o config — leitura
// estática de env, sem efeito colateral.
//
// Regra de ouro: `trace` undefined/null em QUALQUER função => nada acontece.
// Nenhum call site é obrigado a checar o kill-switch antes de chamar.
import config from '../config.js';

/** Motivo pelo qual um item não está na lista final (ou é o aviso). */
export type TraceReason =
  | 'title-filter'
  | 'multiwork-retained'
  | 'episode-mismatch'
  | 'no-hash'
  | 'dedupe'
  | 'min-seeders'
  | 'quality-filter'
  | 'cam-excluded'
  | 'size-limit'
  | 'pool-cut'
  | 'bad'
  | 'dead'
  | 'lie'
  | 'idx-miss'
  | 'cached-only'
  | 'rd-miss'
  | 'quality-quota'
  | 'indexer-limit'
  | 'max-results'
  | 'br-guarantee-replaced'
  | 'notice';

/** Um item cortado (ou o aviso de lista vazia) com o motivo do corte. */
export interface TraceItem {
  /** Identificador sintético ("s1", "s2", ...). NUNCA o infoHash: o payload
   * viaja no cache e o endpoint não pode virar lista de hashes. */
  id: string;
  reason: TraceReason;
  label: string;
  br: boolean;
  dubbed?: boolean;
  quality?: string;
}

/** Estado do ledger de UMA build. Vive entre os passes do `finish` e só sai
 * do processo na forma serializada (serializeTrace). */
export interface StreamTraceState {
  stages: Record<string, number>;
  items: TraceItem[];
  startedAt: number;
  finishedAt: number | null;
}

/** Payload serializado — a única forma que atravessa para o cache. */
export interface SerializedStreamTrace {
  stages: Record<string, number>;
  items: TraceItem[];
  startedAt: number;
  finishedAt: number | null;
}

// Teto de detalhe por trace: uma busca fria pode arrastar centenas de itens
// crus, e o payload é gravado junto da entrada de cache de 900s — sem teto,
// o diagnóstico viraria pressão nova na cota do namespace `streams`.
const STREAM_TRACE_MAX_ITEMS = 300;
// Rótulo é título de release; 60 caracteres bastam para identificar o post
// sem carregar a linha inteira (nem o que vier colado nela).
const STREAM_TRACE_LABEL_MAX = 60;

/** Kill-switch do operador: STREAM_TRACE=0/false desliga a captura inteira. */
function traceEnabled(): boolean {
  return config.search.streamTrace !== false;
}

function createStreamTrace(): StreamTraceState {
  return { stages: {}, items: [], startedAt: Date.now(), finishedAt: null };
}

/** Conta itens num estágio do funil (raw, afterSort, final, notice...). */
function stageTrace(t: StreamTraceState | null | undefined, stage: string, count: number): void {
  if (!t || !stage || !Number.isFinite(count) || count <= 0) return;
  t.stages[stage] = (t.stages[stage] || 0) + Math.trunc(count);
}

/** Rótulo legível a partir de qualquer forma de item (raw tem title, stream
 * tem name; o aviso chega como `{name}`). Só a primeira linha: no stream o
 * título fica antes do \n. */
function labelOf(item: unknown): string {
  const it = item as { title?: unknown; Title?: unknown; name?: unknown } | null | undefined;
  return String(it?.title || it?.Title || it?.name || '').split('\n')[0];
}

/**
 * Registra UM item cortado com o motivo. Chamado nos pontos de corte já
 * existentes do pipeline; sem trace, é um no-op (uma checagem de null).
 */
function dropTrace(t: StreamTraceState | null | undefined, item: unknown, reason: TraceReason): void {
  if (!t || t.items.length >= STREAM_TRACE_MAX_ITEMS) return;
  const raw = (item ?? {}) as Record<string, unknown>;
  // Campos internos (_br/_dubbed/_quality) e brutos (isBr) convivem: o ledger
  // roda tanto sobre itens crus (pré-toStremioStream) quanto sobre streams.
  t.items.push({
    id: `s${t.items.length + 1}`,
    reason,
    label: labelOf(item),
    br: Boolean(raw._br ?? raw.isBr),
    ...(raw._dubbed !== undefined ? { dubbed: Boolean(raw._dubbed) } : {}),
    ...(raw._quality ? { quality: String(raw._quality) } : {}),
  });
}

/** Fecha o trace: fixa o tamanho final da lista e o instante de término. */
function finalizeTrace(t: StreamTraceState | null | undefined, finalCount: number): void {
  if (!t) return;
  t.finishedAt = Date.now();
  // 'final' é o tamanho ENTREGUE (o aviso entra na contagem), sobrescrevendo
  // o estágio provisório registrado antes do aviso de lista vazia.
  t.stages['final'] = Math.max(0, Math.trunc(Number(finalCount) || 0));
}

/** Limpa o rótulo de tudo que o endpoint não pode expor: hash do magnet e
 * URI de magnet. O título do post pode carregar o dn= cru do indexer. */
function sanitize(label: string): string {
  return label
    .replace(/magnet:\?\S*/gi, '<magnet>')
    .replace(/[a-fA-F0-9]{40}/g, '<hash>');
}

/**
 * Payload seguro para o cache/endpoint. Devolve null sem trace ou com o
 * kill-switch desligado — os call sites gravam `trace: null` nesse caso. A
 * entrada antiga sem o campo também devolve null. Idempotente de propósito:
 * o payload gravado no cache volta a passar por aqui na leitura do endpoint
 * (mesma forma do estado).
 */
function serializeTrace(
  t: StreamTraceState | SerializedStreamTrace | null | undefined,
): SerializedStreamTrace | null {
  if (!t || !traceEnabled()) return null;
  const stages: Record<string, number> = {};
  for (const [stage, count] of Object.entries(t.stages || {})) {
    const n = Number(count);
    if (Number.isFinite(n)) stages[stage] = n;
  }
  const items = (t.items || []).slice(0, STREAM_TRACE_MAX_ITEMS).map((item, index) => {
    const label = sanitize(String(item?.label || ''));
    return {
      ...item,
      id: item.id || `s${index + 1}`,
      // O teto do rótulo vale já truncado; o -1 reserva o lugar do "…".
      label: label.length > STREAM_TRACE_LABEL_MAX
        ? `${label.slice(0, STREAM_TRACE_LABEL_MAX - 1)}…`
        : label,
      br: Boolean(item.br),
    };
  });
  return {
    stages,
    items,
    startedAt: Number(t.startedAt) || 0,
    finishedAt: typeof t.finishedAt === 'number' ? t.finishedAt : null,
  };
}

export {
  STREAM_TRACE_MAX_ITEMS,
  STREAM_TRACE_LABEL_MAX,
  createStreamTrace,
  stageTrace,
  dropTrace,
  finalizeTrace,
  serializeTrace,
};
