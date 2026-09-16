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
// Fase 7 do Chupim 2.0 acrescenta o campo `chupim`: um resumo de UMA linha da
// decisão do autofetch daquela build (pool escolhido, decisão do pool seeds e
// estado da sonda), preenchido pelos pontos de decisão via `setTraceChupim`.
// É string fechada — nunca hash, obra, conta ou chave — e viaja no MESMO
// payload serializado do ledger; STREAM_TRACE=false não a grava nem a devolve.
//
// Regra de ouro: `trace` undefined/null em QUALQUER função => nada acontece.
// Nenhum call site é obrigado a checar o kill-switch antes de chamar.
import config from '../config.js';

/** Motivo pelo qual um item não está na lista final (ou é o aviso). */
export type TraceReason =
  | 'account-title'
  | 'account-magnet-year'
  | 'account-episode'
  | 'account-series-work'
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
  accountItems: number;
  startedAt: number;
  finishedAt: number | null;
  /** Resumo do Chupim (Fase 7): `pool=…; seeds=…; probe=…`. Ausente sem decisão
   * (o literal legado de teste/build antiga não precisa do campo). */
  chupim?: string | null;
}

/** Payload serializado — a única forma que atravessa para o cache. */
export interface SerializedStreamTrace {
  stages: Record<string, number>;
  items: TraceItem[];
  startedAt: number;
  finishedAt: number | null;
  /** Opcional por compatibilidade: entrada antiga não tem o campo. */
  chupim?: string;
}

// Teto de detalhe por trace: uma busca fria pode arrastar centenas de itens
// crus, e o payload é gravado junto da entrada de cache de 900s — sem teto,
// o diagnóstico viraria pressão nova na cota do namespace `streams`.
const STREAM_TRACE_MAX_ITEMS = 300;
// Os cortes `account-*` (filtro de relevância do inventário da conta) têm teto
// PRÓPRIO dentro do teto geral: uma conta populosa pode gerar centenas desses
// cortes numa busca só e consumiria o ledger inteiro, tirando o espaço do
// detalhe dos demais motivos (busca, qualidade, dedupe, debrid). Os ESTÁGIOS
// continuam exatos — o teto amosta só o detalhe por item, como o geral.
const STREAM_TRACE_MAX_ACCOUNT_ITEMS = 60;
// Rótulo é título de release; 60 caracteres bastam para identificar o post
// sem carregar a linha inteira (nem o que vier colado nela).
const STREAM_TRACE_LABEL_MAX = 60;
// Resumo do Chupim: três tokens de enum (`pool`, `seeds`, `probe`). O teto é
// folgado para o motivo do bloqueio e curto para o payload não crescer com
// dado de obra — o texto vem de call sites de confiança, mas passa pela mesma
// higiene do rótulo (magnet/hash fora).
const STREAM_TRACE_CHUPIM_MAX = 160;

/** Kill-switch do operador: STREAM_TRACE=0/false desliga a captura inteira. */
function traceEnabled(): boolean {
  return config.search.streamTrace !== false;
}

function createStreamTrace(): StreamTraceState {
  return { stages: {}, items: [], accountItems: 0, startedAt: Date.now(), finishedAt: null, chupim: null };
}

/** Copia a parte de coleta para uma build independente. A busca pode ter uma
 * resposta parcial e outra tardia; compartilhar o mesmo objeto faria os
 * cortes da primeira build contaminarem o ledger da segunda. */
function cloneStreamTrace(source: StreamTraceState | null | undefined): StreamTraceState | null {
  if (!source) return null;
  return {
    stages: { ...source.stages },
    items: source.items.map((item) => ({ ...item })),
    accountItems: source.accountItems,
    startedAt: source.startedAt,
    finishedAt: null,
    chupim: source.chupim ?? null,
  };
}

/** Conta itens num estágio do funil (raw, afterSort, final, notice...). */
function stageTrace(t: StreamTraceState | null | undefined, stage: string, count: number): void {
  if (!t || !stage || !Number.isFinite(count) || count <= 0) return;
  t.stages[stage] = (t.stages[stage] || 0) + Math.trunc(count);
}

/** Fixa um estágio mesmo quando o valor é zero. Em fontes externas, ausência
 * e zero têm significados diferentes: `account.read=20/account.kept=0` prova
 * que o inventário chegou e foi integralmente descartado. */
function setTraceStage(t: StreamTraceState | null | undefined, stage: string, count: number): void {
  if (!t || !stage || !Number.isFinite(count) || count < 0) return;
  t.stages[stage] = Math.trunc(count);
}

/** Higiene do resumo do Chupim: o texto é curto e de enum fechado, mas passa
 * pela MESMA defesa do rótulo (magnet/hash fora) antes de tocar o payload. */
function sanitizeChupimNote(note: unknown): string {
  const clean = String(note || '')
    .replace(/magnet:\?\S*/gi, '<magnet>')
    .replace(/[a-fA-F0-9]{40}/g, '<hash>');
  return clean.length > STREAM_TRACE_CHUPIM_MAX
    ? `${clean.slice(0, STREAM_TRACE_CHUPIM_MAX - 1)}…`
    : clean;
}

/**
 * Registra o resumo do autofetch (Fase 7). Last-writer: seleção e despacho
 * escrevem o mesmo formato e a decisão final é a que sai. No-op sem trace e
 * com STREAM_TRACE desligado (a captura também desliga, não só a leitura).
 */
function setTraceChupim(t: StreamTraceState | null | undefined, note: unknown): void {
  if (!t || !traceEnabled()) return;
  t.chupim = sanitizeChupimNote(note);
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
  // Teto de detalhe dos account-*: a partir daqui os cortes do inventário da
  // conta deixam de ser amostrados (os estágios seguem contando) para o
  // detalhe dos outros motivos sobreviver dentro do payload.
  const isAccount = String(reason).startsWith('account-');
  if (isAccount && t.accountItems >= STREAM_TRACE_MAX_ACCOUNT_ITEMS) return;
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
  if (isAccount) t.accountItems += 1;
}

/** Fecha o trace: fixa o tamanho final da lista e o instante de término. */
function finalizeTrace(t: StreamTraceState | null | undefined, finalCount: number): void {
  if (!t) return;
  t.finishedAt = Date.now();
  // 'final' é o tamanho ENTREGUE (o aviso entra na contagem), sobrescrevendo
  // o estágio provisório registrado antes do aviso de lista vazia.
  t.stages['final'] = Math.max(0, Math.trunc(Number(finalCount) || 0));
}

/** Única porta de saída de rótulos do diagnóstico (trace E recompute):
 * remove magnet/hash e aplica o mesmo teto de 60. A ordem importa: primeiro
 * consome a URI inteira do magnet (inclusive dn=), depois qualquer 40-hex que
 * tenha vindo fora dela. Centralizar evita a defesa existir só num dos dois
 * caminhos irmãos. */
function sanitizeTraceLabel(label: string): string {
  const clean = String(label || '')
    .replace(/magnet:\?\S*/gi, '<magnet>')
    .replace(/[a-fA-F0-9]{40}/g, '<hash>');
  return clean.length > STREAM_TRACE_LABEL_MAX
    ? `${clean.slice(0, STREAM_TRACE_LABEL_MAX - 1)}…`
    : clean;
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
    return {
      ...item,
      id: item.id || `s${index + 1}`,
      label: sanitizeTraceLabel(String(item?.label || '')),
      br: Boolean(item.br),
    };
  });
  return {
    stages,
    items,
    startedAt: Number(t.startedAt) || 0,
    finishedAt: typeof t.finishedAt === 'number' ? t.finishedAt : null,
    // Compat: entrada antiga (campo ausente) não ganha a chave; presente é
    // re-sanitizado e mantém a idempotência do payload gravado no cache.
    ...(t.chupim ? { chupim: sanitizeChupimNote(t.chupim) } : {}),
  };
}

export {
  STREAM_TRACE_MAX_ITEMS,
  STREAM_TRACE_MAX_ACCOUNT_ITEMS,
  STREAM_TRACE_LABEL_MAX,
  STREAM_TRACE_CHUPIM_MAX,
  createStreamTrace,
  cloneStreamTrace,
  stageTrace,
  setTraceStage,
  setTraceChupim,
  dropTrace,
  finalizeTrace,
  sanitizeTraceLabel,
  serializeTrace,
};
