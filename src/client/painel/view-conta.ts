import { html } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar } from './kit.js';
import { formatAgeFromTimestamp } from './fmt.js';

export interface ViewContaProps {
  conta?: Record<string, any>;
  debrid?: Record<string, any>;
}

export function ViewConta({ conta, debrid }: ViewContaProps) {
  const c = conta || {};
  const total = c.total ?? debrid?.account?.magnets ?? 0;
  const cap = c.cap ?? 1000;
  const percent = c.usagePercent ?? (cap > 0 ? Math.round((total / cap) * 100) : 0);
  const progressVariant = percent >= 90 ? 'danger' : percent >= 80 ? 'warn' : 'ok';
  const badgeVariant = percent >= 90 ? 'err' : percent >= 80 ? 'warn' : 'ok';

  const ready = c.ready ?? debrid?.account?.ready ?? 0;
  const downloading = c.downloading ?? debrid?.account?.active ?? 0;
  const dead = c.dead ?? debrid?.account?.error ?? 0;

  const oldestAge = c.oldestAt ? formatAgeFromTimestamp(c.oldestAt) : '—';
  const hasStuck = c.stuckCount > 0;

  return html`
    <div class="painel-grid">
      <${Card}
        title="Ocupação da Conta"
        badge=${{ text: `${percent}% DA CONTA`, variant: badgeVariant }}
      >
        <${StatNumber} value=${total} target=${cap} label="${percent}%" />
        <${ProgressBar} percent=${percent} variant=${progressVariant} />
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          Limite de aviso do operador: ${c.warnAt ?? 800} magnets
        </p>
      </${Card}>

      <${Card} title="Composição de Magnets">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--green);">Prontos (disponíveis)</span>
            <strong style="font-family: var(--font-mono);">${ready}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--amber);">Baixando / Ativos</span>
            <strong style="font-family: var(--font-mono);">${downloading}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--red);">Terminais / Mortos</span>
            <strong style="font-family: var(--font-mono);">${dead}</strong>
          </div>
        </div>
      </${Card}>

      <${Card}
        title="Saúde da Fila e Downloads"
        badge=${hasStuck ? { text: 'DOWNLOAD PRESO', variant: 'warn' } : undefined}
      >
        <div class="painel-stat-group">
          <span class="painel-stat-target">Mais antigo há:</span>
          <strong style="font-family: var(--font-mono); color: var(--text);">${oldestAge}</strong>
        </div>
        ${hasStuck ? html`
          <p style="color: var(--amber); margin: 0; font-size: var(--font-floor);">
            Há pelo menos 1 download ativo há mais de 24 horas na conta.
          </p>
        ` : html`
          <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
            Nenhum download preso detectado.
          </p>
        `}
      </${Card}>
    </div>
  `;
}
