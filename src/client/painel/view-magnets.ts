import { html, useState } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { postAction } from './api.js';
import { getPainelState } from './store.js';
import { pollOnce } from './poll.js';
import { formatAgeFromTimestamp } from './fmt.js';

export interface ViewMagnetsProps {
  magnetdb?: Record<string, any>;
}

export function ViewMagnets({ magnetdb }: ViewMagnetsProps) {
  const m = magnetdb || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [inspectHash, setInspectHash] = useState('');
  const [inspectResult, setInspectResult] = useState<Record<string, any> | null>(null);

  const totalEntries = Number(m.entries || 0);
  const activeEntries = Number(m.active || 0);
  const badEntries = Number(m.bad || 0);

  const handleClearBad = async () => {
    if (!window.confirm('Limpar e desbloquear todos os registros marcados como "bad" no banco de magnets?')) return;
    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'magnet-clear-bad', { confirm: true });
      if (res.ok) {
        setFeedback({ text: `Bad magnets limpos com sucesso (${res.data.cleared ?? res.data.removed ?? 0} removidos)`, ok: true });
        await pollOnce(['magnetdb']);
      } else {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleInspect = async () => {
    const hash = inspectHash.trim().toLowerCase();
    if (!hash || hash.length !== 40) {
      setFeedback({ text: 'Informe um infoHash válido de 40 caracteres hexadecimais', ok: false });
      return;
    }

    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'magnet-inspect', { hash });
      if (res.ok) {
        setInspectResult(res.data);
        setFeedback({ text: `Inspeção concluída: ${res.data.items?.length || 0} registro(s) encontrado(s)`, ok: true });
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
        <${Card} title="Banco de Magnets (L1/L2)">
          <${StatNumber} value=${totalEntries} label="registros totais" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Persistência: ${m.persistent ? 'Ativa' : 'Memória apenas'}
          </p>
        </${Card}>

        <${Card} title="Composição do Banco">
          <div style="display: flex; flex-direction: column; gap: var(--space-2);">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--green);">Ativos / Conhecidos</span>
              <span style="font-weight: 600;">${activeEntries}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--red);">Bloqueados (Bad)</span>
              <span style="font-weight: 600;">${badEntries}</span>
            </div>
          </div>
        </${Card}>

        <${Card} title="Desbloqueio de Bad Magnets">
          <p style="color: var(--muted); font-size: var(--font-floor); margin-bottom: var(--space-3);">
            Remove marcas de erro para permitir novas tentativas de download.
          </p>
          <button
            class="painel-btn painel-btn-danger"
            disabled=${loading || badEntries === 0}
            onClick=${handleClearBad}
          >
            Limpar Bad Magnets (${badEntries})
          </button>
        </${Card}>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Inspecionar Hash Específico">
          <div style="display: flex; gap: var(--space-2); align-items: center;">
            <input
              type="text"
              class="painel-token-input"
              placeholder="Hash de 40 caracteres hex..."
              value=${inspectHash}
              onInput=${(e: any) => setInspectHash(e.target.value)}
            />
            <button
              class="painel-btn"
              disabled=${loading || inspectHash.trim().length !== 40}
              onClick=${handleInspect}
            >
              Inspecionar Hash
            </button>
          </div>

          ${inspectResult ? html`
            <div style="margin-top: var(--space-3);">
              ${(inspectResult.items || []).length === 0 ? html`
                <p style="color: var(--muted); font-size: var(--font-floor);">Nenhum registro encontrado para este hash.</p>
              ` : html`
                <table class="painel-table">
                  <thead>
                    <tr>
                      <th>Adapter</th>
                      <th>Lado</th>
                      <th>Estado</th>
                      <th>TTL Restante</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${inspectResult.items.map((it: any) => html`
                      <tr>
                        <td>${it.adapterId}</td>
                        <td><span class="painel-badge painel-badge-neutral">${it.side}</span></td>
                        <td>
                          <span class="painel-badge ${it.bad ? 'painel-badge-err' : 'painel-badge-ok'}">
                            ${it.bad ? 'bad' : 'ok'}
                          </span>
                        </td>
                        <td>${it.ttlRemainingSeconds != null ? formatAgeFromTimestamp(Date.now() + it.ttlRemainingSeconds * 1000) : it.ttlRemainingMs != null ? formatAgeFromTimestamp(Date.now() + it.ttlRemainingMs) : '—'}</td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              `}
            </div>
          ` : null}
        </${Card}>
      </div>
    </div>
  `;
}
