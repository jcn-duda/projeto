import { html, useState, useEffect } from './vendor/preact.js';
import { Card, StatNumber, DataTable, Pager, type Column } from './kit.js';
import { postAction } from './api.js';
import { getPainelState, subscribePainelToken } from './store.js';
import { useAction, actionError } from './action.js';
import { formatBytes } from './fmt.js';
import {
  canApplyDedup,
  catalogSummary,
  catalogBucketRows,
  dedupPreviewSummary,
  dedupGroupViews,
  limpezaHeader,
  nextCatalogState,
  type DedupPlanView,
  type DedupRowView,
} from './limpeza-model.js';
import { CatalogNav } from './limpeza/view-catalogo.js';
import { CleanupMaintenance } from './limpeza/view-manutencao.js';
import { WorkVersionsCard } from './limpeza/view-versoes.js';

// Reexport: os testes e qualquer consumidor antigo importam os helpers daqui.
export {
  canApplyDedup,
  catalogSummary,
  catalogBucketRows,
  dedupPreviewSummary,
  limpezaHeader,
  nextCatalogState,
  CATALOG_BUCKETS,
  bucketLabel,
} from './limpeza-model.js';
export type { CatalogSummary, CatalogBucketRow, DedupPlanView, DedupPreviewSummary, DedupRowView, LimpezaHeader } from './limpeza-model.js';
// Helpers das Etapas 4/5 (navegação do catálogo e limpeza BR) vivem em
// `./limpeza/`; reexportados aqui para o mesmo ponto de import da aba.
export {
  canApplyCleanup,
  catalogBucketOptions,
  catalogListRows,
  catalogPageCount,
  catalogPageSlice,
  catalogSelection,
  catalogVerdict,
  cleanupPreviewSummary,
  cleanupSkippedLine,
  cleanupTableRows,
  nextCatalogListState,
  selectableIds,
  toggleAllSelection,
  applyCatalogFilter,
  verdictFilterOptions,
  emptyCatalogFilter,
  CATALOG_PAGE_SIZE,
} from './limpeza/catalogo-model.js';
export type {
  CatalogListRow, CatalogSelection, CleanupPreviewSummary, CleanupRowView, CleanupSkipped,
  CatalogFilter, VerdictFilter, SortMode,
} from './limpeza/catalogo-model.js';
export { CatalogNav } from './limpeza/view-catalogo.js';
export { CleanupMaintenance } from './limpeza/view-manutencao.js';
export { WorkVersionsCard } from './limpeza/view-versoes.js';

export interface ViewLimpezaProps {
  catalog?: Record<string, any>;
  conta?: Record<string, any>;
  debrid?: Record<string, any>;
}

const MUTED_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);';

/** Renderiza a prévia de dedup agrupada, paginada e ordenada por espaço
 * liberado. Cada grupo diz POR QUE são o mesmo conteúdo, o que FICA e o que SAI,
 * com tamanho — o operador decide olhando o plano, não o hash. */
function renderDedupGroups(
  plan: DedupPlanView,
  page: number,
  pageSize: number,
  setPage: (n: number) => void,
) {
  const allGroups = dedupGroupViews(plan);
  const total = allGroups.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(page, pages);
  const slice = allGroups.slice((clamped - 1) * pageSize, clamped * pageSize);
  return html`
    ${slice.map((g) => html`
      <div style="margin-bottom: var(--space-2); padding: var(--space-2); border: 1px solid var(--border); border-radius: var(--radius-xs);">
        <div style="font-size: var(--font-floor); font-weight: 700; margin-bottom: var(--space-1);">
          <span class="painel-badge painel-badge-neutral">${g.kind}</span>
          libera ${formatBytes(g.bytesFreed)}
          <span style="font-weight: 400; color: var(--muted); margin-left: var(--space-2);">${g.criterion}</span>
        </div>
        <div style="font-size: var(--font-floor); padding-left: var(--space-3);">
          ✓ FICA <code>${g.keep.ref}</code>
          <span class="painel-cell-release" title=${g.keep.name}>${g.keep.name}</span>
          ${g.keep.size ? `(${formatBytes(g.keep.size)})` : ''}
        </div>
        ${g.kills.map((k) => html`
          <div style="font-size: var(--font-floor); color: var(--muted); padding-left: var(--space-3);">
            ✕ SAI <span class="painel-cell-release" title=${k.name}>${k.name}</span> (${formatBytes(k.size)})
          </div>
        `)}
      </div>
    `)}
    <${Pager} page=${clamped} pages=${pages} total=${total} unit="grupo"
      onPrev=${() => setPage(clamped - 1)} onNext=${() => setPage(clamped + 1)} />
  `;
}

export function ViewLimpeza({ catalog, conta, debrid }: ViewLimpezaProps) {
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const { pending, run } = useAction();
  const [catalogData, setCatalogData] = useState<Record<string, any> | null>(catalog || null);
  const [previewResult, setPreviewResult] = useState<DedupPlanView | null>(null);
  const [dedupPage, setDedupPage] = useState(1);
  const [bucketTarget, setBucketTarget] = useState('');
  const [bucketClicks, setBucketClicks] = useState(0);
  const DEDUP_PAGE_SIZE = 10;

  // O catálogo tem carregamento PRÓPRIO (com reentrada própria): trocar de token
  // precisa disparar uma recarga mesmo com uma anterior em voo, e a trava do
  // `useAction` descartaria a nova. As destrutivas é que centralizam no `run`.
  const loading = pending || catalogLoading;

  const refreshCatalog = async (silent: boolean) => {
    const token = getPainelState().token;
    if (!token) return;
    if (!silent) setCatalogLoading(true);
    try {
      const res = await postAction(token, 'catalog-report');
      setCatalogData((prev) => nextCatalogState(prev, res));
      if (!res.ok && !silent) {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
      }
    } finally {
      if (!silent) setCatalogLoading(false);
    }
  };

  // Prévia de dedup em SILÊNCIO: é leitura pura (nenhuma deleção), então a aba
  // já abre sabendo quantas duplicatas e quantos GB há — antes, o resumo dizia
  // "prévia pendente" até o operador lembrar de clicar.
  const refreshPreview = async () => {
    const token = getPainelState().token;
    if (!token) return;
    const res = await postAction(token, 'dedup-preview');
    if (!res.ok) return;
    const preview = dedupPreviewSummary(res.data);
    if (preview.ok) setPreviewResult(preview);
  };

  // A aba monta e carrega o relatório sob demanda. `catalog` saiu do poll vital
  // rápido: `catalogStatusEnv()` varre as linhas do catálogo (O(rows)) e não
  // precisa rodar a cada refresh; a ação `catalog-report` já existe.
  //
  // O prefixo (`basePrefix()`) é fixo por carregamento de página — só o token
  // muda em runtime, e o canal `subscribePainelToken` recarrega com a
  // credencial nova. Se o prefixo mudar, é navegação nova (remonta a página).
  useEffect(() => {
    refreshCatalog(true);
    void refreshPreview();
    return subscribePainelToken(() => {
      // Trocar de conta INVALIDA a prévia: o plano era da conta anterior, e o
      // botão destrutivo não pode aplicar kills calculados sobre outra credencial.
      setPreviewResult(null);
      refreshCatalog(true);
      void refreshPreview();
    });
  }, []);

  const summary = catalogSummary(catalogData);
  const head = limpezaHeader(previewResult, conta, debrid);
  const catalogBadge = catalogData == null
    ? { text: 'CARREGANDO', variant: 'neutral' as const }
    : summary.ok
      ? { text: 'OK', variant: 'ok' as const }
      : { text: 'INDISPONÍVEL', variant: 'warn' as const };

  const handleSweepDead = async () => {
    const outcome = await run({
      action: 'sweep-dead',
      confirm: {
        message: 'Executar varredura e remoção de torrents mortos no debrid ativo?',
        danger: true,
        confirmLabel: 'Varrer e limpar',
      },
      poll: ['conta', 'debrid', 'magnetdb'],
      successToast: (data) => {
        const result = data.result || {};
        const varridos = Number(result.varridos || 0);
        const falhas = Number(result.falhas || 0);
        return `Varredura concluída: ${varridos} removido(s)${falhas ? ` · ${falhas} falha(s)` : ''}`;
      },
    });
    if (outcome.ok) {
      setFeedback(null);
      await refreshCatalog(true);
      return;
    }
    // O erro fica no card (feedback inline); o sucesso sai como toast global.
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  const handleDedupPreview = async () => {
    setFeedback(null);
    const outcome = await run({ action: 'dedup-preview' });
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
      return;
    }
    const preview = dedupPreviewSummary(outcome.data);
    if (!preview.ok) {
      setFeedback({ text: `Falha: ${preview.reason}`, ok: false });
      return;
    }
    setPreviewResult(preview);
    setDedupPage(1);
    setFeedback({
      text: `Plano calculado: ${preview.candidates.length} alvo(s) em ${preview.t1Groups} grupo(s) T1 e ${preview.t2Groups} grupo(s) T2 · libera ${formatBytes(preview.bytesFreed)}`,
      ok: true,
    });
  };

  const handleDedupApply = async () => {
    const outcome = await run({
      action: 'dedup-apply',
      confirm: {
        message: 'Aplicar a deduplicação e remover releases duplicadas da conta?',
        danger: true,
        confirmLabel: 'Aplicar deduplicação',
      },
      poll: ['conta', 'debrid', 'magnetdb'],
      successToast: (data) => {
        const removed = Number(data.deleted || 0);
        const falhas = Number(data.falhas || 0);
        return `Deduplicação aplicada: ${removed} duplicata(s) removida(s)${falhas ? ` · ${falhas} falha(s)` : ''}`;
      },
    });
    if (outcome.ok) {
      setFeedback(null);
      setPreviewResult(null);
      await refreshCatalog(true);
      await refreshPreview();
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  // Depois de uma mutação nas sub-abas, o relatório da conta volta a ser lido.
  const refresh = () => {
    void refreshCatalog(true);
  };

  return html`
    <div>
      ${feedback ? html`
        <div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}" role="status" aria-live="polite">
          ${feedback.text}
        </div>
      ` : null}

      <section class="painel-summary-bar" aria-label="Resumo da limpeza">
        <div class="painel-summary-item">
          <span class="painel-summary-label">Catálogo</span>
          <span class="painel-summary-value">
            ${summary.ok ? `${summary.magnets} magnets · ${summary.ready} prontos` : 'indisponível'}
          </span>
        </div>
        <div class="painel-summary-item">
          <span class="painel-summary-label">Obra identificada</span>
          <span class="painel-summary-value">${summary.knownWorks} / ${summary.magnets}</span>
        </div>
        <div class="painel-summary-item">
          <span class="painel-summary-label">Acervo</span>
          <span class="painel-summary-value">${formatBytes(summary.totalBytes)}</span>
        </div>
        <div class="painel-summary-item">
          <span class="painel-summary-label">Duplicatas planejadas</span>
          <span class="painel-summary-value">
            ${!summary.ok ? '—' : head.previewState === 'idle' ? 'calculando…' : head.duplicates === 0 ? 'nenhuma' : `${head.duplicates} alvo(s) · ${formatBytes(head.bytesFreed)}`}
          </span>
        </div>
        <div class="painel-summary-item">
          <span class="painel-summary-label">Conta</span>
          <span class="painel-summary-value">
            ${head.accountService ? `${head.accountService} · ${head.accountTotal}${head.accountCap ? '/' + head.accountCap : ''}` : '—'}
          </span>
        </div>
        ${loading ? html`<span class="painel-badge painel-badge-neutral" role="status" aria-live="polite">PROCESSANDO…</span>` : null}
      </section>

      <div class="painel-limpeza-grid">
        <${Card} title="Catálogo da Conta (operador)" badge=${catalogBadge}>
          ${catalogData == null ? html`
            <div class="painel-empty painel-empty-sm">Carregando catálogo…</div>
          ` : !summary.ok ? html`
            <div class="painel-empty painel-empty-sm">
              <p style="color: var(--amber); margin: 0 0 var(--space-3);">${summary.reason || 'catálogo indisponível'}</p>
              ${catalogData?.retry ? html`
                <button class="painel-btn" disabled=${loading} onClick=${() => refreshCatalog(false)}>Tentar novamente</button>
              ` : null}
            </div>
          ` : html`
            <${StatNumber} value=${summary.magnets} label="magnets na conta" />
            <p style=${MUTED_LINE}>Com obra identificada: ${summary.knownWorks} · sem obra: ${summary.unknownWorks}</p>
            <table class="painel-table">
              <thead>
                <tr><th>Áudio / origem</th><th>Magnets</th><th>Bytes</th><th></th></tr>
              </thead>
              <tbody>
                ${catalogBucketRows(summary).map((b) => html`
                  <tr style="cursor:pointer" onClick=${() => { setBucketTarget(b.key); setBucketClicks((n) => n + 1); }}>
                    <td>${b.label}</td><td>${b.count}</td><td>${formatBytes(b.bytes)}</td>
                    <td><span class="painel-badge painel-badge-neutral" style="cursor:pointer">Listar</span></td>
                  </tr>
                `)}
              </tbody>
            </table>
            <p style=${MUTED_LINE}>Total: ${summary.totalCount} magnets · ${formatBytes(summary.totalBytes)}</p>
          `}
        </${Card}>

        <${Card} title="Ações de Limpeza">
          <div class="painel-action-group">
            <h4 class="painel-action-group-title">
              Leitura e prévia
              <span class="painel-badge painel-badge-neutral">NÃO DESTRUTIVO</span>
            </h4>
            <p class="painel-action-note">Consultas que não alteram a conta. Rode a prévia para dimensionar o que seria removido.</p>
            <div class="painel-btn-row">
              <button class="painel-btn" disabled=${loading} onClick=${() => refreshCatalog(false)}>
                Atualizar Catálogo
              </button>
              <button class="painel-btn painel-btn-accent" disabled=${loading} onClick=${handleDedupPreview}>
                Prévia de Deduplicação
              </button>
            </div>
          </div>

          <div class="painel-action-group painel-action-group-danger">
            <h4 class="painel-action-group-title">
              Ações destrutivas
              <span class="painel-badge painel-badge-err">IRREVERSÍVEL</span>
            </h4>
            <p class="painel-action-note">Removem magnets da conta e exigem confirmação. Não há desfazer.</p>
            <div class="painel-btn-row">
              <button class="painel-btn painel-btn-danger" disabled=${loading} onClick=${handleSweepDead}>
                Varrer e Limpar Mortos
              </button>
              <button class="painel-btn painel-btn-danger" disabled=${loading || !canApplyDedup(previewResult)} onClick=${handleDedupApply}>
                ${previewResult && previewResult.candidates.length ? `Aplicar Deduplicação (${previewResult.candidates.length} · ${formatBytes(head.bytesFreed)})` : 'Aplicar Deduplicação'}
              </button>
            </div>
          </div>
        </${Card}>
      </div>

      ${previewResult == null
        ? html`<p style=${MUTED_LINE}>Prévia de deduplicação: use o botão acima para calcular.</p>`
        : head.duplicates === 0
          ? html`<p style=${MUTED_LINE}>Catálogo limpo — ${head.t1Groups + head.t2Groups} grupo(s) verificado(s).</p>`
          : html`
            <p style=${MUTED_LINE}>
              T1 (mesmo hash): ${head.t1Groups} · T2 (mesmo arquivo): ${head.t2Groups} · Alvos: ${head.duplicates} · Libera ${formatBytes(head.bytesFreed)}
            </p>
            ${renderDedupGroups(previewResult, dedupPage, DEDUP_PAGE_SIZE, setDedupPage)}
          `}

      <${CatalogNav} key=${`${bucketTarget}-${bucketClicks}`} onChanged=${refresh} initialBucket=${bucketTarget} />
      <${WorkVersionsCard} onChanged=${refresh} />
      <${CleanupMaintenance} onChanged=${refresh} />
    </div>
  `;
}
