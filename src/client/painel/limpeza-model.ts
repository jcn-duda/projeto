// Modelo puro da aba Limpeza: tradução dos contratos reais do backend e
// derivação de resumo/tabela. Sem DOM, sem preact — só dado → dado, o que
// torna cada função testável direto. Extraído de view-limpeza.ts pela catraca
// de 400 linhas; o componente reexporta para preservar o import dos testes.
import { contaView } from './conta-model.js';

export interface DedupPreviewSummary {
  ok: boolean;
  reason: string | null;
  t1Groups: number;
  t2Groups: number;
  candidates: any[];
  t1: any[];
  t2: any[];
  /** Soma dos tamanhos que saem (bytes); 0 quando o plano não traz tamanho. */
  bytesFreed: number;
}

/** Bytes que o plano tiraria da conta: a soma dos `size` de cada kill. */
function sumKillBytes(candidates: any[]): number {
  return candidates.reduce((acc: number, k: any) => acc + (Number(k?.size) || 0), 0);
}

/**
 * Traduz o contrato REAL de `dedup-preview` (`{ ok, plan: { t1, t2 } }`, ou
 * `{ ok:false, reason }`) para o que a tela mostra. A versão anterior lia
 * `previewResult.scanned`, que não existe em nenhuma das respostas — a contagem
 * saía sempre 0. Grupos e alvos são contados de `plan`.
 */
export function dedupPreviewSummary(data: Record<string, any> | null | undefined): DedupPreviewSummary {
  if (!data || data.ok === false) {
    const reason = String(data?.reason || data?.error || 'erro') + (data?.hint ? ` — ${data.hint}` : '');
    return { ok: false, reason, t1Groups: 0, t2Groups: 0, candidates: [], t1: [], t2: [], bytesFreed: 0 };
  }
  const plan = data.plan || {};
  const t1 = Array.isArray(plan.t1) ? plan.t1 : [];
  const t2 = Array.isArray(plan.t2) ? plan.t2 : [];
  const candidates = [
    ...t1.flatMap((g: any) => (Array.isArray(g?.kill) ? g.kill : []).map((k: any) => ({ ...k, group: 'T1 (mesmo hash)', keep: g.keep }))),
    ...t2.flatMap((g: any) => (Array.isArray(g?.kill) ? g.kill : []).map((k: any) => ({ ...k, group: 'T2 (mesmo arquivo)', keep: g.keep }))),
  ];
  return { ok: true, reason: null, t1Groups: t1.length, t2Groups: t2.length, candidates, t1, t2, bytesFreed: sumKillBytes(candidates) };
}

export interface CatalogSummary {
  ok: boolean;
  reason: string | null;
  magnets: number;
  ready: number;
  knownWorks: number;
  unknownWorks: number;
  totalCount: number;
  totalBytes: number;
  byBucket: Record<string, { count: number; bytes: number }>;
}

const EMPTY_REPORT: Omit<CatalogSummary, 'ok' | 'reason'> = {
  magnets: 0, ready: 0, knownWorks: 0, unknownWorks: 0, totalCount: 0, totalBytes: 0, byBucket: {},
};

/**
 * Contrato real do bloco `catalog` / ação `catalog-report`:
 * `{ ok:true, report:{ magnets, ready, works:{known,unknown}, totals:{count,bytes}, byBucket } }`
 * ou `{ ok:false, reason, hint? }`. A versão anterior lia `cat.works`/`cat.magnets`
 * no topo do payload — nenhum desses campos existe ali, tudo saía 0.
 */
export function catalogSummary(data: Record<string, any> | null | undefined): CatalogSummary {
  if (!data) return { ok: false, reason: null, ...EMPTY_REPORT };
  if (data.ok === false) {
    const reason = String(data.reason || data.error || 'indisponível') + (data.hint ? ` — ${data.hint}` : '');
    return { ok: false, reason, ...EMPTY_REPORT };
  }
  const report = data.report || {};
  return {
    ok: true,
    reason: null,
    magnets: Number(report.magnets || 0),
    ready: Number(report.ready || 0),
    knownWorks: Number(report.works?.known || 0),
    unknownWorks: Number(report.works?.unknown || 0),
    totalCount: Number(report.totals?.count || 0),
    totalBytes: Number(report.totals?.bytes || 0),
    byBucket: report.byBucket || {},
  };
}

/** Contagem medida ou "?" — varredura que não rodou não removeu zero, não removeu nada. */
function sweepCount(value: unknown): string {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? String(n) : '?';
}

/** Motivo vindo da rede como texto: objeto/array nunca vira `[object Object]`. */
function reasonKey(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 60);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Motivos do gateway e da ponte em PT-BR. As chaves são o vocabulário ESTÁVEL
 * do Rust (`SweepStop`, `disabledReason` e `reasons`) mais as da ponte
 * (`sweeps-native.ts`), que é quem cria `reentered`/`bridge-*`. `Map` de
 * propósito: um objeto indexado por chave da rede devolveria `constructor` e
 * `__proto__` herdados onde o certo é "desconhecido".
 */
const SWEEP_REASON_LABELS = new Map<string, string>([
  ['ready', 'pronto no cache do debrid'],
  ['preexisting', 'já existia antes da varredura'],
  ['protected', 'protegido (retenção/autofetch)'],
  ['missing', 'não está mais na conta'],
  ['stale', 'obsoleto'],
  ['too_young', 'novo demais para varrer'],
  ['no_upload_date', 'sem data de upload'],
  ['quota', 'cota do serviço esgotada'],
  ['auth', 'credencial recusada pelo serviço'],
  ['cleanup_off', 'limpeza desligada no gateway'],
  ['holds_off', 'holds desligados (sem guarda de posse)'],
  ['no_operator_account', 'sem conta do operador configurada'],
  ['http_client_unavailable', 'cliente HTTP do gateway indisponível'],
  ['not_wired', 'varredura não fiada no gateway'],
  ['no_destructive_token', 'sem token destrutivo para aplicar'],
  ['inventory_missing', 'inventário da conta ainda não carregado'],
  // Motivos da PONTE (`sweeps-native.ts`), não do gateway.
  ['reentered', 'outra varredura em andamento'],
  ['bridge-backoff', 'ponte em espera depois de falhas seguidas'],
  ['bridge-error', 'falha de rede falando com o gateway'],
  ['invalid_kind', 'tipo de varredura inválido'],
  ['sweeps_disabled', 'varreduras desligadas no gateway'],
  ['sweeps_unavailable', 'varreduras indisponíveis no gateway'],
]);

/**
 * Motivo legível. Desconhecido não vira `undefined` nem `[object Object]`: sai
 * como "motivo: <chave>", que ainda diz ao operador o que procurar no gateway.
 */
export function sweepReasonLabel(value: unknown): string {
  const key = reasonKey(value);
  if (!key) return 'motivo não informado';
  return SWEEP_REASON_LABELS.get(key) ?? `motivo: ${key}`;
}

/** Desfechos da varredura manual. A view escolhe a COR por ele — `waiting`
 * (409 `reentered` ou prazo da ponte) é ESPERA, nunca falha. */
export type SweepOutcome = 'done' | 'stopped' | 'waiting' | 'planned' | 'refused';

/**
 * Classifica o resultado de `POST /sweeps/run` devolvido pela ponte:
 *
 *  - `waiting` → `busy`/`reentered` (outra rodada em voo) e `pending`/`timedOut`;
 *  - `stopped` → a rodada foi INTERROMPIDA (`quota`, `auth`) e não terminou;
 *  - `refused` → nem começou (`ran:false`, ou `reason` sem nenhuma medida);
 *  - `planned` → rodou em modo leitura e não removeu nada;
 *  - `done` → rodou até o fim.
 */
export function sweepOutcome(result: Record<string, any> | null | undefined): SweepOutcome {
  const r = result && typeof result === 'object' ? result : {};
  if (r.busy === true || r.reason === 'reentered') return 'waiting';
  if (r.pending === true || r.timedOut === true) return 'waiting';
  if (r.stopped != null) return 'stopped';
  if (r.ran === false) return 'refused';
  // Resposta antiga/sem medida: `reason` sem `ran`/`applied` nunca rodou.
  if (r.reason != null && r.ran !== true && r.applied == null) return 'refused';
  if (r.applied === false) return 'planned';
  return 'done';
}

/**
 * Toast do `sweep-dead` (rota NATIVA da AllDebrid ou adaptador legado). Separa
 * os desfechos que o operador NÃO pode confundir: concluída, interrompida (com
 * o `stopped` em PT-BR) e recusada/em espera. `busy` não é erro — é "outra
 * varredura em andamento".
 *
 * `result` nulo/estranho cai nas contagens ausentes, que viram "?" em vez de
 * anunciar uma remoção que ninguém mediu.
 */
export function sweepToast(result: Record<string, any> | null | undefined): string {
  const r = result && typeof result === 'object' ? result : {};
  const outcome = sweepOutcome(r);
  if (outcome === 'waiting') {
    if (r.busy === true || r.reason === 'reentered') {
      return 'Outra varredura em andamento; aguarde o ciclo atual terminar';
    }
    return 'Varredura em andamento; acompanhe o status nativo';
  }
  if (outcome === 'refused') {
    return r.reason == null
      ? 'Varredura recusada pelo gateway'
      : `Varredura recusada · ${sweepReasonLabel(r.reason)}`;
  }
  if (outcome === 'stopped') {
    return `Varredura interrompida (${sweepReasonLabel(r.stopped)}): ` +
      `${sweepCount(r.varridos ?? r.swept)} removido(s) até parar`;
  }
  if (outcome === 'planned') {
    return `Plano: ${sweepCount(r.planned ?? r.varridos)} alvo(s) · modo leitura, nada removido`;
  }
  const falhas = Number(r.falhas ?? r.failed);
  const suffix = Number.isFinite(falhas) && falhas > 0 ? ` · ${falhas} falha(s)` : '';
  return `Varredura concluída: ${sweepCount(r.varridos ?? r.swept)} removido(s)${suffix}`;
}

/**
 * Próximo estado de `catalogData` a partir do resultado de uma tentativa.
 * Falha de TRANSPORTE (HTTP 401/429/503 ou rede) NUNCA pode deixar o painel
 * preso em "Carregando catálogo…": sem relatório bom, grava `{ok:false, reason}`
 * e o botão "Atualizar Catálogo" continua disponível para o retry. Com relatório
 * bom já carregado, uma falha transitória o preserva (429 de refresh não apaga
 * o que estava na tela). HTTP 200 com `ok:false` do servidor é RESPOSTA (ex.:
 * conta do operador indisponível) e é usada como veio.
 */
export function nextCatalogState(
  prev: Record<string, any> | null,
  result: { ok: boolean; data?: Record<string, any>; error?: string },
): Record<string, any> {
  if (result.ok) {
    return result.data ?? { ok: false, reason: 'resposta vazia do servidor' };
  }
  const hasGoodReport = Boolean(prev && prev.ok !== false && prev.report);
  if (hasGoodReport) return prev as Record<string, any>;
  return { ok: false, reason: result.error || 'falha ao carregar catálogo', retry: true };
}

/** Baldes de áudio que o relatório do catálogo agrega. */
export const CATALOG_BUCKETS = ['dub', 'dual', 'pt', 'lixo'];

export function bucketLabel(bucket: string): string {
  if (bucket === 'dub') return 'Dublado';
  if (bucket === 'dual') return 'Dual';
  if (bucket === 'pt') return 'Português';
  if (bucket === 'lixo') return 'Lixo / indefinido';
  return bucket;
}

export interface CatalogBucketRow {
  key: string;
  label: string;
  count: number;
  bytes: number;
}

/** Uma linha por balde conhecido, com zeros preenchidos: o painel mostra a
 * composição inteira, não só os baldes que apareceram no relatório. */
export function catalogBucketRows(summary: CatalogSummary): CatalogBucketRow[] {
  return CATALOG_BUCKETS.map((key) => {
    const meta = summary.byBucket?.[key] || { count: 0, bytes: 0 };
    return { key, label: bucketLabel(key), count: Number(meta.count || 0), bytes: Number(meta.bytes || 0) };
  });
}

export interface DedupPlanView {
  t1Groups: number;
  t2Groups: number;
  candidates: any[];
  t1: any[];
  t2: any[];
  bytesFreed?: number;
}

/** Só permite aplicar quando a prévia rodou E achou alvos: aplicar um plano
 * com zero kills é uma chamada destrutiva sem efeito. */
export function canApplyDedup(preview: DedupPlanView | null | undefined): boolean {
  return Boolean(preview && Array.isArray(preview.candidates) && preview.candidates.length > 0);
}

export interface LimpezaHeader {
  duplicates: number;
  t1Groups: number;
  t2Groups: number;
  bytesFreed: number;
  previewState: 'idle' | 'empty' | 'ready';
  accountService: string;
  accountTotal: number;
  accountCap: number;
  accountReady: number;
  accountDead: number;
}

/**
 * Resumo operacional compacto. `preview` é a prévia JÁ calculada (não o payload
 * cru): `idle` = nunca rodou, `empty` = rodou e nada a remover, `ready` = há
 * alvos. A conta usa `contaView(conta, debrid)` — o MESMO bloco que a aba
 * Conta exibe — para não mostrar "Conta —" quando o bloco cru está vazio mas
 * o operador tem conta no servidor.
 */
export function limpezaHeader(
  preview: DedupPlanView | null | undefined,
  conta: Record<string, any> | null | undefined,
  debrid?: Record<string, any> | null | undefined,
): LimpezaHeader {
  const cv = contaView(conta, debrid);
  const candidates = preview && Array.isArray(preview.candidates) ? preview.candidates : [];
  const t1Groups = Number(preview?.t1Groups || 0);
  const t2Groups = Number(preview?.t2Groups || 0);
  return {
    duplicates: candidates.length,
    t1Groups,
    t2Groups,
    bytesFreed: Number(preview?.bytesFreed) || sumKillBytes(candidates),
    previewState: preview == null ? 'idle' : candidates.length > 0 ? 'ready' : 'empty',
    accountService: cv.service,
    accountTotal: cv.total,
    accountCap: cv.cap,
    accountReady: cv.ready,
    accountDead: cv.dead,
  };
}

export interface DedupRowView {
  hashShort: string;
  filename: string;
  sizeBytes: number;
  group: string;
  keepShort: string;
}

function shortHash(value: unknown): string {
  const text = String(value || '');
  return text ? text.slice(0, 8) : '—';
}

/** Normaliza os alvos do plano para a tabela. `filename`/`hash` vêm do kill
 * real; ausência vira '—' em vez de sumir a linha. O sobrevivente é citado pelo
 * hash curto (ou pelo id, quando o grupo não trouxe hash). */
export function dedupTableRows(candidates: any[] | null | undefined): DedupRowView[] {
  return (Array.isArray(candidates) ? candidates : []).map((c: any) => {
    const keepHash = shortHash(c?.keep?.hash);
    return {
      hashShort: shortHash(c?.hash),
      filename: String(c?.filename || '') || '—',
      sizeBytes: Number(c?.size || 0),
      group: String(c?.group || 'duplicata'),
      keepShort: keepHash !== '—' ? keepHash : (c?.keep?.serviceId != null ? '#' + String(c.keep.serviceId) : '—'),
    };
  });
}

export interface DedupGroupView {
  kind: 'T1' | 'T2';
  /** Por que são o mesmo conteúdo, em linguagem de operador. */
  criterion: string;
  keep: { name: string; ref: string; size: number };
  kills: Array<{ name: string; size: number }>;
  bytesFreed: number;
}

const CRITERION = {
  T1: 'mesmo torrent (mesmo hash) em mais de uma entrada da conta',
  T2: 'mesmo nome de arquivo e tamanho (diferença de até 0,5%)',
} as const;

/** Grupos da prévia prontos para a tela: o que FICA, o que SAI, por que e
 * quanto espaço libera. Ordem: mais espaço liberado primeiro. */
export function dedupGroupViews(plan: DedupPlanView | null | undefined): DedupGroupView[] {
  if (!plan) return [];
  const view = (kind: 'T1' | 'T2') => (g: any): DedupGroupView => {
    const kills = (Array.isArray(g?.kill) ? g.kill : []).map((k: any) => ({
      name: String(k?.filename || '') || '—',
      size: Number(k?.size) || 0,
    }));
    return {
      kind,
      criterion: CRITERION[kind],
      keep: {
        name: String(g?.keep?.filename || '') || '—',
        ref: shortHash(g?.keep?.hash) !== '—' ? shortHash(g?.keep?.hash) : '#' + String(g?.keep?.serviceId ?? '?'),
        size: Number(g?.keep?.size) || 0,
      },
      kills,
      bytesFreed: kills.reduce((acc: number, k: { size: number }) => acc + k.size, 0),
    };
  };
  return [
    ...(Array.isArray(plan.t1) ? plan.t1 : []).map(view('T1')),
    ...(Array.isArray(plan.t2) ? plan.t2 : []).map(view('T2')),
  ].sort((a, b) => b.bytesFreed - a.bytesFreed);
}
