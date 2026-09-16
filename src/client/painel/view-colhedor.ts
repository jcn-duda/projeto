import { html, useState } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { postAction } from './api.js';
import { getPainelState } from './store.js';
import { pollOnce } from './poll.js';

export interface ViewColhedorProps {
  harvest?: Record<string, any>;
  metrics?: Record<string, any>;
}

export function ViewColhedor({ harvest, metrics }: ViewColhedorProps) {
  const h = harvest || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);

  const paused = Boolean(h.paused);
  const queueDepth = Number(h.queueDepth || 0);
  const queueMax = Number(h.queueMax || 100);
  const queriesThisHour = Number(h.queriesThisHour || 0);
  const maxPerHour = Number(h.maxPerHour || 20);
  const harvested = Number(h.harvested || 0);

  const preview = Array.isArray(h.queuePreview) ? h.queuePreview : [];
  const lastWorks = Array.isArray(h.lastWorks) ? h.lastWorks : [];

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
        await pollOnce(['harvest', 'metrics']);
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
          title="Estado do Colhedor"
          badge=${{
            text: paused ? 'PAUSADO' : h.enabled ? 'ATIVO' : 'DESLIGADO',
            variant: paused ? 'warn' : h.enabled ? 'ok' : 'neutral',
          }}
        >
          <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2);">
            <button
              class="painel-btn ${paused ? 'painel-btn-accent' : 'painel-btn-danger'}"
              disabled=${loading}
              onClick=${() => handleAction('harvester-pause', { paused: !paused })}
            >
              ${paused ? 'Retomar Colhedor' : 'Pausar Colhedor'}
            </button>
            <button
              class="painel-btn"
              disabled=${loading || queueDepth === 0}
              onClick=${() => handleAction('harvester-drain', { confirm: true }, 'Drenar e processar a fila imediatamente?')}
            >
              Drenar Fila Agora
            </button>
            <button
              class="painel-btn painel-btn-danger"
              disabled=${loading || queueDepth === 0}
              onClick=${() => handleAction('harvester-clear-queue', { confirm: true }, 'Limpar todas as obras enfileiradas?')}
            >
              Limpar Fila
            </button>
          </div>
        </${Card}>

        <${Card} title="Fila de Obras">
          <${StatNumber} value=${queueDepth} target=${queueMax} label="em espera" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Última colheita: ${h.lastRunAt ? new Date(h.lastRunAt).toLocaleTimeString() : '—'}
          </p>
        </${Card}>

        <${Card} title="Vazão Horária (Jackett)">
          <${StatNumber} value=${queriesThisHour} target=${maxPerHour} label="consultas / h" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Total colhido no processo: ${harvested} obras
          </p>
        </${Card}>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Prévia da Fila (Priorizada)">
          ${preview.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma obra na fila.</p>
          ` : html`
            <table class="painel-table">
              <thead>
                <tr>
                  <th>Obra (IMDb)</th>
                  <th>Tipo</th>
                  <th>Motivo</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                ${preview.map((item: any) => html`
                  <tr>
                    <td>${item.imdbId}${item.season ? ` S${String(item.season).padStart(2, '0')}` : ''}${item.episode ? `E${String(item.episode).padStart(2, '0')}` : ''}</td>
                    <td>${item.type}</td>
                    <td><span class="painel-badge painel-badge-neutral">${item.reason}</span></td>
                    <td>
                      ${item.brProbe ? html`<span class="painel-badge painel-badge-ok">sonda</span> ` : null}
                      ${item.resumed ? html`<span class="painel-badge painel-badge-warn">preempção</span>` : null}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </${Card}>

        <${Card} title="Últimas Obras Processadas">
          ${lastWorks.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma obra recente registrada.</p>
          ` : html`
            <table class="painel-table">
              <thead>
                <tr>
                  <th>Horário</th>
                  <th>Obra</th>
                  <th>Releases Gravadas</th>
                </tr>
              </thead>
              <tbody>
                ${lastWorks.map((work: any) => html`
                  <tr>
                    <td>${new Date(work.at).toLocaleTimeString()}</td>
                    <td>${work.imdbId}${work.season ? ` S${String(work.season).padStart(2, '0')}` : ''}${work.episode ? `E${String(work.episode).padStart(2, '0')}` : ''}</td>
                    <td>${work.recorded}</td>
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
