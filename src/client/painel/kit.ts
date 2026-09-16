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
