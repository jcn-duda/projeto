import { html } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';

export interface ViewGateProps {
  gate?: Record<string, any>;
}

export function ViewGate({ gate }: ViewGateProps) {
  const g = gate || {};
  const isOverridden = g.isAutoFetchPauseAtOverridden;
  const effectivePauseAt = g.autoFetchPauseAt ?? '—';
  const envPauseAt = g.envAutoFetchPauseAt ?? '—';
  const diffs: Array<{ key: string; effective: any; envDefault: any }> = g.diffs || [];

  return html`
    <div class="painel-grid">
      <${Card}
        title="Gate de Ocupação (autoFetchPauseAt)"
        badge=${isOverridden ? { text: 'MODIFICADO AO VIVO', variant: 'warn' } : { text: 'PADRÃO .ENV', variant: 'ok' }}
      >
        <div class="painel-stat-group">
          <span class="painel-stat-num">${effectivePauseAt}</span>
          <span class="painel-stat-target">.env: ${envPauseAt}</span>
        </div>
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          ${isOverridden
            ? 'O gate efetivo em memória diverge do padrão configurado no .env.'
            : 'O gate está operando com o valor padrão do .env sem overrides em memória.'}
        </p>
      </${Card}>

      <${Card} title="Status do Gate Autofetch">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Estado Operacional</span>
            <span class=${'painel-badge ' + (g.paused ? 'painel-badge-err' : 'painel-badge-ok')}>
              ${g.paused ? 'PAUSADO' : 'ATIVO'}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Chaves Modificadas em Memória</span>
            <strong style="font-family: var(--font-mono);">${diffs.length}</strong>
          </div>
        </div>
      </${Card}>
    </div>

    ${diffs.length > 0 ? html`
      <${Card} title="Divergências ao Vivo vs .env (${diffs.length})">
        <div class="painel-diff-list">
          ${diffs.map(
            (d) => html`
              <div class="painel-diff-item">
                <span style="font-family: var(--font-mono); font-weight: 600;">${d.key}</span>
                <div style="display: flex; gap: var(--space-3); align-items: center;">
                  <span style="color: var(--muted); font-size: var(--font-floor);">.env: ${String(d.envDefault)}</span>
                  <span class="painel-badge painel-badge-warn">ao vivo: ${String(d.effective)}</span>
                </div>
              </div>
            `,
          )}
        </div>
      </${Card}>
    ` : null}
  `;
}
