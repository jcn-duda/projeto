// Modelo puro da navegação do catálogo (Etapa 4) e da limpeza BR (Etapa 5).
// Sem DOM, sem preact: dado → dado, testável direto. Os contratos são os REAIS
// de `catalog-list` ({ok, rows}) e `cleanup-preview`/`cleanup-apply`
// ({ok, targets, skipped}); os rótulos de balde vêm do modelo da aba, sem
// lista paralela que possa divergir.
import { CATALOG_BUCKETS, bucketLabel } from '../limpeza-model.js';

// Navegação do catálogo (Etapa 4)

/** Tamanho da página do CLIENTE. O backend recebe `max` (teto da listagem) e a
 * tela pagina de novo o que voltou — a paginação do servidor não é a da UI. */
export const CATALOG_PAGE_SIZE = 20;

export interface CatalogListRow {
  serviceId: string;
  hashShort: string;
  filename: string;
  sizeBytes: number;
  bucket: string;
  bucketName: string;
  active: boolean;
  protected: boolean;
  foreignProof: string;
  ptProof: string;
  cached: string;
}

function shortHash(value: unknown): string {
  const text = String(value || '');
  return text ? text.slice(0, 8) : '—';
}

/** Contrato real de `catalog-list`: `{ ok:true, rows:[ReviewRow] }` ou
 * `{ ok:false, reason, hint? }`. `serviceId` identifica a linha enviada ao
 * `manual-delete`; `filename` é só rótulo. */
export function catalogListRows(data: Record<string, any> | null | undefined): CatalogListRow[] {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  return rows.map((r: any) => {
    const bucket = String(r?.bucket || '');
    return {
      serviceId: String(r?.serviceId ?? ''),
      hashShort: shortHash(r?.hash),
      filename: String(r?.filename || '') || '—',
      sizeBytes: Number(r?.size || 0),
      bucket,
      bucketName: bucketLabel(bucket),
      active: Boolean(r?.active),
      protected: Boolean(r?.protected),
      foreignProof: String(r?.foreignProof || ''),
      ptProof: String(r?.ptProof || ''),
      cached: String(r?.cached || ''),
    };
  });
}

/** Veredito do magnet: 'estrangeiro' só com PROVA, 'PT' com prova positiva e
 * "sem prova" é ignorância — a mesma assimetria do `foreignVerdict` do servidor. */
export function catalogVerdict(row: CatalogListRow): { text: string; variant: 'ok' | 'err' | 'neutral' } {
  if (row.foreignProof) return { text: 'estrangeiro', variant: 'err' };
  if (row.ptProof) return { text: 'PT', variant: 'ok' };
  return { text: row.bucketName || 'sem prova', variant: 'neutral' };
}

/** "Todos" + os baldes conhecidos, com os rótulos do `bucketLabel`. */
export function catalogBucketOptions(): Array<{ value: string; label: string }> {
  return [{ value: '', label: 'Todos os baldes' }, ...CATALOG_BUCKETS.map((key) => ({ value: key, label: bucketLabel(key) }))];
}

/**
 * Próximo estado de `catalogListState`. Mesma regra do `nextCatalogState`: falha
 * de TRANSPORTE nunca deixa a tabela em "carregando" — sem lista boa grava o
 * erro com `retry`, e com lista boa preserva o que estava na tela (o refresh
 * que falhou não apaga linhas que o operador estava vendo).
 */
export function nextCatalogListState(
  prev: Record<string, any> | null,
  result: { ok: boolean; data?: Record<string, any>; error?: string },
): Record<string, any> {
  if (result.ok) {
    return result.data ?? { ok: false, reason: 'resposta vazia do servidor' };
  }
  const hasGoodList = Boolean(prev && prev.ok !== false && Array.isArray(prev.rows));
  if (hasGoodList) return prev as Record<string, any>;
  return { ok: false, reason: result.error || 'falha ao listar o catálogo', retry: true };
}

/** Ids elegíveis à deleção: download em curso fica de fora (o servidor o
 * pularia de qualquer forma). */
export function selectableIds(rows: CatalogListRow[]): string[] {
  return rows.filter((row) => !row.active).map((row) => row.serviceId);
}

/** Marca tudo que dá para apagar; se já está tudo marcado, limpa. */
export function toggleAllSelection(rows: CatalogListRow[], selected: string[]): string[] {
  const eligible = selectableIds(rows);
  const marked = new Set(selected);
  const allSelected = eligible.length > 0 && eligible.every((id) => marked.has(id));
  return allSelected ? [] : eligible;
}

export interface CatalogSelection {
  count: number;
  bytes: number;
  eligible: number;
}

/** Resumo da seleção. O tamanho viaja junto porque a ação seguinte é
 * irreversível: "12 selecionados" não diz se são 2 GB ou 2 TB. */
export function catalogSelection(rows: CatalogListRow[], selected: string[]): CatalogSelection {
  const marked = new Set(selected);
  let count = 0;
  let bytes = 0;
  for (const row of rows) {
    if (!row.active && marked.has(row.serviceId)) {
      count += 1;
      bytes += row.sizeBytes;
    }
  }
  return { count, bytes, eligible: selectableIds(rows).length };
}

export function catalogPageCount(total: number, pageSize = CATALOG_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

export function catalogPageSlice<T>(rows: T[], page: number, pageSize = CATALOG_PAGE_SIZE): T[] {
  const pages = catalogPageCount(rows.length, pageSize);
  const clamped = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (clamped - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

// Limpeza BR (Etapa 5)

export interface CleanupSkipped {
  protected: number;
  active: number;
  young: number;
  notCondemned: number;
  known: number;
}

export interface CleanupPreviewSummary {
  ok: boolean;
  reason: string | null;
  targets: any[];
  skipped: CleanupSkipped;
}

const ZERO_SKIPPED: CleanupSkipped = { protected: 0, active: 0, young: 0, notCondemned: 0, known: 0 };

/** Contrato real de `cleanup-preview`/`cleanup-apply`:
 * `{ ok:true, targets:[CleanupTarget], skipped:{protected,active,young,notCondemned,known} }`
 * ou `{ ok:false, reason, hint? }`. Todo o plano vem do servidor; aqui só se
 * normaliza e conta. */
export function cleanupPreviewSummary(data: Record<string, any> | null | undefined): CleanupPreviewSummary {
  if (!data || data.ok === false) {
    const reason = String(data?.reason || data?.error || 'erro') + (data?.hint ? ` — ${data.hint}` : '');
    return { ok: false, reason, targets: [], skipped: { ...ZERO_SKIPPED } };
  }
  const skipped = data.skipped || {};
  return {
    ok: true,
    reason: null,
    targets: Array.isArray(data.targets) ? data.targets : [],
    skipped: {
      protected: Number(skipped.protected || 0),
      active: Number(skipped.active || 0),
      young: Number(skipped.young || 0),
      notCondemned: Number(skipped.notCondemned || 0),
      known: Number(skipped.known || 0),
    },
  };
}

/** Só permite aplicar quando a prévia rodou E achou alvos — o mesmo contrato
 * do `canApplyDedup`: aplicar plano vazio é chamada destrutiva sem efeito. */
export function canApplyCleanup(preview: { targets?: any[] } | null | undefined): boolean {
  return Boolean(preview && Array.isArray(preview.targets) && preview.targets.length > 0);
}

export interface CleanupRowView {
  hashShort: string;
  filename: string;
  sizeBytes: number;
  known: boolean;
  reason: string;
}

/** Normaliza os alvos da limpeza BR para a tabela. `known` marca o acervo que
 * já era do operador (só entra em `targets` com `includeKnown`). */
export function cleanupTableRows(targets: any[] | null | undefined): CleanupRowView[] {
  return (Array.isArray(targets) ? targets : []).map((t: any) => ({
    hashShort: shortHash(t?.hash),
    filename: String(t?.filename || '') || '—',
    sizeBytes: Number(t?.size || 0),
    known: Boolean(t?.known),
    reason: String(t?.reason || 'estrangeiro provado'),
  }));
}

/** Linha dos pulados: mostra o que a limpeza NÃO tocou, para o operador não
 * confundir "plano pequeno" com "filtro quebrado". */
export function cleanupSkippedLine(skipped: CleanupSkipped | null | undefined): string {
  const s = skipped || ZERO_SKIPPED;
  return `pulados — protegidos: ${s.protected} · ativos: ${s.active} · jovens: ${s.young} · não condenados: ${s.notCondemned} · preexistentes: ${s.known}`;
}
