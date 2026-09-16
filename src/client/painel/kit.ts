import { html } from './vendor/preact.js';

export interface CardProps {
  title: string;
  badge?: { text: string; variant?: 'ok' | 'warn' | 'err' | 'neutral' };
  children?: any;
}

export function Card({ title, badge, children }: CardProps) {
  const badgeClass = badge ? 'painel-badge painel-badge-' + (badge.variant || 'neutral') : '';
  return html`
    <section class="painel-card">
      <header class="painel-card-header">
        <h3 class="painel-card-title">${title}</h3>
        ${badge ? html`<span class=${badgeClass}>${badge.text}</span>` : null}
      </header>
      ${children}
    </section>
  `;
}

export interface StatNumberProps {
  value: string | number;
  target?: string | number;
  label?: string;
}

export function StatNumber({ value, target, label }: StatNumberProps) {
  return html`
    <div class="painel-stat-group">
      <span class="painel-stat-num">${value}</span>
      ${target != null ? html`<span class="painel-stat-target">/ ${target}</span>` : null}
      ${label ? html`<span class="painel-stat-target">(${label})</span>` : null}
    </div>
  `;
}

export interface ProgressBarProps {
  percent: number;
  variant?: 'ok' | 'warn' | 'danger';
}

export function ProgressBar({ percent, variant = 'ok' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const fillStyle = 'width: ' + clamped + '%; background: var(--bar-fill-' + variant + ');';
  return html`
    <div class="painel-progress-track">
      <div class="painel-progress-fill" style=${fillStyle}></div>
    </div>
  `;
}

// --- Primitivas interativas reutilizadas pelas views -----------------------
// Componentes só de apresentação: sem fetch, sem estado de domínio. Cada view
// compõe com eles em vez de repetir tabela, paginação e grupos de ação.

export type BadgeVariant = 'ok' | 'warn' | 'err' | 'neutral';

export interface BadgeProps {
  text: string;
  variant?: BadgeVariant;
}

export function Badge({ text, variant = 'neutral' }: BadgeProps) {
  return html`<span class=${'painel-badge painel-badge-' + variant}>${text}</span>`;
}

/** Skeleton de carregamento: `block` para área, linha por padrão. */
export function Skeleton({ block = false }: { block?: boolean }) {
  return html`<div class=${'painel-skeleton ' + (block ? 'painel-skeleton-block' : 'painel-skeleton-line')}></div>`;
}

export interface PagerProps {
  page: number;
  pages: number;
  total: number;
  unit?: string;
  onPrev: () => void;
  onNext: () => void;
}

export function Pager({ page, pages, total, unit = 'linha', onPrev, onNext }: PagerProps) {
  return html`
    <div class="painel-pager">
      <span class="painel-pager-status">Página ${page} de ${pages} · ${total} ${unit}(s)</span>
      <button class="painel-btn" disabled=${page <= 1} onClick=${onPrev}>Anterior</button>
      <button class="painel-btn" disabled=${page >= pages} onClick=${onNext}>Próxima</button>
    </div>
  `;
}

export interface Column<T> {
  header: string;
  render: (row: T) => any;
}

/** Tabela `painel-table` genérica: a view declara colunas + chave estável. */
export function DataTable<T>({ columns, rows, rowKey }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string }) {
  return html`
    <table class="painel-table">
      <thead>
        <tr>${columns.map((column, i) => html`<th key=${i}>${column.header}</th>`)}</tr>
      </thead>
      <tbody>
        ${rows.map((row) => html`
          <tr key=${rowKey(row)}>${columns.map((column, i) => html`<td key=${i}>${column.render(row)}</td>`)}</tr>
        `)}
      </tbody>
    </table>
  `;
}

export interface FeedbackEntry {
  text: string;
  ok: boolean;
}

/** Banner inline acessível; `null` não renderiza nada. */
export function Feedback({ entry }: { entry: FeedbackEntry | null }) {
  if (!entry) return null;
  return html`
    <div class=${'painel-feedback ' + (entry.ok ? 'painel-feedback-ok' : 'painel-feedback-err')} role="status" aria-live="polite">
      ${entry.text}
    </div>
  `;
}

export interface ActionGroupProps {
  title: string;
  badge?: string;
  note?: string;
  danger?: boolean;
  children?: any;
}

/** Grupo de ações com risco explícito (leitura × destrutivo). */
export function ActionGroup({ title, badge, note, danger, children }: ActionGroupProps) {
  return html`
    <div class=${'painel-action-group' + (danger ? ' painel-action-group-danger' : '')}>
      <h4 class="painel-action-group-title">
        ${title}
        ${badge ? html`<${Badge} text=${badge} variant=${danger ? 'err' : 'neutral'} />` : null}
      </h4>
      ${note ? html`<p class="painel-action-note">${note}</p>` : null}
      ${children}
    </div>
  `;
}
