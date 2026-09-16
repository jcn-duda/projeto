import { html } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { formatDurationMs } from './fmt.js';

export interface ViewSaudeProps {
  general?: Record<string, any>;
  debrid?: Record<string, any>;
  conta?: Record<string, any>;
  searchFirst?: Record<string, any>;
}

export function ViewSaude({ general, debrid, conta, searchFirst }: ViewSaudeProps) {
  const isOk = general?.ok && (conta?.ok || debrid?.account?.ok);
  const verdictVariant = isOk ? 'ok' : 'err';
  const verdictText = isOk ? 'SISTEMA OPERACIONAL' : 'ATENÇÃO REQUERIDA';

  const services = general?.services || {};
  const uptime = general?.uptimeS != null ? formatDurationMs(general.uptimeS * 1000) : '—';

  return html`
    <div class="painel-grid">
      <${Card}
        title="Veredito do Sistema"
        badge=${{ text: verdictText, variant: verdictVariant }}
      >
        <div class="painel-stat-group">
          <span class="painel-stat-num">${isOk ? 'Tudo certo' : 'Verifique alertas'}</span>
        </div>
        <p style="color: var(--muted); margin: 0;">Uptime do processo: ${uptime}</p>
      </${Card}>

      <${Card} title="Serviços Essenciais">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Adom Addon</span>
            <span class="painel-badge painel-badge-ok">ONLINE</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Jackett</span>
            <span class=${'painel-badge ' + (services.jackett === true ? 'painel-badge-ok' : services.jackett === 'naomedido' ? 'painel-badge-neutral' : 'painel-badge-err')}>
              ${services.jackett === true ? 'ONLINE' : services.jackett === 'naomedido' ? 'NÃO MEDIDO' : 'OFFLINE'}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Debrid (${debrid?.active || conta?.service || '—'})</span>
            <span class=${'painel-badge ' + (conta?.ok || debrid?.account?.ok ? 'painel-badge-ok' : 'painel-badge-err')}>
              ${conta?.ok || debrid?.account?.ok ? 'CONECTADO' : 'DESCONECTADO'}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Resolvers BR Embutidos</span>
            <span class="painel-badge painel-badge-ok">${services.resolvers || 0} ATIVOS</span>
          </div>
        </div>
      </${Card}>

      <${Card} title="Primeira Resposta (I0)">
        <${StatNumber}
          value=${searchFirst?.brVisible ?? 0}
          target=${searchFirst?.responses ?? 0}
          label="BR entregues no cold"
        />
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          BR encontrado: ${searchFirst?.brFound ?? 0} · Em cache: ${searchFirst?.brCached ?? 0}
        </p>
      </${Card}>
    </div>
  `;
}
