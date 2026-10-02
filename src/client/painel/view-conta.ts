import { html } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar } from './kit.js';
import { formatAgeFromTimestamp } from './fmt.js';
import { contaView } from './conta-model.js';

export interface ViewContaProps {
  conta?: Record<string, any>;
  debrid?: Record<string, any>;
}

export function ViewConta({ conta, debrid }: ViewContaProps) {
  const v = contaView(conta, debrid);
  const progressVariant = v.percent >= 90 ? 'danger' : v.percent >= 80 ? 'warn' : 'ok';
  const oldestAge = v.oldestAt ? formatAgeFromTimestamp(v.oldestAt) : '—';

  return html`
    <div class="painel-grid">
      <${Card} title="Ocupação da Conta" badge=${v.badge}>
        <${StatNumber} value=${v.total} target=${v.cap} label="${v.percent}%" />
        <${ProgressBar} percent=${v.percent} variant=${progressVariant} />
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          Limite de aviso do operador: ${v.warnAt} magnets
        </p>
        ${v.nota ? html`
          <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
            ${v.nota}
          </p>
        ` : null}
      </${Card}>

      <${Card} title="Composição de Magnets">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--green);">Prontos (disponíveis)</span>
            <strong style="font-family: var(--font-mono);">${v.ready}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--amber);">Baixando / Ativos</span>
            <strong style="font-family: var(--font-mono);">${v.downloading}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--red);">Terminais / Mortos</span>
            <strong style="font-family: var(--font-mono);">${v.dead}</strong>
          </div>
        </div>
      </${Card}>

      <${Card} title="Idade do Acervo">
        <div class="painel-stat-group">
          <span class="painel-stat-target">Magnet mais antigo há:</span>
          <strong style="font-family: var(--font-mono); color: var(--text);">${oldestAge}</strong>
        </div>
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          A idade acima é do registro mais antigo da conta — prontos incluídos. Não indica, por si só, download preso.
        </p>
      </${Card}>
    </div>
  `;
}
