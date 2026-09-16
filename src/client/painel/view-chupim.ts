import { html, useState } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { postAction } from './api.js';
import { getPainelState } from './store.js';
import { pollOnce } from './poll.js';
import { formatAgeFromTimestamp } from './fmt.js';

export interface ViewChupimProps {
  autofetch?: Record<string, any>;
  metrics?: Record<string, any>;
}

export function ViewChupim({ autofetch, metrics }: ViewChupimProps) {
  const af = autofetch || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const paused = Boolean(af.paused);
  const recheckLots = Number(af.recheckLots || 0);
  const settleLots = Number(af.settleLots || 0);
  const deadBlacklist = Number(af.deadBlacklistCount || 0);
  const suppressed = Number(af.suppressed || 0);

  const obras = Array.isArray(af.obras) ? af.obras : [];
  const lastSkips = Array.isArray(af.lastSkips) ? af.lastSkips : [];

  const handleAction = async (action: string, bodyData: Record<string, any> = {}, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, action, bodyData);
      if (res.ok) {
        setFeedback({ text: 'Ação executada com sucesso', ok: true });
        await pollOnce(['autofetch', 'metrics']);
      } else {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
      }
    } finally {
      setLoading(false);
    }
  };

  return html`
    <div>
      ${feedback ? html`
        <div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}">
          ${feedback.text}
        </div>
      ` : null}

      <div class="painel-grid">
        <${Card}
          title="Estado do Chupim (Autofetch)"
          badge=${{
            text: paused ? 'PAUSADO' : 'ATIVO',
            variant: paused ? 'warn' : 'ok',
          }}
        >
          <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2);">
            <button
              class="painel-btn ${paused ? 'painel-btn-accent' : 'painel-btn-danger'}"
              disabled=${loading}
              onClick=${() => handleAction('autofetch-pause', { paused: !paused })}
            >
              ${paused ? 'Retomar Chupim' : 'Pausar Chupim'}
            </button>
            <button
              class="painel-btn"
              disabled=${loading || recheckLots === 0}
              onClick=${() => handleAction('autofetch-drain', { confirm: true }, 'Drenar lotes de recheck agora?')}
            >
              Drenar Rechecks
            </button>
            <button
              class="painel-btn"
              disabled=${loading || suppressed === 0}
              onClick=${() => handleAction('autofetch-suppressed-drain', { confirm: true }, 'Drenar remoções represadas?')}
            >
              Drenar Represadas (${suppressed})
            </button>
          </div>
        </${Card}>

        <${Card} title="Lotes e Ocupação">
          <${StatNumber} value=${recheckLots} label="lotes em voo" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Settle (espera): ${settleLots} · Mortos (blacklist): ${deadBlacklist}
          </p>
        </${Card}>

        <${Card} title="Orçamento Horário">
          <${StatNumber} value=${af.budget?.used ?? 0} target=${af.budget?.limit ?? 15} label="downloads / h" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Teto por busca: ${af.effective?.autoFetchMax ?? 2}
          </p>
        </${Card}>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Teto por Obra (Ativas no Cache)">
          ${obras.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma obra com download registrado na janela.</p>
          ` : html`
            <table class="painel-table">
              <thead>
                <tr>
                  <th>Digest</th>
                  <th>Pool BR</th>
                  <th>Pool Any</th>
                  <th>Pool Seeds</th>
                  <th>BR Pronto</th>
                  <th>Idade</th>
                </tr>
              </thead>
              <tbody>
                ${obras.map((o: any) => html`
                  <tr>
                    <td><code>${o.digest}</code></td>
                    <td>${o.pools?.br ?? 0}</td>
                    <td>${o.pools?.any ?? 0}</td>
                    <td>${o.pools?.seeds ?? 0}</td>
                    <td>
                      ${o.brReady ? html`<span class="painel-badge painel-badge-ok">⚡ pronto</span>` : html`<span style="color: var(--muted);">não</span>`}
                    </td>
                    <td>${formatAgeFromTimestamp(Date.now() - (o.ageMs || 0))}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </${Card}>

        <${Card} title="Últimos Skips / Desistências">
          ${lastSkips.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhum skip registrado.</p>
          ` : html`
            <table class="painel-table">
              <thead>
                <tr>
                  <th>Motivo</th>
                  <th>Rótulo / Detalhe</th>
                  <th>Horário</th>
                </tr>
              </thead>
              <tbody>
                ${lastSkips.map((sk: any) => html`
                  <tr>
                    <td><span class="painel-badge painel-badge-neutral">${sk.reason}</span></td>
                    <td>${sk.label || '—'}</td>
                    <td>${sk.at ? new Date(sk.at).toLocaleTimeString() : '—'}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </${Card}>
      </div>
    </div>
  `;
}
