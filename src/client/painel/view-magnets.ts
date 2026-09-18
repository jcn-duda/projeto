import { html, useState } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { useAction, actionError } from './action.js';
import { formatDurationMs } from './fmt.js';

export interface ViewMagnetsProps {
  magnetdb?: Record<string, any>;
}

// Lado do banco → rótulo/cor do badge. O side é o que diz o ESTADO do registro
// (`alive` confirmado, `bad` sem vídeo, `lie` tocou mas mentiu o áudio).
const SIDE_STYLE: Record<string, { label: string; badge: string }> = {
  alive: { label: 'vivo', badge: 'painel-badge-ok' },
  bad: { label: 'bad', badge: 'painel-badge-err' },
  lie: { label: 'mentiu', badge: 'painel-badge-warn' },
};

export function sideStyle(side: unknown): { label: string; badge: string } {
  const key = String(side || '');
  return SIDE_STYLE[key] || { label: key || '—', badge: 'painel-badge-neutral' };
}

/** TTL restante vem em SEGUNDOS do `/dashboard-action.json` (magnet-inspect):
 * renderiza duração direta — montar um timestamp futuro e medir a idade
 * invertia o sinal e saía sempre 0. */
export function formatTtlRemaining(ttlRemainingSeconds: unknown): string {
  return typeof ttlRemainingSeconds === 'number' && Number.isFinite(ttlRemainingSeconds)
    ? formatDurationMs(ttlRemainingSeconds * 1000)
    : '—';
}

export interface MagnetdbSummary {
  enabled: boolean;
  l1Entries: number;
  l1Max: number;
  sizeAlive: number;
  sizeBad: number;
  sizeLie: number;
  evictedQuota: number;
}

/** Contrato real de `magnetdb.status()`: enabled/sizeAlive/sizeBad/sizeLie/
 * l1Entries/l1Max. Os antigos entries/active/bad/persistent não existem no
 * payload e renderizavam sempre 0/"memória apenas". */
export function magnetdbSummary(m: Record<string, any> | null | undefined): MagnetdbSummary {
  const x = m || {};
  return {
    enabled: Boolean(x.enabled),
    l1Entries: Number(x.l1Entries || 0),
    l1Max: Number(x.l1Max || 0),
    sizeAlive: Number(x.sizeAlive || 0),
    sizeBad: Number(x.sizeBad || 0),
    sizeLie: Number(x.sizeLie || 0),
    evictedQuota: Number(x.evictedQuota || 0),
  };
}

export function ViewMagnets({ magnetdb }: ViewMagnetsProps) {
  const m = magnetdb || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const { pending, run } = useAction();
  const [inspectHash, setInspectHash] = useState('');
  const [inspectResult, setInspectResult] = useState<Record<string, any> | null>(null);

  const { enabled, l1Entries, l1Max, sizeAlive, sizeBad, sizeLie, evictedQuota } = magnetdbSummary(m);

  const handleClearBad = async () => {
    const outcome = await run({
      action: 'magnet-clear-bad',
      confirm: {
        message: 'Limpar e desbloquear todos os registros marcados como "bad" no banco de magnets?',
        danger: true,
        confirmLabel: 'Limpar bad',
      },
      poll: ['magnetdb'],
      successToast: (data) => {
        const cleared = Number(data.cleared || 0);
        const remaining = Number(data.remaining || 0);
        return `Bad magnets limpos: ${cleared} registro(s)${
          remaining ? ` · ${remaining} restante(s) para a próxima passagem` : ''
        }`;
      },
    });
    // O erro fica no card (feedback inline); o sucesso sai como toast global.
    const error = actionError(outcome);
    setFeedback(error ? { text: `Falha: ${error}`, ok: false } : null);
  };

  const handleInspect = async () => {
    const hash = inspectHash.trim().toLowerCase();
    if (!hash || hash.length !== 40) {
      setFeedback({ text: 'Informe um infoHash válido de 40 caracteres hexadecimais', ok: false });
      return;
    }

    const outcome = await run({ action: 'magnet-inspect', body: { hash } });
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
      return;
    }
    setInspectResult(outcome.data);
    setFeedback({ text: `Inspeção concluída: ${outcome.data.items?.length || 0} registro(s) encontrado(s)`, ok: true });
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
          title="Banco de Magnets (L1/L2)"
          badge=${{ text: enabled ? 'ATIVO' : 'DESLIGADO', variant: enabled ? 'ok' : 'neutral' }}
        >
          <${StatNumber} value=${l1Entries} target=${l1Max} label="chaves no L1" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Cota girada (despejos): ${evictedQuota}
          </p>
        </${Card}>

        <${Card} title="Composição do Banco">
          <div style="display: flex; flex-direction: column; gap: var(--space-2);">
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--green);">Vivos (alive)</span>
              <span style="font-weight: 600;">${sizeAlive}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--red);">Bloqueados (bad)</span>
              <span style="font-weight: 600;">${sizeBad}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--amber);">Mentiu o áudio (lie)</span>
              <span style="font-weight: 600;">${sizeLie}</span>
            </div>
          </div>
        </${Card}>

        <${Card} title="Desbloqueio de Bad Magnets">
          <p style="color: var(--muted); font-size: var(--font-floor); margin-bottom: var(--space-3);">
            Remove marcas de erro para permitir novas tentativas de download.
          </p>
          <button
            class="painel-btn painel-btn-danger"
            disabled=${pending || sizeBad === 0}
            onClick=${handleClearBad}
          >
            Limpar Bad Magnets (${sizeBad})
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
              disabled=${pending || inspectHash.trim().length !== 40}
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
                      <th>Hash</th>
                      <th>Lado</th>
                      <th>Estado</th>
                      <th>TTL Restante</th>
                      <th>Magnet URI</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${inspectResult.items.map((it: any) => {
                      const style = sideStyle(it.side);
                      const magnetTrunc = it.magnet ? (it.magnet.length > 60 ? it.magnet.slice(0, 57) + '...' : it.magnet) : '—';
                      return html`
                        <tr>
                          <td>${it.adapterId}</td>
                          <td><code>${it.hash}</code></td>
                          <td><span class="painel-badge painel-badge-neutral">${it.side}</span></td>
                          <td><span class=${'painel-badge ' + style.badge}>${style.label}</span></td>
                          <td>${formatTtlRemaining(it.ttlRemainingSeconds)}</td>
                          <td>
                            ${it.magnet ? html`
                              <code title=${it.magnet} style="cursor: help; font-size: 0.85em;">${magnetTrunc}</code>
                              <button
                                class="painel-btn painel-btn-small"
                                style="margin-left: 4px; padding: 2px 6px; font-size: 0.75em;"
                                onClick=${() => navigator.clipboard?.writeText(it.magnet || '')}
                              >Copiar</button>
                            ` : '—'}
                          </td>
                        </tr>
                      `;
                    })}
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
