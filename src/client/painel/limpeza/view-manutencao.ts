import { html, useState } from '../vendor/preact.js';
import { Card, Feedback, ActionGroup, DataTable, type Column } from '../kit.js';
import { useAction, actionError } from '../action.js';
import { formatBytes } from '../fmt.js';
import { NumberField, ToggleField } from '../form.js';
import {
  canApplyCleanup,
  cleanupPreviewSummary,
  cleanupSkippedLine,
  cleanupTableRows,
  type CleanupPreviewSummary,
  type CleanupRowView,
} from './catalogo-model.js';
import { fire } from './view-catalogo.js';

export interface CleanupMaintenanceProps {
  onChanged?: () => void;
}

const MUTED_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);';

const CLEANUP_COLUMNS: Column<CleanupRowView>[] = [
  { header: 'Release', render: (row) => html`<span class="painel-cell-release" title=${row.filename}>${row.filename}</span>` },
  { header: 'Tamanho', render: (row) => formatBytes(row.sizeBytes) },
  { header: 'Hash', render: (row) => html`<code>${row.hashShort}</code>` },
  { header: 'Origem', render: (row) => (row.known ? 'preexistente' : 'addon') },
];

/**
 * Limpeza BR (estrangeiro provado), auditoria de arquivos e warmer RD. O
 * `apply` espelha o `canApplyDedup`: só habilita com prévia NÃO vazia, e o
 * `includeKnown`/`max` viajam no MESMO corpo da prévia e da aplicação —
 * trocar o toggle invalida a prévia, senão o botão aplicaria um plano que não
 * corresponde ao filtro mostrado.
 */
export function CleanupMaintenance({ onChanged }: CleanupMaintenanceProps) {
  const [includeKnown, setIncludeKnown] = useState(false);
  const [max, setMax] = useState(50);
  const [cleanup, setCleanup] = useState<CleanupPreviewSummary | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const { pending, run } = useAction();

  const previewCleanup = async () => {
    setFeedback(null);
    const outcome = await run({ action: 'cleanup-preview', body: { includeKnown } });
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
      return;
    }
    const summary = cleanupPreviewSummary(outcome.data);
    if (!summary.ok) {
      setCleanup(null);
      setFeedback({ text: `Falha: ${summary.reason}`, ok: false });
      return;
    }
    setCleanup(summary);
    setFeedback({ text: `Limpeza BR: ${summary.targets.length} alvo(s) — ${cleanupSkippedLine(summary.skipped)}`, ok: true });
  };

  const applyCleanup = async () => {
    const outcome = await run({
      action: 'cleanup-apply',
      body: { includeKnown, max },
      confirm: {
        title: 'Aplicar limpeza BR',
        message: `Apagar ${cleanup?.targets.length || 0} magnet(s) estrangeiro(s) provado(s) da conta?`,
        confirmLabel: 'Aplicar limpeza',
        danger: true,
      },
      poll: ['conta', 'debrid', 'magnetdb'],
      successToast: (data) => `Limpeza BR: ${Number(data.deleted || 0)} removido(s)${Number(data.falhas || 0) ? ` · ${data.falhas} falha(s)` : ''}`,
    });
    if (outcome.ok) {
      setCleanup(null);
      setFeedback(null);
      onChanged?.();
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  // Auditoria e warmer compartilham a mesma forma: `max` no corpo, contadores
  // próprios na resposta e sem confirmação (nenhuma das ações apaga magnet).
  const task = (action: string, toast: (data: Record<string, any>) => string) => async () => {
    const outcome = await run({ action, body: { max }, successToast: toast, failureFallback: 'ação indisponível' });
    if (outcome.ok) {
      setFeedback(null);
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  const previewRows = cleanupTableRows(cleanup?.targets);

  return html`
    <${Card} title="Limpeza BR, auditoria e warmer (operador)">
      <${Feedback} entry=${feedback} />
      <div class="painel-form-row">
        <${NumberField} label="Máximo por rodada" value=${max} min=${1} max=${500}
          onChange=${(next: number) => { setMax(next); setCleanup(null); }}
          hint="Teto (max) das ações que aceitam" />
        <${ToggleField} label="Incluir acervo preexistente (includeKnown)" checked=${includeKnown}
          onChange=${(checked: boolean) => { setIncludeKnown(checked); setCleanup(null); }}
          hint="Remove a guarda do snapshot; a idade mínima continua valendo" />
      </div>

      <${ActionGroup} title="Limpeza BR (estrangeiro provado)"
        note="Remove só o que tem prova de estrangeiro no catálogo durável.">
        <div class="painel-btn-row">
          <button class="painel-btn" disabled=${pending} onClick=${fire(previewCleanup)}>Prévia de Limpeza BR</button>
          <button class="painel-btn painel-btn-danger" disabled=${pending || !canApplyCleanup(cleanup)}
            onClick=${fire(applyCleanup)}>
            ${cleanup ? `Aplicar Limpeza BR (${cleanup.targets.length})` : 'Aplicar Limpeza BR'}
          </button>
        </div>
      </${ActionGroup}>

      ${cleanup == null
        ? html`<div class="painel-empty painel-empty-sm">Rode a prévia para dimensionar a limpeza BR.</div>`
        : cleanup.targets.length === 0
          ? html`<div class="painel-empty painel-empty-sm">Nenhum alvo condenado. ${cleanupSkippedLine(cleanup.skipped)}</div>`
          : html`
            <${DataTable} columns=${CLEANUP_COLUMNS} rows=${previewRows.slice(0, 10)}
              rowKey=${(row: CleanupRowView) => row.hashShort + row.filename} />
            <p style=${MUTED_LINE}>${cleanup.targets.length} alvo(s) · ${cleanupSkippedLine(cleanup.skipped)}</p>
          `}

      <${ActionGroup} title="Auditoria de arquivos"
        note="Reenfileira evidência expirada e audita pelos arquivos reais do magnet.">
        <div class="painel-btn-row">
          <button class="painel-btn" disabled=${pending}
            onClick=${fire(task('audit-requeue', (data) => `Auditoria reenfileirada: ${Number(data.requeued || 0)} linha(s)`))}>
            Reenfileirar (requeue)
          </button>
          <button class="painel-btn painel-btn-accent" disabled=${pending}
            onClick=${fire(task('audit-backfill', (data) => `Auditoria: ${Number(data.scanned || 0)} registro(s), ${Number(data.evidenced || 0)} com prova`))}>
            Auditar arquivos (backfill)
          </button>
        </div>
      </${ActionGroup}>

      <${ActionGroup} title="Warmer RD" note="Fila de aquecimento do Real-Debrid.">
        <div class="painel-btn-row">
          <button class="painel-btn" disabled=${pending} onClick=${fire(task('warm-pause', () => 'Warmer RD pausado'))}>
            Pausar
          </button>
          <button class="painel-btn" disabled=${pending} onClick=${fire(task('warm-resume', () => 'Warmer RD retomado'))}>
            Retomar
          </button>
          <button class="painel-btn painel-btn-accent" disabled=${pending}
            onClick=${fire(task('warm-drain', (data) => `Warmer RD: ${Number(data.processed || 0)} item(ns) processado(s)`))}>
            Drenar
          </button>
        </div>
      </${ActionGroup}>
    </${Card}>
  `;
}
